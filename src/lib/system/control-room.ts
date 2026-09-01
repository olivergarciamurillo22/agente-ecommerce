// ============================================================
// CONTROL ROOM — el payload de la Home (§19).
//
// Pedro entra y en 5 segundos sabe: qué ha pasado HOY, qué requiere su
// atención y si el flujo (Shopify → WhatsApp → Beeping → Ads → Retell)
// está vivo. Nada de métricas de ingeniería aquí: eso vive en Ajustes.
//
// READ-ONLY y barato: consultas dirigidas, no el overview completo.
// ============================================================

import { systemDbHandle } from "../db";
import { startOfBusinessDay } from "../time";
import { getActionCenter } from "./action-center";
import { getBeepingHealth } from "../beeping/health";
import { beepingCutoff, type BeepingCutoffInfo } from "../beeping/cutoff";
import { getMetaAdsHealth } from "../meta-ads/health";
import { getEconomicsWindowRange } from "./unit-economics";
import { getCallsHealth, getDropeaHealth, getShopifyHealth, getWhatsAppHealth } from "./health-integrations";
import { codDefaults, cpaAuto, deliveryRateAuto, listCodProducts, shippingRateAuto, COD_MIN_SAMPLE } from "../cod-calculator/auto-inputs";
import { computeBreakEven } from "../cod-calculator/break-even";
import { evalDeliveryVsBreakEven, type BusinessAlert } from "./business-alerts";
import type { HealthStatus } from "./types";

export interface FlowNode {
  id: "shopify" | "whatsapp" | "beeping" | "dropea" | "meta_ads" | "calls";
  label: string;
  status: HealthStatus;
  message: string;
}

export interface ControlRoomToday {
  orders: number;
  confirmed: number;
  awaitingCustomer: number;
  needsCall: number;
  deliveredToday: number;
  grossRevenue: number;
  deliveredRevenue: number;
  estimatedMargin: number | null;
  marginMissing: string[];
  adSpend: number | null;
}

export interface AttentionItem {
  type: string;
  count: number;
  label: string;
  urgency: "urgent" | "today" | "later";
  /** Sección del dock a la que lleva el clic. */
  target: "actions" | "orders" | "shipments" | "settings";
}

/** El bloque del modelo COD en la Home (§35): números accionables. */
export interface ControlRoomCodModel {
  /** Margen estimado de la ventana de 30 días (%, sobre facturación). */
  marginPct: number | null;
  /** Break-even de entrega calculado desde costes reales/configurados (%). */
  breakEvenDeliveryPct: number | null;
  /** Tasa de entrega real de 30 días (%). */
  currentDeliveryPct: number | null;
  /** Colchón en puntos (actual − break-even). */
  cushionPts: number | null;
  /** Tamaño de muestra de la tasa real. */
  sample: number;
  /** Qué falta si no se puede calcular. */
  missingReason: string | null;
  /** La alerta §36 ya evaluada (warning <be+5, critical <=be). */
  alert: BusinessAlert;
}

export interface ControlRoom {
  generatedAt: number;
  today: ControlRoomToday;
  attention: AttentionItem[];
  attentionTotal: number;
  flow: FlowNode[];
  beepingCutoff: BeepingCutoffInfo;
  codModel: ControlRoomCodModel;
}

const ATTENTION_META: Record<string, { label: string; urgency: AttentionItem["urgency"]; target: AttentionItem["target"] }> = {
  CANCEL_REQUEST: { label: "cliente(s) piden cancelar", urgency: "urgent", target: "actions" },
  POSSIBLE_DUPLICATE: { label: "posible(s) duplicado(s)", urgency: "urgent", target: "actions" },
  TRACKING_INCIDENT: { label: "incidencia(s) de envío", urgency: "today", target: "actions" },
  SUPPLIER_ERROR: { label: "error(es) de proveedor", urgency: "today", target: "actions" },
  ADDRESS_CORRECTION: { label: "direccion(es) por revisar", urgency: "today", target: "actions" },
  NEEDS_CALL: { label: "pendiente(s) de llamada", urgency: "later", target: "actions" },
};

