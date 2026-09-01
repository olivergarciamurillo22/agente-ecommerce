// ============================================================
// Cliente HTTP de Beeping — contra el contrato público documentado
// (docs/BEEPING-API-CONTRACT.md). NO verificado con la API real todavía:
// el parseo es deliberadamente defensivo (envelope desconocido) y guarda
// siempre el crudo para diagnóstico.
//
// Reglas de esta capa (mismas que el cliente de Dropea):
//  - La credencial sale SOLO del entorno y JAMÁS aparece en un log, error
//    ni respuesta — ni siquiera parcialmente.
//  - Todas las peticiones llevan timeout.
//  - Las ESCRITURAS (mark-to-send, cancel, update) exigen
//    BEEPING_WRITE_ENABLED=1 y EMERGENCY_STOP=0, y NUNCA se reintentan
//    solas: un timeout ambiguo se resuelve CONSULTANDO, no repitiendo.
//  - createOrder NO existe aquí a propósito: los pedidos los crea la app
//    de Shopify de Beeping. Un POST /api/order/ duplicaría pedidos.
// ============================================================

import pino from "pino";
import { emergencyStop } from "../safety";
import { beepingConfig, beepingWriteEnabled } from "./config";
import type { BeepingListOrdersFilters, BeepingOrder, BeepingOrderLine, BeepingShop } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const DEFAULT_TIMEOUT_MS = 20_000;

export class BeepingApiError extends Error {
  readonly httpStatus: number;
  /** true si reintentar la MISMA lectura es seguro. Escrituras: nunca. */
  readonly retryable: boolean;
  constructor(params: { message: string; httpStatus: number; retryable?: boolean }) {
    super(params.message);
    this.name = "BeepingApiError";
    this.httpStatus = params.httpStatus;
    this.retryable = params.retryable ?? false;
  }
}

/**
 * Escritura que murió sin respuesta: NO SE SABE si Beeping la aplicó.
 * Quien la reciba debe consultar el estado remoto antes de decidir nada.
 */
export class BeepingAmbiguousWriteError extends Error {
  constructor(operation: string, cause: string) {
    super(`${operation}: sin respuesta de Beeping (${cause}). NO reintentar a ciegas: consultar el pedido primero.`);
    this.name = "BeepingAmbiguousWriteError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

function mensajeHttp(status: number): string {
  const mensajes: Record<number, string> = {
    400: "petición rechazada por validación",
    401: "credencial de Beeping inválida (revisar email/contraseña con beeping:auth:init)",
    403: "la cuenta de Beeping no tiene permiso para esta operación",
    404: "recurso no encontrado en Beeping",
    422: "Beeping rechazó la operación por una regla de negocio",
    429: "límite de peticiones de Beeping excedido",
  };
  return mensajes[status] ?? `error de Beeping (HTTP ${status})`;
}

/** Punto ÚNICO de entrada HTTP a Beeping. */
export async function beepingRequest<T = unknown>(opts: RequestOptions): Promise<T> {
  const config = beepingConfig();
  if (!config) {
    throw new BeepingApiError({ message: "falta BEEPING_BASIC_AUTH (npm run beeping:auth:init)", httpStatus: 0 });
  }

  const method = opts.method ?? "GET";
  const esEscritura = method !== "GET";
  if (esEscritura) {
    // Doble cerrojo estructural: aunque un llamador se salte release.ts,
    // esta capa no deja salir una escritura con los gates cerrados.
    if (!beepingWriteEnabled()) {
      throw new BeepingApiError({ message: "escrituras a Beeping DESACTIVADAS (BEEPING_WRITE_ENABLED != 1)", httpStatus: 0 });
    }
    if (emergencyStop()) {
      throw new BeepingApiError({ message: "EMERGENCY_STOP activo: ninguna escritura externa puede salir", httpStatus: 0 });
    }
  }

  const url = new URL(config.baseUrl + opts.path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${config.basicAuth}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const causa = err instanceof Error ? err.message : "error de red";
    registrarSalud(false, `sin respuesta de Beeping (${opts.path})`);
    if (esEscritura) throw new BeepingAmbiguousWriteError(`${method} ${opts.path}`, causa);
    throw new BeepingApiError({ message: `no se pudo contactar con Beeping: ${causa}`, httpStatus: 0, retryable: true });
  }

  const texto = await res.text();
  let json: unknown = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    // El cuerpo del error puede traer detalle útil, pero también podría
    // reflejar cabeceras: se recorta y JAMÁS se incluye la credencial.
    const detalle = typeof json === "object" && json !== null && "message" in json ? String((json as { message: unknown }).message).slice(0, 200) : "";
    const error = new BeepingApiError({
      message: detalle ? `${mensajeHttp(res.status)}: ${detalle}` : mensajeHttp(res.status),
      httpStatus: res.status,
      retryable: !esEscritura && (res.status === 429 || res.status >= 500),
    });
    registrarSalud(false, error.message);
    throw error;
  }

  registrarSalud(true);
  return json as T;
}

// --- Parseo defensivo (el envelope real no está documentado) ---

/** Extrae el array de datos de una respuesta con envelope desconocido. */
export function extractArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["data", "orders", "shops", "items", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
      // Un nivel más ({data: {orders: [...]}}), visto en APIs parecidas.
      const nested = obj[key];
      if (typeof nested === "object" && nested !== null) {
        for (const k2 of ["orders", "shops", "items", "data"]) {
          const arr = (nested as Record<string, unknown>)[k2];
          if (Array.isArray(arr)) return arr as Record<string, unknown>[];
        }
      }
    }
  }
  return [];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

