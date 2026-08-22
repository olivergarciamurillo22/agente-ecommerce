// ============================================================
// Cliente HTTP de Dropea — implementado contra el spec OpenAPI oficial.
// Ver docs/DROPEA-API-CONTRACT.md
//
// Reglas de esta capa:
//  - La API key sale SOLO del entorno y NUNCA se registra en un log, ni
//    siquiera dentro de un mensaje de error.
//  - Todas las peticiones llevan timeout.
//  - Cada código de error se trata explícitamente; se respeta `Retry-After`.
//  - Las mutaciones (crear/confirmar/cancelar) NO se reintentan solas: un
//    reintento a ciegas puede duplicar un pedido real. La idempotencia la da
//    la cabecera `Idempotency-Key`, no un bucle de reintentos.
// ============================================================

import pino from "pino";
import type { DropeaEnvelope } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const DEFAULT_TIMEOUT_MS = 20_000;
/** Las mutaciones bloquean hasta 15s en su lado: damos margen. */
const MUTATION_TIMEOUT_MS = 25_000;

export interface DropeaConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Configuración desde el entorno. Si no hay base URL explícita, se deriva del
 * mercado (DROPEA_MARKET, "es" por defecto): el spec define un host por país.
 */
export function dropeaConfig(): DropeaConfig | null {
  const apiKey = (process.env.DROPEA_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const explicita = (process.env.DROPEA_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const mercado = (process.env.DROPEA_MARKET ?? "es").trim().toLowerCase();
  const baseUrl = explicita || `https://${mercado}.public-api.dropea.com`;
  return { baseUrl, apiKey };
}

export function dropeaCredentialsPresent(): boolean {
  return dropeaConfig() !== null;
}

/** ¿Se permite LEER de la API? (independiente de poder escribir) */
export function dropeaReadEnabled(): boolean {
  return process.env.DROPEA_API_ENABLED === "1" && dropeaCredentialsPresent();
}

/** Error de la API de Dropea, con su código de negocio si lo trae. */
export class DropeaApiError extends Error {
  readonly httpStatus: number;
  readonly failureType: string | null;
  readonly businessCode: string | null;
  readonly retryAfterSeconds: number | null;
  /** true si reintentar la MISMA petición es seguro y tiene sentido. */
  readonly retryable: boolean;

  constructor(params: {
    message: string;
    httpStatus: number;
    failureType?: string | null;
    businessCode?: string | null;
    retryAfterSeconds?: number | null;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = "DropeaApiError";
    this.httpStatus = params.httpStatus;
    this.failureType = params.failureType ?? null;
    this.businessCode = params.businessCode ?? null;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
    this.retryable = params.retryable ?? false;
  }
}

/** Devuelto cuando una mutación excede los 15s y sigue en curso (504). */
export class DropeaOperationPendingError extends Error {
  readonly operationId: string;
  constructor(operationId: string) {
    super(
      `la operación sigue en curso en Dropea (operation_id=${operationId}). ` +
        `Consulta GET /dropshipper/operations/${operationId} antes de reintentar.`
    );
    this.name = "DropeaOperationPendingError";
    this.operationId = operationId;
  }
}

export interface DropeaRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path relativo, p. ej. "/dropshipper/orders". */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Obligatoria en crear/confirmar/cancelar. */
  idempotencyKey?: string;
  timeoutMs?: number;
}

/** Traduce un fallo HTTP en un error nuestro, sin exponer la credencial. */
function construirError(
  httpStatus: number,
  envelope: DropeaEnvelope<unknown> | null,
  retryAfter: string | null
): DropeaApiError {
  const failure = envelope?.failure ?? null;
  const detalle = failure?.message || envelope?.message || `HTTP ${httpStatus}`;
  const retrySecs = retryAfter ? parseInt(retryAfter, 10) : null;

  const mensajes: Record<number, string> = {
    400: "petición rechazada por validación",
    401: "credencial de Dropea inválida o caducada",
    403: "la API key no tiene permiso para esta operación",
    404: "recurso no encontrado en Dropea",
    409: "conflicto: ya hay una petición idéntica en curso",
    422: "Dropea rechazó la operación por una regla de negocio",
    429: "límite de peticiones excedido",
  };

  return new DropeaApiError({
    message: `${mensajes[httpStatus] ?? "error de Dropea"}: ${detalle}`,
    httpStatus,
    failureType: failure?.type ?? null,
    businessCode: failure?.code ?? null,
    retryAfterSeconds: Number.isFinite(retrySecs as number) ? retrySecs : null,
    // Solo merece reintentar lo transitorio. 4xx casi nunca se arregla solo,
    // y reintentar un 422/409 sobre una mutación puede duplicar un pedido.
    retryable: httpStatus === 429 || httpStatus >= 500,
  });
}

/**
 * Punto único de entrada a la API de Dropea.
 * Lanza DropeaApiError con el detalle, o DropeaOperationPendingError si la
 * operación quedó en curso (504).
 */
export async function dropeaRequest<T>(opts: DropeaRequestOptions): Promise<T> {
  const config = dropeaConfig();
  if (!config) {
    throw new DropeaApiError({
      message: "falta DROPEA_API_KEY",
      httpStatus: 0,
    });
  }

  const url = new URL(config.baseUrl + opts.path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const method = opts.method ?? "GET";
  const esMutacion = method !== "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const timeout = opts.timeoutMs ?? (esMutacion ? MUTATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    // Sin respuesta: no sabemos si llegó a procesarse. NUNCA marcar como
    // retryable una mutación aquí — podría haberse creado el pedido.
    throw new DropeaApiError({
      message: `no se pudo contactar con Dropea: ${err instanceof Error ? err.message : "error de red"}`,
      httpStatus: 0,
      retryable: !esMutacion,
    });
  }

  // Aviso temprano si nos acercamos al límite (60/min, ventana deslizante).
  const restantes = res.headers.get("x-ratelimit-remaining");
  if (restantes !== null && Number(restantes) <= 5) {
    logger.warn(`[SUPPLIER] Dropea: quedan ${restantes} peticiones en la ventana actual`);
  }

  const texto = await res.text();
  let envelope: DropeaEnvelope<T> | null = null;
  try {
    envelope = texto ? (JSON.parse(texto) as DropeaEnvelope<T>) : null;
  } catch {
    envelope = null;
  }

  if (res.status === 504) {
    // Saga sin terminar: hay un operation_id (que es la Idempotency-Key).
    const data = envelope?.data as { operation_id?: string } | null;
    const opId = data?.operation_id ?? opts.idempotencyKey ?? "desconocido";
    throw new DropeaOperationPendingError(opId);
  }

  if (!res.ok) {
    throw construirError(res.status, envelope, res.headers.get("retry-after"));
  }

  if (!envelope || envelope.success === false) {
    throw construirError(res.status, envelope, null);
  }

  return envelope.data as T;
}