export function getControlRoom(nowMs = Date.now()): ControlRoom {
  const db = systemDbHandle();
  const inicioDia = startOfBusinessDay(nowMs);
  const ahora = Math.floor(nowMs / 1000);

  // --- HOY ---
  const hoy = db
    .prepare(
      `SELECT
         SUM(CASE WHEN COALESCE(ordered_at, created_at) >= ? THEN 1 ELSE 0 END) AS pedidos,
         SUM(CASE WHEN confirmed_at >= ? THEN 1 ELSE 0 END) AS confirmados,
         SUM(CASE WHEN status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction') AND closure_status = 'unknown' THEN 1 ELSE 0 END) AS esperando,
         SUM(CASE WHEN status = 'needs_call' AND closure_status = 'unknown' AND phone != '' THEN 1 ELSE 0 END) AS needs_call,
         SUM(CASE WHEN closure_status = 'delivered' AND closure_at >= ? THEN 1 ELSE 0 END) AS entregados
       FROM orders WHERE status != 'ignored_old'`
    )
    .get(inicioDia, inicioDia, inicioDia) as {
    pedidos: number | null;
    confirmados: number | null;
    esperando: number | null;
    needs_call: number | null;
    entregados: number | null;
  };

  const eco = getEconomicsWindowRange(inicioDia, ahora + 1);

  // --- ATENCIÓN ---
  const ac = getActionCenter();
  const attention: AttentionItem[] = [];
  for (const [type, count] of Object.entries(ac.counts)) {
    if (count > 0 && ATTENTION_META[type]) {
      attention.push({ type, count, ...ATTENTION_META[type] });
    }
  }
  const beeping = getBeepingHealth();
  if (beeping.awaitingRelease > 0) {
    attention.push({ type: "BEEPING_AWAITING_RELEASE", count: beeping.awaitingRelease, label: "confirmado(s) pendientes de enviar a Beeping", urgency: "today", target: "orders" });
  }
  if (beeping.ambiguousReleases > 0) {
    attention.push({ type: "BEEPING_AMBIGUOUS", count: beeping.ambiguousReleases, label: "liberación(es) a Beeping en estado ambiguo", urgency: "urgent", target: "shipments" });
  }
  const rank = { urgent: 0, today: 1, later: 2 } as const;
  attention.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.count - a.count);

  // --- FLUJO ---
  const shopify = getShopifyHealth();
  const whatsapp = getWhatsAppHealth();
  const dropea = getDropeaHealth();
  const metaAds = getMetaAdsHealth();
  const calls = getCallsHealth();
  const flow: FlowNode[] = [
    { id: "shopify", label: "Shopify", status: shopify.status, message: shopify.message },
    { id: "whatsapp", label: "WhatsApp", status: whatsapp.status, message: whatsapp.message },
    { id: "beeping", label: "Beeping", status: beeping.status, message: beeping.message },
    { id: "dropea", label: "Dropea", status: dropea.status, message: dropea.message },
    { id: "meta_ads", label: "Meta Ads", status: metaAds.status, message: metaAds.message },
    { id: "calls", label: "Llamadas", status: calls.status, message: calls.message },
  ];

  // --- MODELO COD (§35): margen, break-even y colchón, con datos reales ---
  const eco30 = getEconomicsWindowRange(ahora - 30 * 86400, ahora + 1);
  const entregaReal = deliveryRateAuto(30);
  const envioReal = shippingRateAuto(30);
  const cpaReal = cpaAuto(7);
  const productos = listCodProducts().filter((p) => p.salePrice !== null && p.productCost !== null);
  const defaults = codDefaults();

  let breakEvenPct: number | null = null;
  let missingReason: string | null = null;
  if (productos.length === 0) {
    missingReason = "sin producto con precio y coste configurados (Finanzas → Costes)";
  } else if (cpaReal.value === null) {
    missingReason = "sin CPA (conecta Meta Ads o introdúcelo en la calculadora)";
  } else {
    const p = productos[0];
    const be = computeBreakEven(
      "real",
      {
        salePrice: p.salePrice!,
        productCost: p.productCost!,
        vatRate: defaults.vatRate,
        rawCPA: cpaReal.value,
        shippingRate: envioReal.value ?? 0.9,
        deliveryRate: entregaReal.value ?? 0.7,
        outboundShippingCost: defaults.outboundShippingCost,
        codFee: defaults.codFee,
        returnCost: defaults.returnCost,
        otherCostPerOrder: defaults.otherCostPerOrder,
      },
      defaults.targetMargin
    );
    breakEvenPct = be.deliveryRateBreakEven !== null ? Math.round(be.deliveryRateBreakEven * 1000) / 10 : null;
    if (breakEvenPct === null) missingReason = "el break-even no existe con estos números (revisa la calculadora)";
  }
  const currentDeliveryPct = entregaReal.value !== null ? Math.round(entregaReal.value * 1000) / 10 : null;
  const codModel: ControlRoomCodModel = {
    marginPct: eco30.estimatedMarginPct,
    breakEvenDeliveryPct: breakEvenPct,
    currentDeliveryPct,
    cushionPts:
      currentDeliveryPct !== null && breakEvenPct !== null ? Math.round((currentDeliveryPct - breakEvenPct) * 10) / 10 : null,
    sample: entregaReal.sample ?? 0,
    missingReason,
    alert: evalDeliveryVsBreakEven(currentDeliveryPct, breakEvenPct, entregaReal.sample ?? 0, Math.min(10, COD_MIN_SAMPLE)),
  };

  return {
    generatedAt: ahora,
    today: {
      orders: hoy.pedidos ?? 0,
      confirmed: hoy.confirmados ?? 0,
      awaitingCustomer: hoy.esperando ?? 0,
      needsCall: hoy.needs_call ?? 0,
      deliveredToday: hoy.entregados ?? 0,
      grossRevenue: eco.grossRevenue,
      deliveredRevenue: eco.deliveredRevenue,
      estimatedMargin: eco.estimatedMargin,
      marginMissing: eco.missing,
      adSpend: eco.adSpend,
    },
    attention,
    attentionTotal: attention.reduce((a, b) => a + b.count, 0),
    flow,
    beepingCutoff: beepingCutoff(new Date(nowMs)),
    codModel,
  };
}
