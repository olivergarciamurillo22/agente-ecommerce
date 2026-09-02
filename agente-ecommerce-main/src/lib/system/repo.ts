// ============================================================
// Repository de observabilidad — el ÚNICO sitio que toca las tablas
// service_health / scheduler_runs / integration_events.
//
// Principios:
//  - Best-effort SIEMPRE: si registrar salud falla, el negocio sigue.
//    Ninguna escritura de aquí puede tumbar un envío ni un webhook.
//  - Todo texto pasa por sanitizeForEvents() antes de entrar.
//  - Los ticks sin trabajo no generan filas (el outbox corre cada 2s);
//    su latido va a service_health con un throttle en memoria.
//  - Las tablas se auto-podan: esto es diagnóstico, no un archivo histórico.
// ============================================================

import { systemDbHandle } from "../db";
import { sanitizeForEvents } from "./sanitize";
import type {
  EventIntegration,
  EventSeverity,
  HealthStatus,
  IntegrationEventRow,
  SchedulerRunRow,
  ServiceHealthRow,
  ServiceName,
} from "./types";

/** Interruptor general de la instrumentación. Encendido por defecto. */
export function systemHealthEnabled(): boolean {
  return process.env.SYSTEM_HEALTH_ENABLED !== "0";
}

const now = () => Math.floor(Date.now() / 1000);

/** A qué categoría del feed pertenece cada servicio (para eventos automáticos). */
const SERVICE_INTEGRATION: Record<string, EventIntegration> = {
  whatsapp: "whatsapp",
  shopify: "shopify",
  dropea: "dropea",
  dropi: "dropi",
  sqlite: "sqlite",
  backups: "backup",
  outbox: "whatsapp",
};
function integrationFor(service: string): EventIntegration {
  return SERVICE_INTEGRATION[service] ?? "system";
}

const RANK: Record<HealthStatus, number> = {
  healthy: 0,
  unknown: 0,
  disabled: 0,
  warning: 1,
  critical: 2,
};

// ============================================================
// service_health
// ============================================================

export interface ServiceCheck {
  status: HealthStatus;
  /** true además actualiza last_success_at; false, last_error_at. */
  ok?: boolean;
  /** Se sanitiza y se guarda como last_error_message. */
  error?: string;
  /** Se sanitiza valor a valor. Nada de payloads enteros. */
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Upsert del estado de un servicio. Si el estado EMPEORA (healthy→warning,
 * cualquiera→critical) o se RECUPERA (warning/critical→healthy), deja además
 * un evento en el feed: esa es la "alerta" persistida que pide el panel.
 */
export function recordServiceCheck(service: ServiceName, check: ServiceCheck): void {
  if (!systemHealthEnabled()) return;
  try {
    const db = systemDbHandle();
    const prev = db
      .prepare<[string], ServiceHealthRow>("SELECT * FROM service_health WHERE service = ?")
      .get(service);

    const t = now();
    const errMsg = check.error ? sanitizeForEvents(check.error) : null;
    const meta = check.metadata
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(check.metadata).map(([k, v]) => [
              k,
              typeof v === "string" ? sanitizeForEvents(v) : v,
            ])
          )
        )
      : null;

    db.prepare(
      `INSERT INTO service_health
         (service, status, last_success_at, last_error_at, last_error_message, last_checked_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET
         status = excluded.status,
         last_success_at = COALESCE(excluded.last_success_at, service_health.last_success_at),
         last_error_at = COALESCE(excluded.last_error_at, service_health.last_error_at),
         last_error_message = COALESCE(excluded.last_error_message, service_health.last_error_message),
         last_checked_at = excluded.last_checked_at,
         metadata_json = COALESCE(excluded.metadata_json, service_health.metadata_json)`
    ).run(
      service,
      check.status,
      check.ok === true ? t : null,
      check.ok === false ? t : null,
      check.ok === false ? errMsg : null,
      t,
      meta
    );

    // Transición → evento (la "alerta" que ve Pedro en el feed).
    const before: HealthStatus = prev?.status ?? "unknown";
    const after = check.status;
    if (RANK[after] > RANK[before]) {
      logIntegrationEvent(
        integrationFor(service),
        "status_change",
        after === "critical" ? "critical" : "warning",
        `${service}: ${before} → ${after}${errMsg ? ` (${errMsg})` : ""}`
      );
    } else if (RANK[before] > 0 && after === "healthy") {
      logIntegrationEvent(
        integrationFor(service),
        "status_change",
        "info",
        `${service}: recuperado (${before} → healthy)`
      );
    }
  } catch {
    /* la observabilidad nunca rompe el negocio */
  }
}

// Latidos con throttle (en memoria, por proceso): para loops de alta
// frecuencia que solo necesitan decir "sigo vivo".
const lastBeat = new Map<string, number>();
const BEAT_EVERY_SEC = 60;

export function heartbeat(service: ServiceName, status: HealthStatus = "healthy"): void {
  if (!systemHealthEnabled()) return;
  const t = now();
  const prev = lastBeat.get(service) ?? 0;
  if (t - prev < BEAT_EVERY_SEC) return;
  lastBeat.set(service, t);
  recordServiceCheck(service, { status, ok: status === "healthy" });
}

