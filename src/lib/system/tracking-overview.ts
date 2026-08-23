// ============================================================
// Vista de envíos para el Control Center. READ-ONLY sobre `orders`.
//
// "Stale" = envío ACTIVO al que nadie (ni webhook ni polling) ha mirado en
// más de TRACKING_STALE_HOURS. No dispara nada: solo se enseña, porque un
// envío del que no sabemos nada en X horas es exactamente lo que Pedro
// tiene que ver antes de que el cliente llame preguntando.
// ============================================================

import { systemDbHandle } from "../db";
import type { HealthStatus } from "./types";

const now = () => Math.floor(Date.now() / 1000);

/** Estados que cuentan como envío VIVO (ni terminales ni pre-proveedor). */
const ACTIVE_STATES = [
  "created",
  "processing",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivery_attempted",
  "at_pickup_point",
  "incident",
];

export function trackingStaleHours(): number {
  const v = parseFloat(process.env.TRACKING_STALE_HOURS ?? "");
  return Number.isFinite(v) && v > 0 ? v : 12;
}

export interface TrackingOverview {
  status: HealthStatus;
  activeShipments: number;
  byState: Record<string, number>;
  deliveredToday: number;
  incidents: number;
  /** Activos sin NINGUNA comprobación en más de staleHours. */
  stale: number;
  /** Pedidos parados ANTES del proveedor: dirección inservible (city "-"…)
   *  o pendientes de revisión humana. El hallazgo nº1 de Pedro, visible. */
  blockedAddress: number;
  manualReview: number;
  staleHours: number;
  staleOrders: Array<{ orderNumber: string; state: string; hoursSinceCheck: number | null }>;
  message: string;
}

export function getTrackingOverview(): TrackingOverview {
  const staleHours = trackingStaleHours();
  const base: TrackingOverview = {
    status: "unknown",
    activeShipments: 0,
    byState: {},
    deliveredToday: 0,
    incidents: 0,
    stale: 0,
    blockedAddress: 0,
    manualReview: 0,
    staleHours,
    staleOrders: [],
    message: "",
  };

  try {
    const db = systemDbHandle();
    const t = now();
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");

    const porEstado = db
      .prepare(
        `SELECT supplier_status_normalized AS s, COUNT(*) AS n FROM orders
         WHERE supplier_external_order_id IS NOT NULL
           AND supplier_status_normalized IN (${placeholders})
         GROUP BY supplier_status_normalized`
      )
      .all(...ACTIVE_STATES) as Array<{ s: string; n: number }>;
    for (const r of porEstado) {
      base.byState[r.s] = r.n;
      base.activeShipments += r.n;
    }
    base.incidents = base.byState["incident"] ?? 0;

    // Entregados HOY (día local del servidor).
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);
    const hoy = Math.floor(inicioDia.getTime() / 1000);
    const entregados = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
         WHERE supplier_status_normalized = 'delivered' AND updated_at >= ?`
      )
      .get(hoy) as { n: number };
    base.deliveredToday = entregados.n;

    const parados = db
      .prepare(
        `SELECT supplier_sync_status AS s, COUNT(*) AS n FROM orders
         WHERE supplier_sync_status IN ('blocked_address','manual_review')
         GROUP BY supplier_sync_status`
      )
      .all() as Array<{ s: string; n: number }>;
    for (const r of parados) {
      if (r.s === "blocked_address") base.blockedAddress = r.n;
      if (r.s === "manual_review") base.manualReview = r.n;
    }

    // Stale: activo y sin comprobación (webhook o polling) en > staleHours.
    // Un pedido sin NINGUNA comprobación usa su primer avistamiento o alta.
    const limite = t - staleHours * 3600;
    const stale = db
      .prepare(
        `SELECT shopify_order_number AS num, supplier_status_normalized AS s,
                COALESCE(tracking_last_checked_at, tracking_first_seen_at, updated_at) AS seen
         FROM orders
         WHERE supplier_external_order_id IS NOT NULL
           AND supplier_status_normalized IN (${placeholders})
           AND COALESCE(tracking_last_checked_at, tracking_first_seen_at, updated_at) < ?
         ORDER BY seen ASC LIMIT 20`
      )
      .all(...ACTIVE_STATES, limite) as Array<{ num: string; s: string; seen: number | null }>;
    base.stale = stale.length;
    base.staleOrders = stale.map((r) => ({
      orderNumber: r.num,
      state: r.s,
      hoursSinceCheck: r.seen ? Math.round((t - r.seen) / 3600) : null,
    }));
  } catch (err) {
    base.status = "warning";
    base.message = `no se pudo leer: ${err instanceof Error ? err.message : "error"}`;
    return base;
  }

  if (base.stale > 0) {
    base.status = "warning";
    base.message = `${base.stale} envío(s) activos sin noticias en más de ${staleHours} h`;
  } else if (base.blockedAddress > 0) {
    base.status = "warning";
    base.message = `${base.blockedAddress} pedido(s) con dirección inservible (la ciudad "-" de Releasit): no pueden ir al proveedor`;
  } else if (base.incidents > 0) {
    base.status = "warning";
    base.message = `${base.incidents} incidencia(s) abiertas`;
  } else if (base.activeShipments === 0) {
    base.status = "healthy";
    base.message = "sin envíos activos";
  } else {
    base.status = "healthy";
    base.message = `${base.activeShipments} envío(s) en curso, todos con seguimiento al día`;
  }
  return base;
}
