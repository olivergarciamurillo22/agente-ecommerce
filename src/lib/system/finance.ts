// ============================================================
// FINANZAS — el agregador que alimenta la pantalla más clara del panel.
//
// Regla contable de Casamable (BUSINESS-METRICS.md, se respeta):
//   el cobro COD depende de ENTREGAR → el ingreso solo cuenta pedidos
//   entregados (closure_status='delivered', dato REAL, nunca una tasa
//   supuesta cuando hay dato); el coste de producto/envío/manipulación se
//   asume al ENVIAR, se entregue o no. Por eso ROAS BRUTO (facturación
//   enviada / ads) y ROAS NETO (facturación entregada / ads) son cosas
//   distintas y se enseñan las dos.
//
// READ-ONLY: este módulo no escribe nada.
// ============================================================

import { systemDbHandle } from "../db";
import { lineItemsFromPayload } from "../orders/line-items";
import { businessDay, startOfBusinessDay } from "../time";
import { getClosureBreakdown, type ClosureBreakdown } from "./delivery-metrics";
import { measure, type Measured } from "./metric-result";
import { getEconomicsWindowRange, type EconomicsWindow } from "./unit-economics";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;

export type FinancePreset = "today" | "7d" | "30d" | "month" | "custom";

export interface FinanceRange {
  preset: FinancePreset;
  from: number;
  to: number;
}

/** Resuelve un preset a una ventana [from, to) en segundos. */
export function resolveFinanceRange(preset: FinancePreset, nowMs = Date.now(), custom?: { from: number; to: number }): FinanceRange {
  const now = Math.floor(nowMs / 1000);
  const fin = now + 1;
  switch (preset) {
    case "today":
      return { preset, from: startOfBusinessDay(nowMs), to: fin };
    case "7d":
      return { preset, from: now - 7 * 86400, to: fin };
    case "30d":
      return { preset, from: now - 30 * 86400, to: fin };
    case "month": {
      // Primer día del mes de NEGOCIO (Madrid).
      const [y, m] = businessDay(nowMs).split("-").map(Number);
      const inicio = Math.floor(Date.UTC(y, m - 1, 1) / 1000) - 2 * 3600; // margen huso
      return { preset, from: inicio, to: fin };
    }
    case "custom": {
      const from = custom?.from ?? now - 7 * 86400;
      const to = Math.min(custom?.to ?? fin, fin);
      // Tope de 92 días: la serie diaria se calcula por día.
      return { preset, from: Math.max(from, to - 92 * 86400), to };
    }
  }
}

export interface FinanceDayPoint {
  day: string;
  deliveredRevenue: number;
  grossRevenue: number;
  adSpend: number | null;
  margin: number | null;
  delivered: number;
  refused: number;
  deliveryRate: number | null;
}

export interface ProductPerformanceRow {
  sku: string;
  title: string;
  shipped: number;
  delivered: number;
  refused: number;
  deliveryRate: number | null;
  deliveredRevenue: number;
}

export interface CourierPerformanceRow {
  carrier: string;
  shipped: number;
  delivered: number;
  refused: number;
  returned: number;
  deliveryRate: number | null;
}

export interface FinanceOverview {
  generatedAt: number;
  range: FinanceRange;
  window: EconomicsWindow;
  closure: ClosureBreakdown;
  /** Coste total asumido por pedido enviado / por entregado. null si faltan costes. */
  costPerShipped: number | null;
  costPerDelivered: number | null;
  series: FinanceDayPoint[];
  products: ProductPerformanceRow[];
  couriers: CourierPerformanceRow[];
  /** Días de la ventana con gasto por fuente (para el aviso de §39). */
  adSpendSources: { meta: number; manual: number; without: number };
}

interface ShippedClosureRow {
  id: number;
  closure: string;
  carrier: string | null;
  total_price: string;
  raw_payload: string | null;
  product_summary: string;
}

const SHIPPED_STATES = ["shipped", "in_transit", "out_for_delivery", "delivery_attempted", "at_pickup_point", "delivered", "returned"];

function shippedWithClosure(fromS: number, toS: number): ShippedClosureRow[] {
  const ph = SHIPPED_STATES.map(() => "?").join(",");
  return systemDbHandle()
    .prepare(
      `SELECT o.id, o.closure_status AS closure, o.carrier, o.total_price, o.raw_payload, o.product_summary,
              o.supplier_status_normalized AS logistic
       FROM orders o
       JOIN (SELECT order_id, MIN(occurred_at) AS shipped_at FROM order_status_history
             WHERE new_status IN (${ph}) GROUP BY order_id) s ON s.order_id = o.id
       WHERE s.shipped_at >= ? AND s.shipped_at < ?`
    )
    .all(...SHIPPED_STATES, fromS, toS) as (ShippedClosureRow & { logistic: string })[];
}

function rate(delivered: number, refused: number): number | null {
  const resolved = delivered + refused;
  return resolved > 0 ? r1((delivered / resolved) * 100) : null;
}