export function getServiceHealth(service: string): ServiceHealthRow | null {
  try {
    return (
      systemDbHandle()
        .prepare<[string], ServiceHealthRow>("SELECT * FROM service_health WHERE service = ?")
        .get(service) ?? null
    );
  } catch {
    return null;
  }
}

export function listServiceHealth(): ServiceHealthRow[] {
  try {
    return systemDbHandle()
      .prepare<[], ServiceHealthRow>("SELECT * FROM service_health ORDER BY service")
      .all();
  } catch {
    return [];
  }
}

// ============================================================
// scheduler_runs
// ============================================================

const RUNS_RETENTION_DAYS = 7;

export interface SchedulerRunInput {
  startedAt: number;
  finishedAt: number;
  status: "ok" | "error";
  processedCount: number;
  errorCount: number;
  lastError?: string | null;
}

/** Guarda una ejecución CON contenido (trabajo o error). Poda las viejas. */
export function recordSchedulerRun(name: string, run: SchedulerRunInput): void {
  if (!systemHealthEnabled()) return;
  try {
    const db = systemDbHandle();
    db.prepare(
      `INSERT INTO scheduler_runs
         (scheduler_name, started_at, finished_at, status, processed_count, error_count, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name,
      run.startedAt,
      run.finishedAt,
      run.status,
      run.processedCount,
      run.errorCount,
      run.lastError ? sanitizeForEvents(run.lastError) : null
    );
    db.prepare("DELETE FROM scheduler_runs WHERE started_at < ?").run(
      now() - RUNS_RETENTION_DAYS * 86400
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Envuelve el tick de un scheduler: latido siempre, fila solo si hubo
 * trabajo o error, y estado del servicio actualizado. El error del tick se
 * REGISTRA pero no se traga: se relanza para que el scheduler decida.
 */
export async function runInstrumented(
  service: ServiceName,
  name: string,
  tick: () => Promise<{ processed: number; errors: number; lastError?: string | null }>
): Promise<void> {
  const startedAt = now();
  try {
    const res = await tick();
    const finishedAt = now();
    if (res.processed > 0 || res.errors > 0) {
      recordSchedulerRun(name, {
        startedAt,
        finishedAt,
        status: res.errors > 0 ? "error" : "ok",
        processedCount: res.processed,
        errorCount: res.errors,
        lastError: res.lastError ?? null,
      });
    }
    if (res.errors > 0) {
      recordServiceCheck(service, {
        status: "warning",
        ok: false,
        error: res.lastError ?? `${res.errors} error(es) en el tick`,
      });
    } else {
      heartbeat(service);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordSchedulerRun(name, {
      startedAt,
      finishedAt: now(),
      status: "error",
      processedCount: 0,
      errorCount: 1,
      lastError: msg,
    });
    recordServiceCheck(service, { status: "critical", ok: false, error: msg });
    throw err;
  }
}

export function listSchedulerRuns(name?: string, limit = 50): SchedulerRunRow[] {
  try {
    const db = systemDbHandle();
    return name
      ? db
          .prepare<[string, number], SchedulerRunRow>(
            "SELECT * FROM scheduler_runs WHERE scheduler_name = ? ORDER BY started_at DESC LIMIT ?"
          )
          .all(name, limit)
      : db
          .prepare<[number], SchedulerRunRow>(
            "SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT ?"
          )
          .all(limit);
  } catch {
    return [];
  }
}

// ============================================================
// integration_events
// ============================================================

const EVENTS_MAX_ROWS = 5000;

export function logIntegrationEvent(
  integration: EventIntegration,
  eventType: string,
  severity: EventSeverity,
  message: string,
  orderRef?: string | null
): void {
  if (!systemHealthEnabled()) return;
  try {
    const db = systemDbHandle();
    db.prepare(
      `INSERT INTO integration_events (integration, event_type, severity, order_ref, message)
       VALUES (?, ?, ?, ?, ?)`
    ).run(integration, eventType, severity, orderRef ?? null, sanitizeForEvents(message));
    db.prepare(
      `DELETE FROM integration_events WHERE id <= (
         SELECT id FROM integration_events ORDER BY id DESC LIMIT 1 OFFSET ?
       )`
    ).run(EVENTS_MAX_ROWS);
  } catch {
    /* best-effort */
  }
}

export function listIntegrationEvents(opts?: {
  limit?: number;
  severity?: EventSeverity;
  integration?: EventIntegration;
  beforeId?: number;
}): IntegrationEventRow[] {
  try {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts?.severity) {
      where.push("severity = ?");
      params.push(opts.severity);
    }
    if (opts?.integration) {
      where.push("integration = ?");
      params.push(opts.integration);
    }
    if (opts?.beforeId) {
      where.push("id < ?");
      params.push(opts.beforeId);
    }
    const sql = `SELECT * FROM integration_events${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY id DESC LIMIT ?`;
    params.push(limit);
    return systemDbHandle()
      .prepare<Array<string | number>, IntegrationEventRow>(sql)
      .all(...params);
  } catch {
    return [];
  }
}

/** Cuenta eventos de un tipo desde una fecha (para contadores de Dropea). */
export function countIntegrationEvents(
  integration: EventIntegration,
  eventType: string,
  sinceSec: number
): number {
  try {
    const row = systemDbHandle()
      .prepare<[string, string, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM integration_events
         WHERE integration = ? AND event_type = ? AND created_at >= ?`
      )
      .get(integration, eventType, sinceSec);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
