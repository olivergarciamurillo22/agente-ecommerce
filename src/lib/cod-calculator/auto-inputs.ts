// ============================================================
// Auto-relleno de la Calculadora COD con datos REALES del sistema.
//
// Cada valor sale con su ORIGEN y su DENOMINADOR (§19-§21): la UI enseña
// "69,6% · 71 entregados / 102 cierres conocidos", nunca una cifra huérfana.
// Reglas:
//   · % entrega  → eje de CIERRE (delivered / (delivered+refused)), 30 días.
//     unknown/in_progress/cancelled NO entran (política existente).
//   · % envío    → enviados / creados elegibles, 30 días. Elegible =
//     no ignored_old, no cancelado, no TEST-. Sin inventar denominadores.
//   · CPA        → gasto Meta (nivel cuenta) / pedidos creados, rango elegido.
//   · costes     → product_costs (configurado) + defaults de settings.
// Sobrescribir cualquiera en la UI = badge SIMULACIÓN; nada se guarda solo.
// ============================================================

import { getSetting, listProductCosts, systemDbHandle } from "../db";
import { businessDay } from "../time";
import { getClosureBreakdown } from "../system/delivery-metrics";
import { listMetaAdsDaily } from "../meta-ads/repo";
import { metaAdsEnabled } from "../meta-ads/config";
import { lineItemsFromPayload } from "../orders/line-items";
import type { CODInputWithSource } from "./types";

/** Muestra mínima para considerar una tasa "suficiente" (§27). */
export const COD_MIN_SAMPLE = 30;

const SHIPPED_STATES = ["shipped", "in_transit", "out_for_delivery", "delivery_attempted", "at_pickup_point", "delivered", "returned"];

function settingNum(key: string, def: number): number {
  const v = parseFloat(getSetting(key) ?? "");
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/** Defaults de negocio (§49): settings con los valores del Excel de fallback. */
export function codDefaults(): {
  outboundShippingCost: number;
  codFee: number;
  returnCost: number;
  vatRate: number;
  targetMargin: number;
  otherCostPerOrder: number;
} {
  return {
    outboundShippingCost: settingNum("cod_calc_shipping_cost", 5.5),
    codFee: settingNum("cod_calc_cod_fee", 0.7),
    returnCost: settingNum("cod_calc_return_cost", 4.5),
    vatRate: settingNum("cod_calc_vat_rate", 0),
    targetMargin: settingNum("cod_calc_target_margin_pct", 10) / 100,
    otherCostPerOrder: settingNum("cod_calc_other_cost", 0),
  };
}

export function deliveryRateAuto(days = 30): CODInputWithSource {
  const now = Math.floor(Date.now() / 1000);
  const c = getClosureBreakdown(now - days * 86400, now + 1);
  if (c.resolved === 0) {
    return { value: null, source: "real", detail: `sin cierres conocidos en ${days} días`, sample: 0 };
  }
  return {
    value: (c.deliveryRate ?? 0) / 100,
    source: "real",
    detail: `${c.delivered} entregados / ${c.resolved} cierres conocidos (${days} días)`,
    sample: c.resolved,
  };
}

export function shippingRateAuto(days = 30): CODInputWithSource {
  const db = systemDbHandle();
  const desde = Math.floor(Date.now() / 1000) - days * 86400;
  const ph = SHIPPED_STATES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS creados,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM order_status_history h
                WHERE h.order_id = o.id AND h.new_status IN (${ph})
              ) THEN 1 ELSE 0 END) AS enviados
       FROM orders o
       WHERE COALESCE(o.ordered_at, o.created_at) >= ?
         AND o.status NOT IN ('ignored_old', 'cancelled')
         AND o.closure_status != 'cancelled'
         AND o.shopify_order_id NOT LIKE 'TEST-%'`
    )
    .get(...SHIPPED_STATES, desde) as { creados: number; enviados: number | null };
  if (!row.creados) {
    return { value: null, source: "real", detail: `sin pedidos elegibles en ${days} días`, sample: 0 };
  }
  return {
    value: (row.enviados ?? 0) / row.creados,
    source: "real",
    detail: `${row.enviados ?? 0} enviados / ${row.creados} pedidos elegibles (${days} días)`,
    sample: row.creados,
  };
}

export function cpaAuto(days = 7, campaignId?: string): CODInputWithSource {
  if (!metaAdsEnabled()) {
    return { value: null, source: "manual", detail: "Meta Ads sin conectar: introduce el CPA a mano", sample: null };
  }
  const now = Date.now();
  const toDay = businessDay(now);
  const fromDay = businessDay(now - (days - 1) * 86400 * 1000);
  const level = campaignId ? "campaign" : "account";
  const rows = listMetaAdsDaily({ fromDay, toDay, level }).filter((r) => !campaignId || r.entity_id === campaignId);
  const spend = rows.reduce((a, r) => a + (r.spend ?? 0), 0);
  const db = systemDbHandle();
  const desde = Math.floor(now / 1000) - days * 86400;
  const pedidos = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
         WHERE COALESCE(ordered_at, created_at) >= ? AND status != 'ignored_old' AND shopify_order_id NOT LIKE 'TEST-%'`
      )
      .get(desde) as { n: number }
  ).n;
  if (spend <= 0 || pedidos === 0) {
    return { value: null, source: "meta_ads", detail: `sin gasto o sin pedidos en ${days} días`, sample: pedidos };
  }
  return {
    value: Math.round((spend / pedidos) * 100) / 100,
    source: "meta_ads",
    detail: `${spend.toFixed(2)} € de gasto / ${pedidos} pedidos (${days} días${campaignId ? ", campaña" : ""})`,
    sample: pedidos,
  };
}