export function getProductPerformance(fromS: number, toS: number): ProductPerformanceRow[] {
  const porSku = new Map<string, ProductPerformanceRow>();
  for (const row of shippedWithClosure(fromS, toS)) {
    let items: ReturnType<typeof lineItemsFromPayload> = [];
    try {
      items = row.raw_payload ? lineItemsFromPayload(JSON.parse(row.raw_payload)).filter((i) => !i.isService) : [];
    } catch {
      items = [];
    }
    const claves = items.length > 0 ? items.map((i) => ({ sku: i.sku ?? "(sin SKU)", title: i.title })) : [{ sku: "(sin líneas)", title: row.product_summary }];
    const total = parseFloat(row.total_price) || 0;
    for (const { sku, title } of claves) {
      const agg = porSku.get(sku) ?? { sku, title, shipped: 0, delivered: 0, refused: 0, deliveryRate: null, deliveredRevenue: 0 };
      agg.shipped++;
      if (row.closure === "delivered") {
        agg.delivered++;
        // El ingreso del pedido se atribuye una vez por SKU presente; con
        // pedidos monoproducto (el caso real) es exacto.
        agg.deliveredRevenue = r2(agg.deliveredRevenue + total / claves.length);
      }
      if (row.closure === "refused") agg.refused++;
      porSku.set(sku, agg);
    }
  }
  return [...porSku.values()]
    .map((p) => ({ ...p, deliveryRate: rate(p.delivered, p.refused) }))
    .sort((a, b) => b.shipped - a.shipped);
}

export function getCourierPerformance(fromS: number, toS: number): CourierPerformanceRow[] {
  const porCarrier = new Map<string, CourierPerformanceRow & { logisticReturned: number }>();
  for (const row of shippedWithClosure(fromS, toS) as (ShippedClosureRow & { logistic: string })[]) {
    const carrier = (row.carrier ?? "").trim() || "(sin transportista)";
    const agg = porCarrier.get(carrier) ?? {
      carrier,
      shipped: 0,
      delivered: 0,
      refused: 0,
      returned: 0,
      deliveryRate: null,
      logisticReturned: 0,
    };
    agg.shipped++;
    if (row.closure === "delivered") agg.delivered++;
    if (row.closure === "refused") agg.refused++;
    if (row.logistic === "returned") agg.returned++;
    porCarrier.set(carrier, agg);
  }
  return [...porCarrier.values()]
    .map(({ logisticReturned: _lr, ...p }) => ({ ...p, deliveryRate: rate(p.delivered, p.refused) }))
    .sort((a, b) => b.shipped - a.shipped);
}

/** Serie diaria (día de negocio Madrid) para las gráficas. */
export function getFinanceSeries(fromS: number, toS: number): FinanceDayPoint[] {
  const puntos: FinanceDayPoint[] = [];
  // Recorre por días de negocio: cada punto es una ventana [inicioDía, finDía).
  let cursor = startOfBusinessDay(fromS * 1000);
  let guard = 0;
  while (cursor < toS && guard++ < 95) {
    const finDia = Math.min(cursor + 86400 + 2 * 3600, toS); // margen DST
    const inicioSiguiente = startOfBusinessDay((cursor + 86400 + 12 * 3600) * 1000);
    const hasta = Math.min(inicioSiguiente > cursor ? inicioSiguiente : finDia, toS);
    const w = getEconomicsWindowRange(cursor, hasta);
    const c = getClosureBreakdown(cursor, hasta);
    puntos.push({
      day: businessDay(cursor * 1000 + 12 * 3600 * 1000),
      deliveredRevenue: w.deliveredRevenue,
      grossRevenue: w.grossRevenue,
      adSpend: w.adSpend,
      margin: w.estimatedMargin,
      delivered: c.delivered,
      refused: c.refused,
      deliveryRate: c.deliveryRate,
    });
    cursor = hasta;
  }
  return puntos;
}

export function getFinanceOverview(preset: FinancePreset, nowMs = Date.now(), custom?: { from: number; to: number }): FinanceOverview {
  const range = resolveFinanceRange(preset, nowMs, custom);
  const window = getEconomicsWindowRange(range.from, range.to);
  const closure = getClosureBreakdown(range.from, range.to);

  const costesCompletos = window.productCost != null && window.shippingCost != null && window.codFees != null && window.adSpend != null;
  const costeTotal = costesCompletos
    ? window.productCost! + window.shippingCost! + window.handlingCost + window.codFees! + window.adSpend!
    : null;

  // Fuente del gasto por día (aviso "manual vs API" de la pantalla).
  const fuentes = { meta: 0, manual: 0, without: 0 };
  try {
    const desde = businessDay(range.from * 1000);
    const hasta = businessDay(range.to * 1000);
    const filas = systemDbHandle()
      .prepare("SELECT day, source FROM daily_ad_spend WHERE day >= ? AND day <= ?")
      .all(desde, hasta) as Array<{ day: string; source: string }>;
    const dias = Math.max(1, Math.round((range.to - range.from) / 86400));
    for (const f of filas) {
      if (f.source === "meta_api") fuentes.meta++;
      else fuentes.manual++;
    }
    fuentes.without = Math.max(0, dias - filas.length);
  } catch {
    /* sin datos */
  }

  return {
    generatedAt: Math.floor(nowMs / 1000),
    range,
    window,
    closure,
    costPerShipped: costeTotal != null && window.shippedOrders > 0 ? r2(costeTotal / window.shippedOrders) : null,
    costPerDelivered: costeTotal != null && window.deliveredOrders > 0 ? r2(costeTotal / window.deliveredOrders) : null,
    series: getFinanceSeries(range.from, range.to),
    products: getProductPerformance(range.from, range.to),
    couriers: getCourierPerformance(range.from, range.to),
    adSpendSources: fuentes,
  };
}

export function getFinanceOverviewMeasured(preset: FinancePreset, nowMs = Date.now(), custom?: { from: number; to: number }): Measured<FinanceOverview> {
  return measure("finance-overview", () => getFinanceOverview(preset, nowMs, custom));
}
