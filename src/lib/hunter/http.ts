// ============================================================
// AI Winner Radar — HTTP con freno de mano.
//
// Los proveedores de este módulo cobran por llamada. Un bucle mal escrito no
// produce un error: produce una factura. Por eso toda salida a la red pasa
// por aquí, que impone, en este orden:
//
//   1. CACHÉ    — la misma pregunta dentro de su ventana no se repite.
//   2. TOPE     — máximo de llamadas por búsqueda; al llegar, se para.
//   3. RITMO    — espaciado mínimo entre llamadas al mismo proveedor.
//   4. REINTENTO— solo lo seguro (429 y 5xx), con backoff exponencial.
//
// Un 401 o un 403 NO se reintentan: la clave no va a arreglarse sola y
// reintentar solo gasta cuota. Un 429 sin créditos tampoco: se aborta.
// ============================================================

import { systemDbHandle } from "../db";

export interface RateLimitConfig {
  /** Espaciado mínimo entre llamadas al mismo proveedor (ms). */
  minIntervalMs: number;
  /**
   * Techo de llamadas por hora al proveedor. El espaciado por sí solo NO lo
   * garantiza: 1.200 ms entre llamadas permiten 3.000 a la hora. Se señaló en
   * una validación real, y tenía razón — el comentario prometía una
   * protección que el código no daba.
   */
  maxPerHour?: number;
  maxRetries: number;
  timeoutMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  // WinningHunter documenta 60 req/min: 1100 ms deja margen para no rozarlo.
  minIntervalMs: 1100,
  maxRetries: 3,
  timeoutMs: 25_000,
};

const lastCallAt = new Map<string, number>();
/** Marcas de tiempo de la última hora, por proveedor. Ventana deslizante. */
const llamadasRecientes = new Map<string, number[]>();

export class HourlyLimitError extends Error {
  constructor(provider: string, limit: number) {
    super(`${provider}: alcanzado el techo de ${limit} llamadas/hora. Se detiene para no acabar bloqueado.`);
    this.name = "HourlyLimitError";
  }
}

/**
 * ¿Cuántas llamadas se han hecho a este proveedor en la última hora?
 * Es un contador EN MEMORIA: se reinicia al reiniciar el proceso. Suficiente
 * para un contenedor único —que es lo que hay— y honesto sobre su alcance:
 * no pretende ser una cuota distribuida.
 */
export function callsLastHour(provider: string): number {
  const hace1h = Date.now() - 3_600_000;
  const l = (llamadasRecientes.get(provider) ?? []).filter((t) => t > hace1h);
  llamadasRecientes.set(provider, l);
  return l.length;
}

function anotarLlamada(provider: string): void {
  const l = llamadasRecientes.get(provider) ?? [];
  l.push(Date.now());
  llamadasRecientes.set(provider, l);
}

export class CreditsExhaustedError extends Error {
  constructor(provider: string) {
    super(`${provider}: créditos agotados — la búsqueda se detiene`);
    this.name = "CreditsExhaustedError";
  }
}

export class CallBudgetError extends Error {
  constructor(limit: number) {
    super(`tope de ${limit} llamadas alcanzado en esta búsqueda`);
    this.name = "CallBudgetError";
  }
}

/**
 * Presupuesto de llamadas de UNA búsqueda. Se pasa explícitamente en vez de
 * vivir en un global: dos búsquedas simultáneas no deben compartir cupo ni
 * pisarse la cuenta.
 */
export class CallBudget {
  private used = 0;
  constructor(readonly limit: number) {}
  get spent(): number {
    return this.used;
  }
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
  consume(n = 1): void {
    if (this.used + n > this.limit) throw new CallBudgetError(this.limit);
    this.used += n;
  }
  canAfford(n = 1): boolean {
    return this.used + n <= this.limit;
  }
}

export interface HttpRequest {
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Segundos de vida en caché. 0 = no cachear. */
  cacheTtlSeconds?: number;
  cacheKey?: string;
  budget?: CallBudget;
  config?: Partial<RateLimitConfig>;
}

