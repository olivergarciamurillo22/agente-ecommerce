// ============================================================
// T4 — Investigación de pedidos saltados por el backfill (skip_has_own_source).
//
// SOLO LECTURA. No hay flag --apply en ninguna parte de este módulo ni del
// script que lo llama (scripts/investigate-skipped-backfill.ts): no existe
// ningún camino de escritura, ni de Shopify ni de la DB local. El objetivo es
// responder una pregunta, no corregir nada — cualquier corrección que salga
// de esto es una tarea aparte, decidida por Pedro con el informe delante.
//
// Contexto: decideBackfillAction() (backfill.ts) SALTA un pedido con
// skip_has_own_source si ya tiene closure_source o closure_status distinto
// de 'unknown' — normalmente porque el webhook en vivo (E2) llegó primero.
// La sospecha es que algunos de esos pedidos quedaron con un cierre que ya
// no coincide con lo que Shopify dice AHORA (p.ej. un cancelled_at que llegó
// después y nunca se volvió a mirar). Este módulo responde eso: para cada
// pedido "saltado por tener fuente propia", pide su estado ACTUAL a Shopify
// y compara. NUNCA escribe el resultado — solo lo informa.
//
// SALVAGUARDA ESTRUCTURAL (igual que backfill.ts/reconcile.ts): este fichero
// no importa nada de WhatsApp/Baileys, y no contiene NINGÚN UPDATE/INSERT/
// DELETE de SQL ni llama a ninguna función de escritura de orders. Lo vigila
// el test "T4 salvaguarda estructural" en tests/run-tests.ts.
// ============================================================

import pino from "pino";
import { systemDbHandle, type ClosureStatus, type ClosureSource } from "../db";
import { getAdminAccessToken, shopifyAdminConfigured } from "./admin";
import { planClosureFromShopify, type ShopifyBackfillOrder, type ClosureSignal } from "./backfill";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