export function parseBeepingOrder(rawItem: Record<string, unknown>): BeepingOrder | null {
  const external = str(rawItem.external_id);
  if (!external) return null;
  const linesRaw = Array.isArray(rawItem.lines) ? (rawItem.lines as Record<string, unknown>[]) : [];
  const lines: BeepingOrderLine[] = linesRaw.map((l) => ({
    name: str(l.name),
    sku: str(l.sku),
    qty: int(l.qty),
    amount: num(l.amount),
    raw: l,
  }));
  return {
    external_id: external,
    ref: str(rawItem.ref),
    shop_id: int(rawItem.shop_id),
    status: int(rawItem.status),
    tracking_stage: int(rawItem.tracking_stage),
    tracking_number: str(rawItem.tracking_number),
    courier_id: int(rawItem.courier_id),
    payment_method: str(rawItem.payment_method),
    payment_method_id: int(rawItem.payment_method_id),
    amount: num(rawItem.amount),
    financial_status: str(rawItem.financial_status),
    date: str(rawItem.date),
    date_tracking_update: str(rawItem.date_tracking_update),
    lines,
    raw: rawItem,
  };
}

// --- Operaciones documentadas ---

export async function listShops(): Promise<BeepingShop[]> {
  const payload = await beepingRequest({ path: "/api/get_shops" });
  return extractArray(payload)
    .map((s) => {
      const id = int(s.id);
      if (id === null) return null;
      return { id, name: str(s.name) ?? `tienda ${id}`, raw: s } satisfies BeepingShop;
    })
    .filter((s): s is BeepingShop => s !== null);
}

export async function listOrders(filters: BeepingListOrdersFilters = {}): Promise<BeepingOrder[]> {
  const payload = await beepingRequest({
    path: "/api/get_orders",
    query: {
      in: filters.in?.length ? filters.in.join(",") : undefined,
      from_date: filters.fromDate,
      shop_id: filters.shopId,
      per_page: filters.perPage,
      page: filters.page,
    },
  });
  return extractArray(payload)
    .map(parseBeepingOrder)
    .filter((o): o is BeepingOrder => o !== null);
}

/**
 * Busca UN pedido por su external_id usando el filtro `in` documentado de
 * get_orders (no se inventa un endpoint de detalle).
 */
export async function findOrderByExternalId(externalId: string): Promise<BeepingOrder | null> {
  const orders = await listOrders({ in: [externalId] });
  return orders.find((o) => o.external_id === externalId) ?? null;
}

/**
 * PUT /api/order/mark-to-send/{external_id} — LIBERA el pedido a
 * preparación. La única escritura del flujo normal de Casamable.
 * No llames a esto directamente: usa releaseOrderToBeeping (release.ts),
 * que aplica el gate completo y la idempotencia.
 */
export async function markToSend(externalId: string): Promise<unknown> {
  logger.info(`[BEEPING] mark-to-send ${externalId}`);
  return beepingRequest({ method: "PUT", path: `/api/order/mark-to-send/${encodeURIComponent(externalId)}` });
}

/** PUT /api/order/cancel/{external_id}. Solo vía el flujo de cancelación. */
export async function cancelOrder(externalId: string): Promise<unknown> {
  logger.info(`[BEEPING] cancel ${externalId}`);
  return beepingRequest({ method: "PUT", path: `/api/order/cancel/${encodeURIComponent(externalId)}` });
}

/**
 * PUT /api/order/{external_id} — editar pedido. La doc dice que SOLO admite
 * estados 1 (Pending) y 2 (Pending Stock); el llamador debe pasar antes por
 * canUpdateBeepingOrder (mapper.ts). El body se limita a campos documentados.
 */
export async function updateOrder(externalId: string, data: Record<string, unknown>): Promise<unknown> {
  logger.info(`[BEEPING] update ${externalId}`);
  return beepingRequest({ method: "PUT", path: `/api/order/${encodeURIComponent(externalId)}`, body: { data } });
}

/** Comprobación de vida READ-ONLY: credencial + API accesible + tiendas. */
export async function healthCheck(): Promise<{ ok: boolean; shops: BeepingShop[]; error: string | null }> {
  try {
    const shops = await listShops();
    return { ok: true, shops, error: null };
  } catch (err) {
    return { ok: false, shops: [], error: err instanceof Error ? err.message : "error desconocido" };
  }
}

// --- Observabilidad best-effort (mismo patrón que Dropea) ---

function registrarSalud(ok: boolean, error?: string): void {
  void import("../system/repo")
    .then((repo) => {
      repo.recordServiceCheck("beeping", { status: ok ? "healthy" : "warning", ok, error });
    })
    .catch(() => {
      /* la observabilidad nunca rompe una petición */
    });
}