export interface HttpResponse<T> {
  ok: boolean;
  status: number | null;
  data: T | null;
  error: string | null;
  calls: number;
  fromCache: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function hunterFetch<T>(req: HttpRequest): Promise<HttpResponse<T>> {
  const cfg = { ...DEFAULT_RATE_LIMIT, ...(req.config ?? {}) };
  const ttl = req.cacheTtlSeconds ?? 0;
  const key = req.cacheKey ?? defaultCacheKey(req);

  if (ttl > 0) {
    const hit = readCache<T>(key);
    if (hit !== null) return { ok: true, status: 200, data: hit, error: null, calls: 0, fromCache: true };
  }

  if (req.budget && !req.budget.canAfford(1)) {
    return { ok: false, status: null, data: null, error: new CallBudgetError(req.budget.limit).message, calls: 0, fromCache: false };
  }

  let attempt = 0;
  let lastError = "error desconocido";
  let lastStatus: number | null = null;
  let calls = 0;

  while (attempt <= cfg.maxRetries) {
    // Techo horario: se comprueba ANTES de gastar la llamada. Pasarse del
    // límite de un proveedor no da un error puntual, da un bloqueo temporal
    // de la app entera — y eso deja el radar muerto para todo el día.
    if (cfg.maxPerHour !== undefined && callsLastHour(req.provider) >= cfg.maxPerHour) {
      return {
        ok: false,
        status: null,
        data: null,
        error: new HourlyLimitError(req.provider, cfg.maxPerHour).message,
        calls,
        fromCache: false,
      };
    }
    await respectPace(req.provider, cfg.minIntervalMs);
    anotarLlamada(req.provider);
    try {
      req.budget?.consume(1);
      calls += 1;
      const res = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: { accept: "application/json", ...(req.headers ?? {}) },
        // Una cadena se envía TAL CUAL: hay APIs (el OAuth de TikTok) que
        // exigen form-urlencoded, y serializarla a JSON la rompería en
        // silencio — el servidor respondería 400 y parecería culpa de las
        // credenciales.
        body: req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      lastStatus = res.status;

      if (res.ok) {
        const data = (await res.json()) as T;
        if (ttl > 0) writeCache(key, req.provider, data, ttl);
        return { ok: true, status: res.status, data, error: null, calls, fromCache: false };
      }

      // ══ EL CUERPO DEL ERROR ES LA RESPUESTA, NO UN ADORNO ══
      // Esto devolvía "respuesta 400" a secas. En una validación real de
      // Meta, ese 400 traía en el cuerpo la frase que resolvía el caso —
      // «Session has expired on Wednesday, 02-Sep-26» — y hubo que repetir
      // la llamada a mano con curl para verla. Un diagnóstico que esconde el
      // motivo hace perder más tiempo que no tener diagnóstico.
      const detalle = await providerMessage(res);

      // Credenciales o permisos: reintentar es tirar cuota a la basura.
      if (res.status === 401 || res.status === 403) {
        const base = res.status === 401 ? "credenciales rechazadas (401)" : "sin permiso para este recurso (403)";
        return {
          ok: false,
          status: res.status,
          data: null,
          error: detalle ? `${base}: ${detalle}` : base,
          calls,
          fromCache: false,
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          status: 404,
          data: null,
          error: detalle ? `recurso no encontrado (404): ${detalle}` : "recurso no encontrado (404)",
          calls,
          fromCache: false,
        };
      }
      if (res.status === 429) {
        // 429 puede ser ritmo (se espera) o créditos agotados (se aborta).
        if (/credit|quota|exhaust/i.test(detalle ?? "")) {
          return { ok: false, status: 429, data: null, error: new CreditsExhaustedError(req.provider).message, calls, fromCache: false };
        }
        lastError = detalle ? `límite de ritmo (429): ${detalle}` : "límite de ritmo (429)";
      } else if (res.status >= 500) {
        lastError = detalle ? `error del proveedor (${res.status}): ${detalle}` : `error del proveedor (${res.status})`;
      } else {
        return {
          ok: false,
          status: res.status,
          data: null,
          error: detalle ? `respuesta ${res.status}: ${detalle}` : `respuesta ${res.status}`,
          calls,
          fromCache: false,
        };
      }
    } catch (err) {
      if (err instanceof CallBudgetError) {
        return { ok: false, status: null, data: null, error: err.message, calls, fromCache: false };
      }
      lastError = err instanceof Error ? err.message : "fallo de red";
    }

    attempt += 1;
    if (attempt > cfg.maxRetries) break;
    // Backoff exponencial con jitter: sin jitter, varias llamadas que fallan
    // a la vez vuelven a golpear a la vez.
    const wait = Math.min(30_000, 800 * 2 ** attempt) + Math.floor(Math.random() * 250);
    await sleep(wait);
  }

  return { ok: false, status: lastStatus, data: null, error: lastError, calls, fromCache: false };
}

async function respectPace(provider: string, minIntervalMs: number): Promise<void> {
  const last = lastCallAt.get(provider) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(provider, Date.now());
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function defaultCacheKey(req: HttpRequest): string {
  const body = req.body === undefined ? "" : JSON.stringify(req.body);
  return `${req.provider}|${req.method ?? "GET"}|${req.url}|${body}`;
}

function readCache<T>(key: string): T | null {
  try {
    const row = systemDbHandle()
      .prepare("SELECT payload_json FROM hunter_cache WHERE cache_key = ? AND expires_at > unixepoch()")
      .get(key) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, provider: string, data: unknown, ttlSeconds: number): void {
  try {
    systemDbHandle()
      .prepare(
        `INSERT INTO hunter_cache (cache_key, provider, payload_json, expires_at)
         VALUES (?, ?, ?, unixepoch() + ?)
         ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,
           expires_at=excluded.expires_at, created_at=unixepoch()`
      )
      .run(key, provider, JSON.stringify(data), ttlSeconds);
  } catch {
    /* la caché es una optimización: jamás puede tumbar una búsqueda */
  }
}

/** Limpia lo caducado. La usa el job de mantenimiento (§58). */
/**
 * Saca el mensaje que el proveedor pone en el cuerpo del error.
 *
 * Graph y la mayoría de APIs REST devuelven `{"error":{"message":"..."}}`.
 * Se lee ESO y no el JSON entero: el cuerpo completo puede traer trazas,
 * cabeceras y —en el caso de Graph— la URL con el token dentro.
 *
 * Nunca lanza: si el cuerpo no se puede leer, el error sigue siendo el
 * código HTTP, que es mejor que ninguno.
 */
export async function providerMessage(res: Response): Promise<string | null> {
  const texto = await safeText(res);
  if (!texto) return null;
  let mensaje = texto;
  try {
    const j = JSON.parse(texto) as Record<string, unknown>;
    const err = j.error as Record<string, unknown> | string | undefined;
    if (typeof err === "string") mensaje = err;
    else if (err && typeof err === "object" && typeof err.message === "string") mensaje = err.message;
    else if (typeof j.message === "string") mensaje = j.message;
  } catch {
    // No era JSON: se usa el texto tal cual, recortado.
  }
  return scrubSecrets(mensaje).slice(0, 300) || null;
}

/** Ni tokens ni claves en un mensaje que va a acabar en un log o en la base. */
export function scrubSecrets(s: string): string {
  return s
    .replace(/access_token=[^&\s"]+/gi, "access_token=<oculto>")
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, "<token oculto>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-<oculta>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <oculto>");
}

export function purgeHunterCache(): number {
  try {
    const r = systemDbHandle().prepare("DELETE FROM hunter_cache WHERE expires_at <= unixepoch()").run();
    return r.changes;
  } catch {
    return 0;
  }
}

/** Solo para tests: reinicia el espaciado entre llamadas. */
export function __resetPaceForTests(): void {
  llamadasRecientes.clear();
  lastCallAt.clear();
}
