// ============================================================
// Salud del NÚCLEO: SQLite, copias de seguridad, outbox y schedulers.
//
// Todo READ-ONLY: aquí no se repara nada, no se ejecuta VACUUM, no se
// restaura ningún backup. Solo se mide y se traduce a un estado.
// Degradación local: si una carpeta del NAS no existe (backups), el estado
// es "unknown"/"disabled" con un mensaje claro — nunca un crash.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dbFilePath, systemDbHandle, SCHEMA_VERSION } from "../db";
import { getServiceHealth, listSchedulerRuns } from "./repo";
import type { HealthStatus, SchedulerRunRow, ServiceHealthRow } from "./types";

const now = () => Math.floor(Date.now() / 1000);

function envHours(name: string, def: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : def;
}
function envMinutes(name: string, def: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : def;
}

// ============================================================
// SQLite
// ============================================================

export interface DatabaseHealth {
  status: HealthStatus;
  reachable: boolean;
  /** Resultado de PRAGMA quick_check ("ok" o el error). Cacheado 5 min. */
  integrity: string;
  journalMode: string;
  dbSizeBytes: number | null;
  walSizeBytes: number | null;
  pageCount: number | null;
  freelistCount: number | null;
  schemaVersion: number;
  expectedSchemaVersion: number;
  /** Filas por tabla principal. */
  rowCounts: Record<string, number>;
  /** Última escritura aproximada (máximo timestamp observado). */
  lastWriteAt: number | null;
  message: string;
}

// El quick_check recorre la DB entera: cachearlo evita pagarlo en cada
// refresco del panel. 5 minutos es más que de sobra para detectar corrupción.
let integrityCache: { at: number; result: string } | null = null;
const INTEGRITY_CACHE_SEC = 300;

/**
 * Salud de la base de datos. `full` fuerza un `integrity_check` completo
 * (lo usa la CLI); el panel usa `quick_check` cacheado.
 */
export function getDatabaseHealth(opts?: { full?: boolean }): DatabaseHealth {
  const empty: DatabaseHealth = {
    status: "critical",
    reachable: false,
    integrity: "no comprobado",
    journalMode: "?",
    dbSizeBytes: null,
    walSizeBytes: null,
    pageCount: null,
    freelistCount: null,
    schemaVersion: 0,
    expectedSchemaVersion: SCHEMA_VERSION,
    rowCounts: {},
    lastWriteAt: null,
    message: "",
  };

  let db: Database.Database;
  try {
    db = systemDbHandle();
    db.prepare("SELECT 1").get();
  } catch (err) {
    empty.message = `SQLite no responde: ${err instanceof Error ? err.message : "error"}`;
    return empty;
  }

  const h = { ...empty, reachable: true };
  try {
    if (opts?.full) {
      const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
      h.integrity = rows.map((r) => r.integrity_check).join("; ");
    } else {
      if (!integrityCache || now() - integrityCache.at > INTEGRITY_CACHE_SEC) {
        const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
        integrityCache = { at: now(), result: rows.map((r) => r.quick_check).join("; ") };
      }
      h.integrity = integrityCache.result;
    }
    h.journalMode = String(db.pragma("journal_mode", { simple: true }));
    h.pageCount = Number(db.pragma("page_count", { simple: true }));
    h.freelistCount = Number(db.pragma("freelist_count", { simple: true }));
    h.schemaVersion = Number(db.pragma("user_version", { simple: true }));

    const p = dbFilePath();
    if (fs.existsSync(p)) h.dbSizeBytes = fs.statSync(p).size;
    if (fs.existsSync(`${p}-wal`)) h.walSizeBytes = fs.statSync(`${p}-wal`).size;

    for (const table of [
      "orders",
      "messages",
      "conversations",
      "outbox",
      "supplier_webhook_events",
      "integration_events",
    ]) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        h.rowCounts[table] = r.n;
      } catch {
        /* tabla ausente en DBs viejas: se omite */
      }
    }

    const last = db
      .prepare(
        `SELECT MAX(t) AS t FROM (
           SELECT MAX(updated_at) AS t FROM orders
           UNION ALL SELECT MAX(created_at) FROM messages
           UNION ALL SELECT MAX(created_at) FROM outbox
         )`
      )
      .get() as { t: number | null };
    h.lastWriteAt = last?.t ?? null;
  } catch (err) {
    h.status = "warning";
    h.message = `lectura parcial: ${err instanceof Error ? err.message : "error"}`;
    return h;
  }

  const integrityOk = h.integrity === "ok";
  h.status = integrityOk ? "healthy" : "critical";
  h.message = integrityOk
    ? `OK · ${h.journalMode.toUpperCase()} · ${formatBytes(h.dbSizeBytes)}`
    : `integridad FALLIDA: ${h.integrity}`;
  return h;
}