export interface CODProductOption {
  sku: string;
  title: string;
  salePrice: number | null;
  salePriceDetail: string | null;
  productCost: number | null;
  handlingCost: number | null;
}

/**
 * Productos reales para el selector (§17): coste de product_costs y precio
 * de venta observado en el pedido MÁS RECIENTE que contiene ese SKU.
 */
export function listCodProducts(): CODProductOption[] {
  const costs = listProductCosts();
  const db = systemDbHandle();
  const recientes = db
    .prepare("SELECT raw_payload FROM orders WHERE raw_payload IS NOT NULL ORDER BY COALESCE(ordered_at, created_at) DESC LIMIT 200")
    .all() as Array<{ raw_payload: string }>;

  const precioPorSku = new Map<string, number>();
  for (const r of recientes) {
    try {
      for (const it of lineItemsFromPayload(JSON.parse(r.raw_payload)).filter((i) => !i.isService)) {
        const sku = (it.sku ?? "").toLowerCase();
        const precio = it.price != null ? parseFloat(it.price) : NaN;
        if (sku && !precioPorSku.has(sku) && Number.isFinite(precio)) precioPorSku.set(sku, precio);
      }
    } catch {
      /* payload ilegible */
    }
  }

  return costs.map((c) => {
    const precio = precioPorSku.get(c.sku.toLowerCase()) ?? null;
    return {
      sku: c.sku,
      title: c.title ?? c.sku,
      salePrice: precio,
      salePriceDetail: precio !== null ? "precio del pedido más reciente con este SKU" : null,
      productCost: c.product_cost,
      handlingCost: c.handling_cost,
    };
  });
}

export interface CODAutoInputs {
  deliveryRate: CODInputWithSource;
  shippingRate: CODInputWithSource;
  cpa: CODInputWithSource;
  defaults: ReturnType<typeof codDefaults>;
  products: CODProductOption[];
  minSample: number;
}

export function getCodAutoInputs(opts: { cpaDays?: number; campaignId?: string } = {}): CODAutoInputs {
  return {
    deliveryRate: deliveryRateAuto(30),
    shippingRate: shippingRateAuto(30),
    cpa: cpaAuto(opts.cpaDays ?? 7, opts.campaignId),
    defaults: codDefaults(),
    products: listCodProducts(),
    minSample: COD_MIN_SAMPLE,
  };
}
