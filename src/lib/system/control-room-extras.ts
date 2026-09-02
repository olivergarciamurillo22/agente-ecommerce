// ============================================================
// Extras de la Home v4 (§6): dinero en riesgo, importe del día,
// comparación con ayer (solo si hay datos), atención con importe y
// actividad reciente compacta. READ-ONLY. Vive aparte de control-room.ts
// para no tocar el agregador que ya consumen otras vistas.
// ============================================================

import { systemDbHandle } from "../db";
import { startOfBusinessDay } from "../time";
import { listIntegrationEvents } from "./repo";

export interface HomeExtras {
  today: {
    /** Suma de los importes de los pedidos de hoy (creados/comprados hoy). */
    totalAmount: number;
    /** Importe de pedidos vivos que aún no están confirmados o tienen un
     *  problema abierto: lo que se puede perder si nadie actúa. */
    revenueAtRisk: number;
    revenueAtRiskOrders: number;
  };
  /** Comparación con ayer, SOLO si ayer hubo pedidos (si no, null). */
  yesterday: { orders: number; confirmed: number; totalAmount: number } | null;
  /** Atención con dinero: cuánto importe hay detrás de cada tipo. */
  attentionAmounts: Record<string, { orders: number; amount: number }>;
  /** Actividad reciente compacta (sin PII: order_ref es el nº de pedido). */
  recentActivity: Array<{ at: number; integration: string; type: string; message: string; orderRef: string | null; severity: string }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function getHomeExtras(nowMs = Date.now()): HomeExtras {
  const db = systemDbHandle();
  const inicioHoy = startOfBusinessDay(nowMs);
  const inicioAyer = startOfBusinessDay(nowMs - 86400 * 1000);

  const sumar = (from: number, to: number) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)), 0) AS total,
                SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmados
         FROM orders WHERE COALESCE(ordered_at, created_at) >= ? AND COALESCE(ordered_at, created_at) < ?
           AND status != 'ignored_old' AND shopify_order_id NOT LIKE 'TEST-%'`
      )
      .get(from, to) as { n: number; total: number; confirmados: number | null };

  const hoy = sumar(inicioHoy, Math.floor(nowMs / 1000) + 1);
  const ayer = sumar(inicioAyer, inicioHoy);

  // Dinero en riesgo: pedidos vivos (cierre no terminal) que NO están
  // confirmados, o confirmados pero con problema abierto (cancelación
  // pedida, duplicado sin resolver, incidencia, error de proveedor).
  const riesgo = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)), 0) AS total
       FROM orders o
       WHERE o.status NOT IN ('ignored_old', 'cancelled')
         AND o.closure_status IN ('unknown', 'in_progress')
         AND o.shopify_order_id NOT LIKE 'TEST-%'
         AND (
           o.status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction','needs_call','error')
           OR (o.cancellation_requested_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM action_resolutions r WHERE r.order_id = o.id AND r.action_type = 'CANCEL_REQUEST'))
           OR (o.possible_duplicate = 1 AND NOT EXISTS (SELECT 1 FROM action_resolutions r WHERE r.order_id = o.id AND r.action_type = 'POSSIBLE_DUPLICATE'))
           OR o.supplier_status_normalized IN ('incident','returned')
           OR o.supplier_sync_status = 'manual_review'
         )`
    )
    .get() as { n: number; total: number };

  // Importe detrás de cada tipo de atención (misma definición que el Action Center).
  const amounts: Record<string, { orders: number; amount: number }> = {};
  const agg = (type: string, sql: string) => {
    try {
      const r = db.prepare(sql).get() as { n: number; total: number };
      if (r.n > 0) amounts[type] = { orders: r.n, amount: r2(r.total) };
    } catch {
      /* columna ausente en DB antigua: se omite */
    }
  };
  const base = `FROM orders o WHERE o.status != 'ignored_old' AND o.closure_status IN ('unknown','in_progress') AND o.shopify_order_id NOT LIKE 'TEST-%'`;
  agg("NEEDS_CALL", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.status = 'needs_call' AND o.phone != ''`);
  agg("AWAITING_REPLY", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.status IN ('awaiting_reply','reminder_sent','pending_send')`);
  agg("ADDRESS_CORRECTION", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.status = 'needs_correction'`);
  agg("ORDER_ERROR", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.status = 'error'`);
  agg("CANCEL_REQUEST", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.cancellation_requested_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM action_resolutions r WHERE r.order_id = o.id AND r.action_type = 'CANCEL_REQUEST')`);
  agg("POSSIBLE_DUPLICATE", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.possible_duplicate = 1 AND NOT EXISTS (SELECT 1 FROM action_resolutions r WHERE r.order_id = o.id AND r.action_type = 'POSSIBLE_DUPLICATE')`);
  agg("TRACKING_INCIDENT", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.supplier_status_normalized IN ('incident','returned')`);
  agg("BEEPING_AWAITING_RELEASE", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.status = 'confirmed' AND o.beeping_sync_status IN ('not_released','release_failed')`);
  agg("SUPPLIER_ERROR", `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(total_price AS REAL)),0) AS total ${base} AND o.supplier_sync_status = 'manual_review'`);

  const recent = listIntegrationEvents({ limit: 8 }).map((e) => ({
    at: e.created_at,
    integration: e.integration,
    type: e.event_type,
    message: e.message,
    orderRef: e.order_ref,
    severity: e.severity,
  }));

  return {
    today: {
      totalAmount: r2(hoy.total),
      revenueAtRisk: r2(riesgo.total),
      revenueAtRiskOrders: riesgo.n,
    },
    yesterday: ayer.n > 0 ? { orders: ayer.n, confirmed: ayer.confirmados ?? 0, totalAmount: r2(ayer.total) } : null,
    attentionAmounts: amounts,
    recentActivity: recent,
  };
}