export function formatBytes(n: number | null): string {
  if (n === null) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ============================================================
// Backups
// ============================================================

export interface BackupHealth {
  status: HealthStatus;
  dir: string;
  /** null = carpeta inexistente o vacía. */
  lastBackupAt: number | null;
  lastBackupFile: string | null;
  lastBackupSizeBytes: number | null;
  ageHours: number | null;
  count: number;
  /** quick_check del último backup, cacheado por (fichero, mtime). */
  integrity: string;
  warningHours: number;
  criticalHours: number;
  message: string;
}

let backupIntegrityCache: { key: string; result: string } | null = null;

export function getBackupHealth(): BackupHealth {
  const dir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.resolve(process.cwd(), "backups");
  const warningHours = envHours("BACKUP_WARNING_HOURS", 24);
  const criticalHours = envHours("BACKUP_CRITICAL_HOURS", 48);

  const base: BackupHealth = {
    status: "unknown",
    dir,
    lastBackupAt: null,
    lastBackupFile: null,
    lastBackupSizeBytes: null,
    ageHours: null,
    count: 0,
    integrity: "no comprobado",
    warningHours,
    criticalHours,
    message: "",
  };

  let files: string[] = [];
  try {
    if (!fs.existsSync(dir)) {
      base.message = "carpeta de backups inexistente (normal fuera del NAS)";
      return base;
    }
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
  } catch (err) {
    base.message = `no se pudo leer la carpeta: ${err instanceof Error ? err.message : "error"}`;
    return base;
  }

  base.count = files.length;
  if (files.length === 0) {
    base.status = "warning";
    base.message = "la carpeta existe pero no hay ninguna copia todavía";
    return base;
  }

  let newest: { file: string; mtime: number; size: number } | null = null;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      const m = Math.floor(st.mtimeMs / 1000);
      if (!newest || m > newest.mtime) newest = { file: f, mtime: m, size: st.size };
    } catch {
      /* fichero desaparecido a mitad: ignorar */
    }
  }
  if (!newest) {
    base.status = "warning";
    base.message = "no se pudo leer ninguna copia";
    return base;
  }

  base.lastBackupFile = newest.file;
  base.lastBackupAt = newest.mtime;
  base.lastBackupSizeBytes = newest.size;
  base.ageHours = (now() - newest.mtime) / 3600;

  // Integridad del último backup (solo lectura, cacheado por mtime).
  const cacheKey = `${newest.file}:${newest.mtime}`;
  if (backupIntegrityCache?.key !== cacheKey) {
    try {
      const bdb = new Database(path.join(dir, newest.file), { readonly: true });
      try {
        const rows = bdb.pragma("quick_check") as Array<{ quick_check: string }>;
        backupIntegrityCache = { key: cacheKey, result: rows.map((r) => r.quick_check).join("; ") };
      } finally {
        bdb.close();
      }
    } catch (err) {
      backupIntegrityCache = {
        key: cacheKey,
        result: `no legible: ${err instanceof Error ? err.message : "error"}`,
      };
    }
  }
  base.integrity = backupIntegrityCache.result;

  if (base.integrity !== "ok") {
    base.status = "critical";
    base.message = `la última copia no pasa la comprobación: ${base.integrity}`;
  } else if (base.ageHours > criticalHours) {
    base.status = "critical";
    base.message = `última copia hace ${Math.round(base.ageHours)} h (límite ${criticalHours} h)`;
  } else if (base.ageHours > warningHours) {
    base.status = "warning";
    base.message = `última copia hace ${Math.round(base.ageHours)} h (aviso a las ${warningHours} h)`;
  } else {
    base.status = "healthy";
    base.message = `última copia hace ${
      base.ageHours < 1 ? `${Math.round(base.ageHours * 60)} min` : `${Math.round(base.ageHours)} h`
    } · ${base.count} copia(s)`;
  }
  return base;
}

// ============================================================
// Outbox
// ============================================================

export interface OutboxHealth {
  status: HealthStatus;
  pending: number;
  /** Pendientes que superan OUTBOX_MAX_AGE y NUNCA se enviarán solos. */
  retained: number;
  sentLast24h: number;
  oldestPendingAt: number | null;
  oldestPendingMinutes: number | null;
  lastSentAt: number | null;
  staleMinutes: number;
  maxAgeMinutes: number;
  message: string;
}

