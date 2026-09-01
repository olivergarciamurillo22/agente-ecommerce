// ============================================================
// Unit economics BÁSICO. READ-ONLY sobre orders + history + product_costs +
// daily_ad_spend. NO INVENTA: cada cifra dice de dónde sale y, si falta un
// dato (coste de un SKU, gasto en ads), el resultado se marca "incompleto"
// con la lista exacta de lo que falta.
//
// Regla contable de Pedro (correcta, se respeta):
//   el cobro COD depende de que se ENTREGUE → los ingresos solo cuentan
//   sobre pedidos entregados; el coste de producto y de envío se asume al
//   ENVIAR, se entregue o no.
//
// Definiciones (docs/BUSINESS-METRICS.md):
//   grossRevenue      = Σ total de pedidos ENVIADOS en la ventana   (real)
//   deliveredRevenue  = Σ total de pedidos ENTREGADOS              (real)
//   productCost       = Σ product_cost(sku) × cantidad, enviados   (config)
//   shippingCost      = Σ shipping_cost(sku) × cantidad, enviados  (config)
//   codFees           = Σ cod_fee(sku) × cantidad, entregados      (config)
//   adSpend           = Σ daily_ad_spend en la ventana             (manual)
//   estimatedMargin   = deliveredRevenue − productCost − shippingCost − codFees − adSpend
//   grossRoas         = grossRevenue / adSpend
//   netRoas           = deliveredRevenue / adSpend
// ============================================================

import { listDailyAdSpend, listProductCosts, systemDbHandle, type ProductCostRow } from "../db";
import { measure, type Measured } from "./metric-result";
import { madridParts } from "../time";
import { lineItemsFromPayload } from "../orders/line-items";
import { startOfLocalDay } from "./delivery-metrics";

const SHIPPED_STATES = [
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivery_attempted",
  "at_pickup_point",
  "delivered",
  "returned",
];

export interface EconomicsWindow {
  from: number;
  to: number;
  shippedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  /** Reales (de `orders`). */
  grossRevenue: number;
  deliveredRevenue: number;
  /** Configurados (product_costs). null si falta algún SKU. */
  productCost: number | null;
  shippingCost: number | null;
  codFees: number | null;
  /** Manipulación del fulfillment (handling_cost). OPCIONAL: un SKU sin
   *  dato cuenta 0 y no marca la ventana incompleta — se configura cuando
   *  el fulfillment lo cobre (p.ej. Beeping). */
  handlingCost: number;
  /** Manual (daily_ad_spend). null si ningún día de la ventana tiene dato. */
  adSpend: number | null;
  /** Derivados; null si falta cualquier componente. */
  estimatedMargin: number | null;
  estimatedMarginPct: number | null;
  grossRoas: number | null;
  netRoas: number | null;
  complete: boolean;
  /** Qué falta para que salga completo. */
  missing: string[];
  currency: string;
}

export interface UnitEconomics {
  generatedAt: number;
  today: EconomicsWindow;
  last7d: EconomicsWindow;
  last30d: EconomicsWindow;
  /** Qué SKUs han aparecido en pedidos enviados (30 d) y no tienen coste. */
  skusWithoutCost: Array<{ sku: string; title: string }>;
  costsConfigured: number;
  adSpendDays: number;
}

