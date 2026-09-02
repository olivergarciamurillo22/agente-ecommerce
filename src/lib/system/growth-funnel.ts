// Growth funnel — solo hechos observados en la DB local. Los cuatro pasos
// previos al pedido siguen explícitamente ausentes hasta integrar Web Pixels.
import { systemDbHandle } from "../db";
import { startOfBusinessDay } from "../time";

export interface GrowthFunnelStep {
  id: string;
  label: string;
  source: string;
  value: number | null;
  available: boolean;
}

export interface GrowthFunnelSnapshot {
  from: number;
  to: number;
  period: "30d";
  steps: GrowthFunnelStep[];
  missingIntegrations: string[];
}

export function getGrowthFunnel(nowMs = Date.now()): GrowthFunnelSnapshot {
  const to = Math.floor(nowMs / 1000) + 1;
  const from = startOfBusinessDay(nowMs - 29 * 86400 * 1000);
  const row = systemDbHandle().prepare(
    `SELECT
       COUNT(*) AS orders_created,
       SUM(CASE WHEN whatsapp_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS whatsapp_sent,
       SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
       SUM(CASE WHEN closure_status IN ('in_progress','delivered','refused') THEN 1 ELSE 0 END) AS shipped,
       SUM(CASE WHEN closure_status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN closure_status = 'refused' THEN 1 ELSE 0 END) AS refused
     FROM orders
     WHERE COALESCE(ordered_at, created_at) >= ? AND COALESCE(ordered_at, created_at) < ?
       AND status != 'ignored_old' AND shopify_order_id NOT LIKE 'TEST-%'`
  ).get(from, to) as Record<string, number | null>;
  const real = (id: string, label: string, source: string, key: string): GrowthFunnelStep => ({ id, label, source, value: row[key] ?? 0, available: true });
  return {
    from,
    to,
    period: "30d",
    missingIntegrations: ["Shopify Web Pixels"],
    steps: [
      { id: "visit", label: "Visita", source: "Shopify Web Pixels", value: null, available: false },
      { id: "product_view", label: "Producto visto", source: "Shopify Web Pixels", value: null, available: false },
      { id: "cart", label: "Carrito", source: "Shopify Web Pixels", value: null, available: false },
      { id: "checkout", label: "Checkout", source: "Shopify Web Pixels", value: null, available: false },
      real("cod_order", "Pedido COD", "Shopify webhooks", "orders_created"),
      real("whatsapp", "WhatsApp", "outbox confirmado", "whatsapp_sent"),
      real("confirmed", "Confirmado", "máquina de confirmación", "confirmed"),
      real("shipped", "Enviado", "eje de cierre", "shipped"),
      real("delivered", "Entregado", "eje de cierre", "delivered"),
      real("refused", "Devuelto", "eje de cierre", "refused"),
    ],
  };
}
