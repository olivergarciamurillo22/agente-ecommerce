// ============================================================
// Alertas de NEGOCIO del Control Center (distintas de las técnicas).
//
// Cada regla es una función pura sobre cifras → fácil de testear con datos
// inventados sin tocar la base. Umbrales por variable de entorno, con el
// valor de negocio acordado el 22-08-2026 como default.
//
//   DELIVERY_RATE_WARN=70       tasa 7d por debajo → warning
//   DELIVERY_RATE_CRIT=65       tasa 7d por debajo → critical (break-even 62,9 %)
//   DELIVERY_RATE_MIN_SAMPLE=10 resueltos mínimos para evaluar la tasa
//   NEEDS_CALL_STALE_HOURS=12   pedidos sin llamar más de X h
//   NEEDS_CALL_CRIT_COUNT=5     a partir de cuántos, critical
//   SUPPLIER_FAILURES_WARN=3    fallos de proveedor en 24 h
//   OPEN_INCIDENTS_WARN=1       incidencias abiertas
//   TRACKING_NOTIFY_FAIL_WARN=5 avisos de tracking bloqueados/fallidos en 24 h
// ============================================================

import { systemDbHandle } from "../db";
import { countIntegrationEvents } from "./repo";
import { getDeliveryMetrics, type DeliveryMetrics } from "./delivery-metrics";
import { trackingStaleHours } from "./tracking-overview";
import type { HealthStatus } from "./types";

export type BusinessAlertCategory = "business" | "operations";

export interface BusinessAlert {
  id: string;
  category: BusinessAlertCategory;
  status: HealthStatus;
  label: string;
  message: string;
  /** Cifra que disparó la regla (para el panel). */
  value: number | null;
  threshold: number | null;
}

function envNum(name: string, def: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v >= 0 ? v : def;
}

export function businessThresholds() {
  return {
    deliveryWarn: envNum("DELIVERY_RATE_WARN", 70),
    deliveryCrit: envNum("DELIVERY_RATE_CRIT", 65),
    deliveryMinSample: Math.max(1, Math.floor(envNum("DELIVERY_RATE_MIN_SAMPLE", 10))),
    needsCallStaleHours: envNum("NEEDS_CALL_STALE_HOURS", 12),
    needsCallCritCount: Math.max(1, Math.floor(envNum("NEEDS_CALL_CRIT_COUNT", 5))),
    supplierFailuresWarn: Math.max(1, Math.floor(envNum("SUPPLIER_FAILURES_WARN", 3))),
    openIncidentsWarn: Math.max(1, Math.floor(envNum("OPEN_INCIDENTS_WARN", 1))),
    trackingNotifyFailWarn: Math.max(1, Math.floor(envNum("TRACKING_NOTIFY_FAIL_WARN", 5))),
  };
}

export type Thresholds = ReturnType<typeof businessThresholds>;

// --- Reglas puras ---

export function evalDeliveryRate(
  rate: number | null,
  resolved: number,
  t: Pick<Thresholds, "deliveryWarn" | "deliveryCrit" | "deliveryMinSample">
): BusinessAlert {
  const base = { id: "delivery_rate_7d", category: "business" as const, label: "Tasa de entrega (7 días)" };
  if (rate === null || resolved < t.deliveryMinSample) {
    return {
      ...base,
      status: "unknown",
      value: rate,
      threshold: t.deliveryWarn,
      message:
        resolved === 0
          ? "sin envíos resueltos en 7 días: no se puede calcular"
          : `${resolved} envío(s) resueltos: muestra insuficiente (mínimo ${t.deliveryMinSample})`,
    };
  }
  if (rate < t.deliveryCrit) {
    return {
      ...base,
      status: "critical",
      value: rate,
      threshold: t.deliveryCrit,
      message: `${rate} % de entrega sobre ${resolved} resueltos: por debajo del ${t.deliveryCrit} %, cerca del break-even`,
    };
  }
  if (rate < t.deliveryWarn) {
    return {
      ...base,
      status: "warning",
      value: rate,
      threshold: t.deliveryWarn,
      message: `${rate} % de entrega sobre ${resolved} resueltos: por debajo del ${t.deliveryWarn} %`,
    };
  }
  return {
    ...base,
    status: "healthy",
    value: rate,
    threshold: t.deliveryWarn,
    message: `${rate} % de entrega sobre ${resolved} resueltos`,
  };
}

export function evalNeedsCall(
  staleCount: number,
  totalNeedsCall: number,
  t: Pick<Thresholds, "needsCallStaleHours" | "needsCallCritCount">
): BusinessAlert {
  const base = { id: "needs_call_stale", category: "operations" as const, label: "Pedidos pendientes de llamada" };
  if (staleCount >= t.needsCallCritCount) {
    return {
      ...base,
      status: "critical",
      value: staleCount,
      threshold: t.needsCallCritCount,
      message: `${staleCount} pedido(s) llevan más de ${t.needsCallStaleHours} h esperando llamada (${totalNeedsCall} en total)`,
    };
  }
  if (staleCount > 0) {
    return {
      ...base,
      status: "warning",
      value: staleCount,
      threshold: 1,
      message: `${staleCount} pedido(s) llevan más de ${t.needsCallStaleHours} h esperando llamada`,
    };
  }
  return {
    ...base,
    status: "healthy",
    value: totalNeedsCall,
    threshold: 1,
    message: totalNeedsCall > 0 ? `${totalNeedsCall} pendiente(s), ninguno atrasado` : "sin pedidos pendientes de llamada",
  };
}