function apiVersion(): string {
  return process.env.SHOPIFY_API_VERSION || "2026-07";
}
function storeDomain(): string {
  return (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// Solo lo mínimo para decidir el cierre — nada de PII (sin email/phone/
// direcciones): esto es un diagnóstico, no necesita esos datos.
const FIELDS = [
  "id",
  "order_number",
  "name",
  "created_at",
  "updated_at",
  "cancelled_at",
  "fulfillment_status",
  "financial_status",
  "gateway",
  "payment_gateway_names",
  "tags",
].join(",");

export interface SkippedCandidate {
  id: number;
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  closureStatus: ClosureStatus;
  closureSource: ClosureSource | null;
  closureAt: number | null;
}

interface SkippedRow {
  id: number;
  shopify_order_id: string;
  shopify_order_number: string;
  closure_status: ClosureStatus;
  closure_source: ClosureSource | null;
  closure_at: number | null;
}

/**
 * Los pedidos que un backfill (E3) saltaría HOY con skip_has_own_source: ya
 * tienen closure_source o closure_status distinto de 'unknown'. Misma regla
 * exacta que decideBackfillAction (backfill.ts), aplicada directamente
 * contra la DB en vez de esperar a que corra un backfill de verdad.
 */
export function listSkippedByOwnSource(): SkippedCandidate[] {
  const rows = systemDbHandle()
    .prepare(
      `SELECT id, shopify_order_id, shopify_order_number, closure_status, closure_source, closure_at
       FROM orders
       WHERE closure_source IS NOT NULL OR closure_status != 'unknown'
       ORDER BY CAST(shopify_order_number AS INTEGER) DESC`
    )
    .all() as SkippedRow[];
  return rows.map((r) => ({
    id: r.id,
    shopifyOrderId: r.shopify_order_id,
    shopifyOrderNumber: r.shopify_order_number,
    closureStatus: r.closure_status,
    closureSource: r.closure_source,
    closureAt: r.closure_at,
  }));
}

export type OrdersByIdFetcher = (shopifyOrderIds: string[]) => Promise<ShopifyBackfillOrder[]>;

/** Fetch real: pedidos concretos por su id de Shopify (GET orders.json?ids=...). Solo lectura. */
export const fetchShopifyOrdersByIds: OrdersByIdFetcher = async (shopifyOrderIds) => {
  if (shopifyOrderIds.length === 0) return [];
  if (!shopifyAdminConfigured()) {
    throw new Error("Admin API de Shopify no configurada (falta SHOPIFY_STORE_DOMAIN o credenciales)");
  }
  const token = await getAdminAccessToken();
  if (!token) throw new Error("No se pudo obtener un token de acceso de Shopify");

  const CHUNK = 100; // Shopify acepta hasta 250 ids por llamada; nos quedamos cortos por margen.
  const result: ShopifyBackfillOrder[] = [];
  for (let i = 0; i < shopifyOrderIds.length; i += CHUNK) {
    const chunk = shopifyOrderIds.slice(i, i + CHUNK);
    const params = new URLSearchParams({
      status: "any",
      ids: chunk.join(","),
      fields: FIELDS,
      limit: String(chunk.length),
    });
    const res = await fetch(
      `https://${storeDomain()}/admin/api/${apiVersion()}/orders.json?${params.toString()}`,
      { headers: { "X-Shopify-Access-Token": token }, signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) throw new Error(`orders.json HTTP ${res.status}`);
    const json = (await res.json()) as { orders?: ShopifyBackfillOrder[] };
    result.push(...(json.orders ?? []));
    logger.info(`[T4] pedidos ${i + 1}-${Math.min(i + CHUNK, shopifyOrderIds.length)} de ${shopifyOrderIds.length} consultados`);
  }
  return result;
};

export type DiscrepancyKind = "match" | "no_live_signal" | "discrepancy";

export interface InvestigationItem {
  local: SkippedCandidate;
  liveFulfillmentStatus: string | null | undefined;
  liveSignal: ClosureSignal | null;
  kind: DiscrepancyKind;
  /** Uno de los pedidos señalados explícitamente por Pedro para revisar aparte. */
  highlighted: boolean;
  /** Si Shopify no devolvió nada para este id (borrado, id equivocado, etc.). */
  notFoundInShopify?: boolean;
}

/**
 * Decisión PURA: compara lo local contra lo que Shopify dice AHORA. No toca
 * la DB ni la red — se prueba a fondo con fixtures.
 */
export function compareLocalToLive(
  local: SkippedCandidate,
  remote: ShopifyBackfillOrder | null,
  highlighted: boolean
): InvestigationItem {
  if (!remote) {
    return { local, liveFulfillmentStatus: undefined, liveSignal: null, kind: "no_live_signal", highlighted, notFoundInShopify: true };
  }
  const liveSignal = planClosureFromShopify(remote);
  if (!liveSignal) {
    return { local, liveFulfillmentStatus: remote.fulfillment_status, liveSignal: null, kind: "no_live_signal", highlighted };
  }
  const kind: DiscrepancyKind = liveSignal.status === local.closureStatus ? "match" : "discrepancy";
  return { local, liveFulfillmentStatus: remote.fulfillment_status, liveSignal, kind, highlighted };
}

export interface InvestigationReport {
  totalCandidates: number;
  items: InvestigationItem[];
  matches: number;
  discrepancies: number;
  noLiveSignal: number;
}

export interface RunInvestigationOptions {
  fetcher?: OrdersByIdFetcher;
  /** Números de pedido (shopify_order_number, sin '#') a señalar aparte. */
  highlightOrderNumbers?: string[];
}

// Los dos pedidos que Pedro pidió mirar en concreto (in_progress = 0 pese a
// tener seguimiento real) — ver la pregunta abierta al final del PR.
export const DEFAULT_HIGHLIGHT_ORDER_NUMBERS = ["35010824", "35010814"];

/** Orquestación: lee los candidatos locales, pide su estado actual a Shopify
 *  y compara. Nunca escribe nada — ni en la DB ni en Shopify. */
export async function runInvestigation(opts: RunInvestigationOptions = {}): Promise<InvestigationReport> {
  const fetcher = opts.fetcher ?? fetchShopifyOrdersByIds;
  const highlight = new Set(opts.highlightOrderNumbers ?? DEFAULT_HIGHLIGHT_ORDER_NUMBERS);

  const candidates = listSkippedByOwnSource();
  const remotes = await fetcher(candidates.map((c) => c.shopifyOrderId));
  const byId = new Map(remotes.map((r) => [String(r.id), r]));

  const items = candidates.map((c) =>
    compareLocalToLive(c, byId.get(c.shopifyOrderId) ?? null, highlight.has(c.shopifyOrderNumber))
  );

  return {
    totalCandidates: candidates.length,
    items,
    matches: items.filter((i) => i.kind === "match").length,
    discrepancies: items.filter((i) => i.kind === "discrepancy").length,
    noLiveSignal: items.filter((i) => i.kind === "no_live_signal").length,
  };
}