export function getOutboxHealth(): OutboxHealth {
  const staleMinutes = envMinutes("OUTBOX_STALE_MINUTES", 15);
  const maxAgeMinutes = envMinutes("OUTBOX_MAX_AGE_MINUTES", 60);
  const base: OutboxHealth = {
    status: "unknown",
    pending: 0,
    retained: 0,
    sentLast24h: 0,
    oldestPendingAt: null,
    oldestPendingMinutes: null,
    lastSentAt: null,
    staleMinutes,
    maxAgeMinutes,
    message: "",
  };
  try {
    const db = systemDbHandle();
    const t = now();
    const agg = db
      .prepare(
        `SELECT
           SUM(CASE WHEN sent = 0 THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN sent = 0 AND created_at < ? THEN 1 ELSE 0 END) AS retained,
           MIN(CASE WHEN sent = 0 THEN created_at END) AS oldest,
           SUM(CASE WHEN sent = 1 AND COALESCE(sent_at, created_at) >= ? THEN 1 ELSE 0 END) AS sent24,
           MAX(CASE WHEN sent = 1 THEN COALESCE(sent_at, created_at) END) AS lastSent
         FROM outbox`
      )
      .get(t - maxAgeMinutes * 60, t - 86400) as {
      pending: number | null;
      retained: number | null;
      oldest: number | null;
      sent24: number | null;
      lastSent: number | null;
    };

    base.pending = agg.pending ?? 0;
    base.retained = agg.retained ?? 0;
    base.sentLast24h = agg.sent24 ?? 0;
    base.oldestPendingAt = agg.oldest;
    base.oldestPendingMinutes = agg.oldest ? Math.floor((t - agg.oldest) / 60) : null;
    base.lastSentAt = agg.lastSent;
  } catch (err) {
    base.status = "critical";
    base.message = `no se pudo leer el outbox: ${err instanceof Error ? err.message : "error"}`;
    return base;
  }

  const oldestMin = base.oldestPendingMinutes ?? 0;
  if (base.retained > 10 || oldestMin > 24 * 60) {
    base.status = "critical";
    base.message = `${base.retained} mensaje(s) retenidos; el más viejo lleva ${Math.round(oldestMin / 60)} h. Revisar con outbox:inspect`;
  } else if (base.retained > 0) {
    base.status = "warning";
    base.message = `${base.retained} mensaje(s) retenidos por edad: no se enviarán solos (outbox:inspect)`;
  } else if (oldestMin > base.staleMinutes) {
    base.status = "warning";
    base.message = `hay pendientes desde hace ${oldestMin} min: ¿el bot está corriendo? ¿gates cerrados?`;
  } else {
    base.status = "healthy";
    base.message =
      base.pending > 0
        ? `${base.pending} pendiente(s) en proceso normal`
        : `sin pendientes · ${base.sentLast24h} enviado(s) en 24 h`;
  }
  return base;
}

// ============================================================
// Schedulers
// ============================================================

export interface SchedulerHealth {
  name: string;
  service: string;
  /** Intervalo esperado entre latidos, en segundos (según su config actual). */
  expectedIntervalSec: number;
  status: HealthStatus;
  lastHeartbeatAt: number | null;
  lastRun: SchedulerRunRow | null;
  message: string;
}

/** Registro de los schedulers conocidos: nombre, servicio y su intervalo real. */
function schedulerRegistry(): Array<{ name: string; service: string; intervalSec: number }> {
  const int = (name: string, def: number) => {
    const v = parseFloat(process.env[name] ?? "");
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return [
    { name: "orders", service: "scheduler:orders", intervalSec: int("ORDER_POLL_SECONDS", 20) },
    {
      name: "tracking",
      service: "scheduler:tracking",
      intervalSec: int("TRACKING_POLL_SECONDS", 300),
    },
    { name: "outbox", service: "scheduler:outbox", intervalSec: 2 },
    { name: "watchdog", service: "scheduler:watchdog", intervalSec: 300 },
  ];
}

export function getSchedulersHealth(): SchedulerHealth[] {
  const t = now();
  return schedulerRegistry().map(({ name, service, intervalSec }) => {
    const health = getServiceHealth(service);
    const lastRun = listSchedulerRuns(name, 1)[0] ?? null;
    const lastBeat = health?.last_checked_at ?? null;

    // El latido se escribe como mucho cada 60s aunque el loop corra cada 2s.
    const expected = Math.max(intervalSec, 60);
    let status: HealthStatus;
    let message: string;
    if (!lastBeat) {
      status = "unknown";
      message = "nunca ha dado señales (¿el bot ha arrancado alguna vez aquí?)";
    } else if (t - lastBeat > expected * 10) {
      status = "critical";
      message = `sin latido desde hace ${Math.round((t - lastBeat) / 60)} min`;
    } else if (t - lastBeat > expected * 3) {
      status = "warning";
      message = `latido atrasado (${Math.round((t - lastBeat) / 60)} min)`;
    } else if (health?.status === "warning" || health?.status === "critical") {
      status = health.status;
      message = health.last_error_message ?? "errores en la última ejecución";
    } else {
      status = "healthy";
      message = lastRun
        ? `última con trabajo: ${lastRun.processed_count} procesado(s)`
        : "vivo, sin trabajo pendiente";
    }
    return {
      name,
      service,
      expectedIntervalSec: intervalSec,
      status,
      lastHeartbeatAt: lastBeat,
      lastRun,
      message,
    };
  });
}

export type { ServiceHealthRow };