export function evalSupplierFailures(count24h: number, t: Pick<Thresholds, "supplierFailuresWarn">): BusinessAlert {
  const base = { id: "supplier_failures", category: "operations" as const, label: "Fallos de proveedor (24 h)" };
  if (count24h >= t.supplierFailuresWarn) {
    return { ...base, status: "warning", value: count24h, threshold: t.supplierFailuresWarn, message: `${count24h} fallo(s) de proveedor en 24 h` };
  }
  return { ...base, status: "healthy", value: count24h, threshold: t.supplierFailuresWarn, message: count24h ? `${count24h} fallo(s), por debajo del umbral` : "sin fallos de proveedor" };
}

export function evalTrackingStale(stale: number, staleHours: number): BusinessAlert {
  const base = { id: "tracking_stale", category: "operations" as const, label: "Envíos sin noticias" };
  if (stale > 0) {
    return { ...base, status: "warning", value: stale, threshold: 1, message: `${stale} envío(s) activos sin noticias en más de ${staleHours} h` };
  }
  return { ...base, status: "healthy", value: 0, threshold: 1, message: "todos los envíos activos con seguimiento al día" };
}

export function evalOpenIncidents(open: number, t: Pick<Thresholds, "openIncidentsWarn">): BusinessAlert {
  const base = { id: "open_incidents", category: "operations" as const, label: "Incidencias abiertas" };
  if (open >= t.openIncidentsWarn) {
    return { ...base, status: "warning", value: open, threshold: t.openIncidentsWarn, message: `${open} incidencia(s) de envío abiertas` };
  }
  return { ...base, status: "healthy", value: open, threshold: t.openIncidentsWarn, message: "sin incidencias abiertas" };
}

export function evalTrackingNotifyFailures(count24h: number, t: Pick<Thresholds, "trackingNotifyFailWarn">): BusinessAlert {
  const base = { id: "tracking_notify_failures", category: "operations" as const, label: "Avisos de envío fallidos (24 h)" };
  if (count24h > t.trackingNotifyFailWarn) {
    return { ...base, status: "warning", value: count24h, threshold: t.trackingNotifyFailWarn, message: `${count24h} aviso(s) de envío bloqueados o fallidos en 24 h` };
  }
  return { ...base, status: "healthy", value: count24h, threshold: t.trackingNotifyFailWarn, message: count24h ? `${count24h} aviso(s) bloqueados, dentro del umbral` : "todos los avisos de envío salieron" };
}

// --- Lectura de cifras ---

export interface BusinessSnapshot {
  needsCallTotal: number;
  needsCallStale: number;
  openIncidents: number;
  supplierFailures24h: number;
  trackingNotifyFailures24h: number;
  trackingStale: number;
}

export function readBusinessSnapshot(nowS = Math.floor(Date.now() / 1000), staleHoursNeedsCall = businessThresholds().needsCallStaleHours): BusinessSnapshot {
  const db = systemDbHandle();
  const limite = nowS - staleHoursNeedsCall * 3600;
  const needsCall = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(needs_call_at, updated_at) < ? THEN 1 ELSE 0 END) AS stale
       FROM orders WHERE status = 'needs_call'`
    )
    .get(limite) as { total: number; stale: number | null };
  const incidencias = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
       WHERE supplier_external_order_id IS NOT NULL AND supplier_status_normalized = 'incident'`
    )
    .get() as { n: number };
  const desde24h = nowS - 86400;
  const supplierFailures =
    countIntegrationEvents("dropea", "order_create_failed", desde24h) +
    countIntegrationEvents("dropi", "order_create_failed", desde24h) +
    countIntegrationEvents("dropea", "api_error", desde24h) +
    countIntegrationEvents("dropi", "api_error", desde24h);
  const notifyFailures = countIntegrationEvents("tracking", "notification_blocked", desde24h);

  // Stale tracking: misma definición que tracking-overview.
  const activos = ["created", "processing", "shipped", "in_transit", "out_for_delivery", "delivery_attempted", "at_pickup_point", "incident"];
  const ph = activos.map(() => "?").join(",");
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
       WHERE supplier_external_order_id IS NOT NULL
         AND supplier_status_normalized IN (${ph})
         AND COALESCE(tracking_last_checked_at, tracking_first_seen_at, updated_at) < ?`
    )
    .get(...activos, nowS - trackingStaleHours() * 3600) as { n: number };

  return {
    needsCallTotal: needsCall.total ?? 0,
    needsCallStale: needsCall.stale ?? 0,
    openIncidents: incidencias.n,
    supplierFailures24h: supplierFailures,
    trackingNotifyFailures24h: notifyFailures,
    trackingStale: stale.n,
  };
}

export interface BusinessAlertsResult {
  status: HealthStatus;
  alerts: BusinessAlert[];
  snapshot: BusinessSnapshot;
  thresholds: Thresholds;
}

const RANK: Record<HealthStatus, number> = { healthy: 0, disabled: 0, unknown: 0, warning: 1, critical: 2 };

export function getBusinessAlerts(
  metrics: DeliveryMetrics = getDeliveryMetrics(),
  snapshot: BusinessSnapshot = readBusinessSnapshot()
): BusinessAlertsResult {
  const t = businessThresholds();
  const w = metrics.last7d;
  const alerts: BusinessAlert[] = [
    evalDeliveryRate(w.deliveryRate, w.delivered + w.returned, t),
    evalNeedsCall(snapshot.needsCallStale, snapshot.needsCallTotal, t),
    evalOpenIncidents(snapshot.openIncidents, t),
    evalSupplierFailures(snapshot.supplierFailures24h, t),
    evalTrackingStale(snapshot.trackingStale, trackingStaleHours()),
    evalTrackingNotifyFailures(snapshot.trackingNotifyFailures24h, t),
  ];
  let status: HealthStatus = "healthy";
  for (const a of alerts) if (RANK[a.status] > RANK[status]) status = a.status;
  return { status, alerts, snapshot, thresholds: t };
}
