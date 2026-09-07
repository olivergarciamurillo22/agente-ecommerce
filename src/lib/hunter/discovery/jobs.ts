// ============================================================
// COLA DE BÚSQUEDAS DEL CAZADOR (07-09-2026) — docs/HUNTER-BUSCADOR.md
//
// Una búsqueda dura hasta quince minutos. Eso NO cabe en una petición HTTP de
// Next: la ruta moriría con cada redespliegue y bloquearía el hilo durante la
// agrupación. Así que el panel solo ENCOLA, y el trabajo lo ejecuta el proceso
// del bot, que es el que ya sostiene los demás trabajos largos (scheduler de
// pedidos, tracking, llamadas).
//
// El progreso vive en la fila, no en memoria: si el bot se reinicia a mitad,
// el trabajo queda como 'corriendo' con su último progreso y el vigilante lo
// recupera. El panel pregunta por el estado cada pocos segundos (polling, el
// único patrón de datos en vivo que este repo usa).
// ============================================================

import { systemDbHandle } from "../../db";
import { canRunDiscovery } from "../../safety";
import { logIntegrationEvent } from "../../system/repo";
import { DISCOVERY_HALTED_MESSAGE } from "./errors";
import type { WordSearchProgress, WordSearchResult } from "./word-search";

/**
 * Tipos de trabajo (07-09-2026, docs/HUNTER-AUDITOR.md):
 *  busqueda  · buscador por palabra (lo de siempre)
 *  auditoria · modo A: auditar una tienda por su URL
 *  cadena    · modo B: buscar por palabra y auditar en cadena las que destacan
 */
export type DiscoveryJobKind = "busqueda" | "auditoria" | "cadena";
export interface DiscoveryJobParams {
  storeUrl?: string;
  facebookUrl?: string | null;
}

export type DiscoveryJobStatus = "pendiente" | "corriendo" | "terminado" | "fallido" | "cancelado";

export interface DiscoveryJobRow {
  id: number;
  kind: DiscoveryJobKind;
  params_json: string | null;
  seed: string;
  country: string;
  days: number;
  minutes: number;
  status: DiscoveryJobStatus;
  requested_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  progress_json: string | null;
  result_json: string | null;
  error: string | null;
  stop_reason: string | null;
}

export interface DiscoveryJobView {
  id: number;
  kind: DiscoveryJobKind;
  params: DiscoveryJobParams;
  seed: string;
  country: string;
  days: number;
  minutes: number;
  status: DiscoveryJobStatus;
  requestedBy: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: (WordSearchProgress & { auditando?: string | null; auditsDone?: number; auditsTotal?: number }) | null;
  /** Busqueda: WordSearchResult. Auditoria y cadena: sus informes (ver audit/). */
  result: WordSearchResult | Record<string, unknown> | null;
  error: string | null;
  stopReason: string | null;
}

/** Minutos máximos por búsqueda: quince es el objetivo; treinta el techo duro. */
export const MAX_SEARCH_MINUTES = 30;

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function toJobView(row: DiscoveryJobRow): DiscoveryJobView {
  return {
    id: row.id,
    kind: (row.kind ?? "busqueda") as DiscoveryJobKind,
    params: parse<DiscoveryJobParams>(row.params_json) ?? {},
    seed: row.seed,
    country: row.country,
    days: row.days,
    minutes: row.minutes,
    status: row.status,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    progress: parse<DiscoveryJobView["progress"]>(row.progress_json),
    result: parse<DiscoveryJobView["result"]>(row.result_json),
    error: row.error,
    stopReason: row.stop_reason,
  };
}

export type EnqueueOutcome =
  | { ok: true; job: DiscoveryJobView }
  | { ok: false; reason: "parada_emergencia" | "ya_hay_una" | "palabra_vacia"; detail: string };

/**
 * Encola una búsqueda. Se niega, con motivo, si la parada de emergencia está
 * activa (el usuario tiene que verlo ANTES, no descubrirlo al fallar) o si ya
 * hay una búsqueda en marcha: dos a la vez se pisarían la cuota del token.
 */
export function enqueueDiscoveryJob(input: {
  seed: string;
  kind?: DiscoveryJobKind;
  params?: DiscoveryJobParams;
  country?: string;
  days?: number;
  minutes?: number;
  requestedBy?: string | null;
}): EnqueueOutcome {
  const kind: DiscoveryJobKind = input.kind ?? "busqueda";
  const seed = (input.seed ?? "").trim().slice(0, 200);
  if (!seed) {
    return { ok: false, reason: "palabra_vacia", detail: kind === "auditoria" ? "pega la URL de la tienda que quieres auditar" : "escribe una palabra o una frase corta para buscar" };
  }
  if (kind === "auditoria" && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}/i.test(seed)) {
    return { ok: false, reason: "palabra_vacia", detail: "eso no parece la URL de una tienda (ejemplo: tienda.es)" };
  }
  if (!canRunDiscovery()) return { ok: false, reason: "parada_emergencia", detail: DISCOVERY_HALTED_MESSAGE };
  const db = systemDbHandle();
  const activa = db.prepare("SELECT * FROM discovery_jobs WHERE status IN ('pendiente','corriendo') ORDER BY id DESC LIMIT 1").get() as DiscoveryJobRow | undefined;
  if (activa) {
    return { ok: false, reason: "ya_hay_una", detail: `ya hay una búsqueda ${activa.status} ("${activa.seed}"): espera a que termine para no partir la cuota del token` };
  }
  const minutes = Math.min(MAX_SEARCH_MINUTES, Math.max(1, Math.round(input.minutes ?? 15)));
  const days = Math.min(90, Math.max(1, Math.round(input.days ?? 30)));
  const country = (input.country ?? "ES").toUpperCase().slice(0, 2);
  const params: DiscoveryJobParams = { ...(input.params ?? {}) };
  if (kind === "auditoria") params.storeUrl = seed;
  const info = db
    .prepare("INSERT INTO discovery_jobs (seed, country, days, minutes, status, requested_by, kind, params_json) VALUES (?, ?, ?, ?, 'pendiente', ?, ?, ?)")
    .run(seed, country, days, minutes, input.requestedBy ?? null, kind, Object.keys(params).length ? JSON.stringify(params) : null);
  const row = db.prepare("SELECT * FROM discovery_jobs WHERE id = ?").get(Number(info.lastInsertRowid)) as DiscoveryJobRow;
  logIntegrationEvent("meta_ads", "discovery_job_encolada", "info", `trabajo del Cazador encolado (${kind}): "${seed}" (${country}, ${days} d, ${minutes} min)`, null);
  return { ok: true, job: toJobView(row) };
}