interface Row {
  id: number;
  /** Eje LOGÍSTICO (supplier_status_normalized). Solo para contexto. */
  status: string;
  /** Eje de CIERRE (closure_status). Es el que decide el dinero. */
  closure: string;
  total_price: string;
  currency: string;
  raw_payload: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  // Día de NEGOCIO (Madrid), no del huso del proceso: si no, el gasto en ads
  // de la noche se imputaría al día siguiente.
  const p = madridParts(d);
  const m = String(p.month).padStart(2, "0");
  const day = String(p.day).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function computeEconomics(
  rows: Row[],
  costs: ProductCostRow[],
  adSpendByDay: Map<string, number>,
  from: number,
  to: number
): EconomicsWindow {
  const costBySku = new Map(costs.map((c) => [c.sku.toLowerCase(), c]));
  const missing = new Set<string>();
  let gross = 0;
  let delivered = 0;
  let product = 0;
  let shipping = 0;
  let cod = 0;
  let handling = 0;
  let productOk = true;
  let shippingOk = true;
  let codOk = true;
  let shippedOrders = 0;
  let deliveredOrders = 0;
  let returnedOrders = 0;
  let currency = "EUR";

  for (const r of rows) {
    shippedOrders++;
    currency = r.currency || currency;
    const total = parseFloat(r.total_price) || 0;
    gross += total;
    // DESENLACE ECONÓMICO: eje de CIERRE, no el logístico.
    //
    // `closure_status = 'delivered'` es entrega CONFIRMADA por una fuente
    // fiable; `'refused'` es el rehúse del COD, que es el evento que cuesta
    // dinero (~9,37 €). Antes esto se leía de `supplier_status_normalized`,
    // donde `returned` mezcla el rehúse del cliente con el paquete perdido o
    // roto — dos cosas con consecuencias económicas distintas.
    const entregado = r.closure === "delivered";
    if (entregado) {
      deliveredOrders++;
      delivered += total;
    }
    if (r.closure === "refused") returnedOrders++;

    let items: ReturnType<typeof lineItemsFromPayload> = [];
    try {
      items = r.raw_payload ? lineItemsFromPayload(JSON.parse(r.raw_payload)).filter((i) => !i.isService) : [];
    } catch {
      items = [];
    }
    if (items.length === 0) {
      missing.add("pedido sin líneas legibles (no se puede costear)");
      productOk = shippingOk = codOk = false;
      continue;
    }
    for (const it of items) {
      const c = it.sku ? costBySku.get(it.sku.toLowerCase()) : undefined;
      if (!c) {
        missing.add(`coste del SKU ${it.sku ?? `(sin SKU: ${it.title})`}`);
        productOk = shippingOk = codOk = false;
        continue;
      }
      if (c.product_cost == null) {
        productOk = false;
        missing.add(`coste de producto del SKU ${c.sku}`);
      } else product += c.product_cost * it.quantity;
      if (c.shipping_cost == null) {
        shippingOk = false;
        missing.add(`coste de envío del SKU ${c.sku}`);
      } else shipping += c.shipping_cost * it.quantity;
      // Manipulación: opcional (0 si no está configurada), asumida al enviar.
      if (c.handling_cost != null) handling += c.handling_cost * it.quantity;
      if (entregado) {
        if (c.cod_fee == null) {
          codOk = false;
          missing.add(`comisión COD del SKU ${c.sku}`);
        } else cod += c.cod_fee * it.quantity;
      }
    }
  }

  // Ads: suma de los días de la ventana con dato.
  let ads: number | null = null;
  let diasConDato = 0;
  for (let d = from; d < to; d += 86400) {
    const v = adSpendByDay.get(dayKey(d));
    if (v != null) {
      ads = (ads ?? 0) + v;
      diasConDato++;
    }
  }
  if (diasConDato === 0) missing.add("gasto en ads de la ventana (entrada manual)");

  const productCost = productOk ? r2(product) : null;
  const shippingCost = shippingOk ? r2(shipping) : null;
  const codFees = codOk ? r2(cod) : null;
  const handlingCost = r2(handling);
  const margin =
    productCost != null && shippingCost != null && codFees != null && ads != null
      ? r2(delivered - productCost - shippingCost - codFees - handlingCost - ads)
      : null;

  return {
    from,
    to,
    shippedOrders,
    deliveredOrders,
    returnedOrders,
    grossRevenue: r2(gross),
    deliveredRevenue: r2(delivered),
    productCost,
    shippingCost,
    codFees,
    handlingCost,
    adSpend: ads != null ? r2(ads) : null,
    estimatedMargin: margin,
    estimatedMarginPct: margin != null && gross > 0 ? r2((margin / gross) * 100) : null,
    grossRoas: ads != null && ads > 0 ? r2(gross / ads) : null,
    netRoas: ads != null && ads > 0 ? r2(delivered / ads) : null,
    complete: missing.size === 0 && shippedOrders > 0,
    missing: [...missing].sort(),
    currency,
  };
}

function shippedRows(from: number, to: number): Row[] {
  const ph = SHIPPED_STATES.map(() => "?").join(",");
  return systemDbHandle()
    .prepare(
      `SELECT o.id, o.supplier_status_normalized AS status,
              o.closure_status AS closure,
              o.total_price, o.currency, o.raw_payload
       FROM orders o
       JOIN (SELECT order_id, MIN(occurred_at) AS shipped_at FROM order_status_history
             WHERE new_status IN (${ph}) GROUP BY order_id) s ON s.order_id = o.id
       WHERE s.shipped_at >= ? AND s.shipped_at < ?`
    )
    .all(...SHIPPED_STATES, from, to) as Row[];
}

/**
 * Economía con estado de confianza. La que debe consumir el panel.
 *
 * Un fallo aquí no puede devolver 0 € de margen: sería indistinguible de un
 * mes que se fue a cero, y son cosas muy distintas.
 */
export function getUnitEconomicsMeasured(nowMs = Date.now()): Measured<UnitEconomics> {
  return measure("unit-economics", () => getUnitEconomics(nowMs));
}

/**
 * Ventana económica ARBITRARIA [fromS, toS) — la base de Finanzas
 * (Hoy / 7d / 30d / Mes / Personalizado). Misma regla contable.
 */
export function getEconomicsWindowRange(fromS: number, toS: number): EconomicsWindow {
  const costs = listProductCosts();
  const adRows = listDailyAdSpend(dayKey(fromS - 86400), dayKey(toS));
  const adsByDay = new Map(adRows.map((r) => [r.day, r.amount]));
  return computeEconomics(shippedRows(fromS, toS), costs, adsByDay, fromS, toS);
}

export function getUnitEconomics(nowMs = Date.now()): UnitEconomics {
  const now = Math.floor(nowMs / 1000);
  const fin = now + 1;
  const costs = listProductCosts();
  const adRows = listDailyAdSpend(dayKey(now - 31 * 86400), dayKey(now));
  const adsByDay = new Map(adRows.map((r) => [r.day, r.amount]));

  const ventana = (from: number) => computeEconomics(shippedRows(from, fin), costs, adsByDay, from, fin);
  const last30 = ventana(now - 30 * 86400);

  // SKUs vistos en 30 d sin coste configurado (para que el panel pida justo eso).
  const vistos = new Map<string, string>();
  for (const r of shippedRows(now - 30 * 86400, fin)) {
    try {
      for (const it of lineItemsFromPayload(JSON.parse(r.raw_payload ?? "null")).filter((i) => !i.isService)) {
        if (it.sku && !costs.some((c) => c.sku.toLowerCase() === it.sku!.toLowerCase())) vistos.set(it.sku, it.title);
      }
    } catch {
      /* sin payload */
    }
  }

  return {
    generatedAt: now,
    today: ventana(startOfLocalDay(nowMs)),
    last7d: ventana(now - 7 * 86400),
    last30d: last30,
    skusWithoutCost: [...vistos].map(([sku, title]) => ({ sku, title })),
    costsConfigured: costs.length,
    adSpendDays: adRows.length,
  };
}