export function getDiscoveryJob(id: number): DiscoveryJobView | null {
  const row = systemDbHandle().prepare("SELECT * FROM discovery_jobs WHERE id = ?").get(id) as DiscoveryJobRow | undefined;
  return row ? toJobView(row) : null;
}

/** La última búsqueda, sea del estado que sea: es lo que enseña el panel al abrir. */
export function latestDiscoveryJob(): DiscoveryJobView | null {
  const row = systemDbHandle().prepare("SELECT * FROM discovery_jobs ORDER BY id DESC LIMIT 1").get() as DiscoveryJobRow | undefined;
  return row ? toJobView(row) : null;
}

export function listDiscoveryJobs(limit = 10): DiscoveryJobView[] {
  const rows = systemDbHandle().prepare("SELECT * FROM discovery_jobs ORDER BY id DESC LIMIT ?").all(Math.min(50, Math.max(1, limit))) as DiscoveryJobRow[];
  return rows.map(toJobView);
}

/** Reclama la siguiente pendiente. Atómico: de dos procesos, uno solo la coge. */
export function claimNextDiscoveryJob(nowSec = Math.floor(Date.now() / 1000)): DiscoveryJobView | null {
  const db = systemDbHandle();
  const claimed = db.transaction(() => {
    const row = db.prepare("SELECT * FROM discovery_jobs WHERE status = 'pendiente' ORDER BY id LIMIT 1").get() as DiscoveryJobRow | undefined;
    if (!row) return null;
    const info = db.prepare("UPDATE discovery_jobs SET status = 'corriendo', started_at = ? WHERE id = ? AND status = 'pendiente'").run(nowSec, row.id);
    if (info.changes === 0) return null;
    return db.prepare("SELECT * FROM discovery_jobs WHERE id = ?").get(row.id) as DiscoveryJobRow;
  })();
  return claimed ? toJobView(claimed) : null;
}

export function recordJobProgress(id: number, progress: NonNullable<DiscoveryJobView["progress"]>): void {
  try {
    systemDbHandle().prepare("UPDATE discovery_jobs SET progress_json = ? WHERE id = ?").run(JSON.stringify(progress), id);
  } catch {
    /* el progreso es informativo: jamás rompe la búsqueda */
  }
}

export function finishDiscoveryJob(id: number, result: { seed: string; stopReason: string } & Record<string, unknown>, nowSec = Math.floor(Date.now() / 1000), summary?: string): void {
  systemDbHandle()
    .prepare("UPDATE discovery_jobs SET status = 'terminado', finished_at = ?, result_json = ?, stop_reason = ? WHERE id = ?")
    // Los anuncios por candidato NO se persisten aquí: ya viven en
    // adlib_candidate_snapshots y duplicarlos hincharía la fila.
    .run(nowSec, JSON.stringify({ ...result, adsByCandidate: undefined }).slice(0, 2_000_000), result.stopReason, id);
  logIntegrationEvent("meta_ads", "discovery_job_terminada", "info", summary ?? `trabajo "${result.seed}" terminado, parada ${result.stopReason}`, null);
}

export function failDiscoveryJob(id: number, error: string, nowSec = Math.floor(Date.now() / 1000)): void {
  systemDbHandle()
    .prepare("UPDATE discovery_jobs SET status = 'fallido', finished_at = ?, error = ? WHERE id = ?")
    .run(nowSec, error.slice(0, 500), id);
  logIntegrationEvent("meta_ads", "discovery_job_fallida", "warning", `búsqueda fallida: ${error.slice(0, 200)}`, null);
}

/** Devuelve a la cola lo que quedó 'corriendo' de un proceso que se murió. */
export function requeueStuckJobs(maxRunMinutes = MAX_SEARCH_MINUTES + 10, nowSec = Math.floor(Date.now() / 1000)): number {
  return systemDbHandle()
    .prepare("UPDATE discovery_jobs SET status = 'fallido', finished_at = ?, error = 'el proceso se detuvo a mitad de la búsqueda' WHERE status = 'corriendo' AND started_at IS NOT NULL AND started_at < ?")
    .run(nowSec, nowSec - maxRunMinutes * 60).changes;
}
