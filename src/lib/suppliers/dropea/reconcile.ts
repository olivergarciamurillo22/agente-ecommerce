// ============================================================
// E8 — Reconciliador de Dropea por API (24-08-2026).
//
// Problema medido en producción: Dropea manda webhooks de 21 pedidos
// distintos y solo 3 estaban enlazados localmente (E4, enlace por tag, no
// sirve aquí: 90 de 93 pedidos de Shopify llevan `dropea_error`, no
// `dropea_id`). Resultado: el eje de cierre no tenía ni una entrega ni un
// rehúse reales de Dropea.
//
// SALVAGUARDA ESTRUCTURAL (no un flag): este fichero NO importa NI PUEDE
// importar nada de WhatsApp/Baileys, y solo puede LEER de Dropea — ni una
// sola función de escritura (createOrder/confirm/cancel) está importada
// aquí abajo. El test "E8 salvaguarda estructural" falla si algún día
// aparece cualquiera de los dos.
//
// LA CLAVE DE CORRELACIÓN NO SE ASUME. `DropeaOrder.external_order_id` es
// el único campo de correlación que expone su lectura de pedido (no hay
// teléfono ni nombre en ese endpoint — verificado en types.ts/DROPEA-API-
// CONTRACT.md). Se prueba contra los DOS candidatos locales posibles
// (`shopify_order_id` y `shopify_order_number`) y el desglose del dry-run
// dice cuál de los dos acertó de verdad — eso es "mirar una respuesta real"
// aplicado a 21 pedidos reales, no una suposición de diseño.
//
// Reglas duras:
//  1. NUNCA se sobrescribe un enlace existente (setOrderSupplierPlatformAnd-
//     ExternalId ya lo garantiza: solo escribe si supplier_external_order_id
//     era NULL).
//  2. Un id de Dropea que casaría con MÁS de un pedido local → ambiguo, no
//     se enlaza nada. Mejor no decidir que decidir mal.
//  3. Cero escrituras hacia Dropea: solo getDropeaOrder (GET).
//  4. Tras enlazar (o si ya estaba enlazado), se rellena el eje de cierre
//     con el estado ACTUAL de Dropea para ese pedido — misma llamada ya
//     hecha para decidir el enlace, sin una segunda petición. closure_at
//     es SIEMPRE la fecha que reporta Dropea (updated_at/created_at); si no
//     hay fecha, no se escribe nada (nunca now()). canTransitionClosure (E1)
//     sigue protegiendo los terminales ya fijados por otra fuente.
//  5. Reanudable: checkpoint en `settings` tras cada pedido procesado.
//     Backoff ante 429 respetando Retry-After.
// ============================================================

import pino from "pino";
import {
  getOrderByShopifyId,
  getOrderByShopifyOrderNumber,
  getOrderBySupplierExternalId,
  getSetting,
  listOrderWebhookResourceIds,
  setOrderClosure,
  setOrderSupplierPlatformAndExternalId,
  setSetting,
  type ClosureStatus,
  type OrderRow,
} from "../../db";
import { getDropeaOrder } from "./index";
import { dropeaCredentialsPresent, dropeaReadEnabled, DropeaApiError } from "./client";
import { normalizeDropeaStatus } from "./status-map";
import { logIntegrationEvent } from "../../system/repo";
import type { DropeaOrder } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const CHECKPOINT_KEY = "dropea_reconcile_last_resource_id";
const LAST_RUN_KEY = "dropea_reconcile_last_run_at";

// --- Decisión de enlace: PURA, sin DB ni red — así se prueba a fondo ---

export type DropeaLinkOutcome =
  | "already_linked_same"
  | "already_linked_conflict"
  | "linked_by_shopify_order_id"
  | "linked_by_shopify_order_number"
  | "ambiguous_multiple_matches"
  | "no_external_order_id"
  | "no_local_match";

export interface LinkDecision {
  outcome: DropeaLinkOutcome;
  /** El pedido local sobre el que actuar, si el resultado lo resuelve a uno solo. */
  localOrderId: number | null;
  matchedVia: "shopify_order_id" | "shopify_order_number" | null;
}

/**
 * Decide qué hacer con un pedido de Dropea dado su `external_order_id` y
 * los candidatos locales YA CONSULTADOS (inyectados, no consultados aquí:
 * mantiene la función pura y fácil de probar con fixtures, sin tocar SQLite).
 */
export function decideLink(
  externalOrderId: string | null | undefined,
  alreadyLinkedToThisId: OrderRow | null,
  byShopifyId: OrderRow | null,
  byShopifyOrderNumber: OrderRow | null
): LinkDecision {
  if (alreadyLinkedToThisId) {
    return { outcome: "already_linked_same", localOrderId: alreadyLinkedToThisId.id, matchedVia: null };
  }

  const ref = (externalOrderId ?? "").replace(/^#/, "").trim();
  if (!ref) {
    return { outcome: "no_external_order_id", localOrderId: null, matchedVia: null };
  }

  const candidatos = new Map<number, OrderRow>();
  if (byShopifyId) candidatos.set(byShopifyId.id, byShopifyId);
  if (byShopifyOrderNumber) candidatos.set(byShopifyOrderNumber.id, byShopifyOrderNumber);

  if (candidatos.size > 1) {
    return { outcome: "ambiguous_multiple_matches", localOrderId: null, matchedVia: null };
  }
  if (candidatos.size === 0) {
    return { outcome: "no_local_match", localOrderId: null, matchedVia: null };
  }

  const [local] = [...candidatos.values()];
  if (local.supplier_external_order_id) {
    // Tenía YA un id de proveedor, y no es este: conflicto, no se toca.
    return { outcome: "already_linked_conflict", localOrderId: local.id, matchedVia: null };
  }

  return {
    outcome: byShopifyId ? "linked_by_shopify_order_id" : "linked_by_shopify_order_number",
    localOrderId: local.id,
    matchedVia: byShopifyId ? "shopify_order_id" : "shopify_order_number",
  };
}

/** Los tres outcomes desde los que SÍ hay un pedido local resuelto sobre el que actuar. */
const RESOLVED_OUTCOMES: DropeaLinkOutcome[] = [
  "already_linked_same",
  "linked_by_shopify_order_id",
  "linked_by_shopify_order_number",
];

// --- Relleno del eje de cierre a partir del estado actual en Dropea ---

function toEpochSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface ClosureFromDropea {
  status: Extract<ClosureStatus, "delivered" | "refused" | "cancelled" | "in_progress">;
  /** epoch segundos — SIEMPRE la fecha que reporta Dropea, nunca now(). */
  at: number;
}

/**
 * Traduce el estado ACTUAL de un pedido de Dropea al eje de cierre.
 * `null` = no se escribe nada: o el par (status, sub_status) es desconocido
 * (nunca se adivina) o Dropea no trae ninguna fecha utilizable.
 */
export function planClosureFromDropeaOrder(order: DropeaOrder): ClosureFromDropea | null {
  const tracking = normalizeDropeaStatus(order.status, order.sub_status ?? null);
  if (tracking === "unknown") return null;

  const at = toEpochSeconds(order.updated_at) ?? toEpochSeconds(order.created_at);
  if (at === null) return null;

  const status: ClosureFromDropea["status"] =
    tracking === "delivered"
      ? "delivered"
      : tracking === "returned"
        ? "refused"
        : tracking === "cancelled"
          ? "cancelled"
          : "in_progress"; // created/processing/shipped/in_transit/out_for_delivery/delivery_attempted/at_pickup_point/incident
  return { status, at };
}

// --- Orquestación: paginado por lista fija, checkpoint, backoff ---

export type DropeaOrderFetcher = (resourceId: string) => Promise<DropeaOrder>;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetcher real: getDropeaOrder con reintento/backoff ante 429 (Retry-After). */
export const fetchDropeaOrder: DropeaOrderFetcher = async (resourceId) => {
  const maxRetries = 5;
  for (let intento = 0; intento <= maxRetries; intento++) {
    try {
      const pedido = await getDropeaOrder(resourceId);
      // Cortesía con el rate limit de Dropea (60/min): solo en el fetcher
      // REAL — un fetcher inyectado en tests no debe pagar esta espera.
      const delayMs = Number(process.env.DROPEA_RECONCILE_CALL_DELAY_MS) || 200;
      if (delayMs > 0) await sleep(delayMs);
      return pedido;
    } catch (err) {
      if (err instanceof DropeaApiError && err.retryable && err.httpStatus === 429) {
        const espera = (err.retryAfterSeconds ?? 2) * 1000;
        logger.warn(`[DROPEA RECONCILE] 429 en pedido ${resourceId} — esperando ${espera}ms`);
        await sleep(espera);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`getDropeaOrder(${resourceId}): demasiados 429 seguidos, abandonado`);
};

export type ReconcileOutcome = DropeaLinkOutcome | "fetch_failed";

export interface ReconcileItemResult {
  resourceId: string;
  outcome: ReconcileOutcome;
  matchedVia: "shopify_order_id" | "shopify_order_number" | null;
  localOrderId: number | null;
  closureApplied: boolean;
  closureStatus: ClosureFromDropea["status"] | null;
  error: string | null;
}

export interface ReconcileReport {
  total: number;
  processed: number;
  counts: Record<ReconcileOutcome, number>;
  closureApplied: number;
  closureSkippedNoSignal: number;
  closureSkippedBlockedTerminal: number;
  items: ReconcileItemResult[];
  done: boolean;
}

function emptyCounts(): Record<ReconcileOutcome, number> {
  return {
    already_linked_same: 0,
    already_linked_conflict: 0,
    linked_by_shopify_order_id: 0,
    linked_by_shopify_order_number: 0,
    ambiguous_multiple_matches: 0,
    no_external_order_id: 0,
    no_local_match: 0,
    fetch_failed: 0,
  };
}

export interface RunReconcileOptions {
  /** true (por defecto) = no escribe nada, solo informa. */
  dryRun?: boolean;
  /** Para tests: fuente inyectada en vez de la llamada real a Dropea. */
  fetcher?: DropeaOrderFetcher;
  /** Ignora el checkpoint guardado y procesa la lista completa desde el principio. */
  resetCheckpoint?: boolean;
  /** Tope de pedidos en esta ejecución (para trocear a mano si hiciera falta). */
  maxItems?: number;
  onItem?: (r: ReconcileItemResult) => void;
}

export async function runDropeaReconcile(opts: RunReconcileOptions = {}): Promise<ReconcileReport> {
  const dryRun = opts.dryRun !== false;
  const fetcher = opts.fetcher ?? fetchDropeaOrder;

  const todos = listOrderWebhookResourceIds("dropea");
  const checkpoint = opts.resetCheckpoint ? null : getSetting(CHECKPOINT_KEY);
  const desdeIndice = checkpoint ? todos.indexOf(checkpoint) + 1 : 0;
  const pendientes = todos.slice(Math.max(desdeIndice, 0));
  const lote = opts.maxItems ? pendientes.slice(0, opts.maxItems) : pendientes;

  const counts = emptyCounts();
  const items: ReconcileItemResult[] = [];
  let closureApplied = 0;
  let closureSkippedNoSignal = 0;
  let closureSkippedBlockedTerminal = 0;

  for (const resourceId of lote) {
    let dropeaOrder: DropeaOrder;
    try {
      dropeaOrder = await fetcher(resourceId);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      counts.fetch_failed++;
      const item: ReconcileItemResult = {
        resourceId,
        outcome: "fetch_failed",
        matchedVia: null,
        localOrderId: null,
        closureApplied: false,
        closureStatus: null,
        error: mensaje,
      };
      items.push(item);
      opts.onItem?.(item);
      if (!dryRun) setSetting(CHECKPOINT_KEY, resourceId);
      continue;
    }

    const alreadyLinkedToThisId = getOrderBySupplierExternalId(resourceId);
    const ref = (dropeaOrder.external_order_id ?? "").replace(/^#/, "").trim();
    const byShopifyId = ref ? getOrderByShopifyId(ref) : null;
    const byShopifyOrderNumber = ref ? getOrderByShopifyOrderNumber(ref) : null;

    const decision = decideLink(dropeaOrder.external_order_id, alreadyLinkedToThisId, byShopifyId, byShopifyOrderNumber);
    counts[decision.outcome]++;

    let closureApplyResult = false;
    let closureStatus: ClosureFromDropea["status"] | null = null;

    const esEnlaceNuevo =
      decision.outcome === "linked_by_shopify_order_id" || decision.outcome === "linked_by_shopify_order_number";
    if (!dryRun && esEnlaceNuevo) {
      setOrderSupplierPlatformAndExternalId(decision.localOrderId!, "dropea", resourceId);
    }

    if (RESOLVED_OUTCOMES.includes(decision.outcome) && decision.localOrderId) {
      const signal = planClosureFromDropeaOrder(dropeaOrder);
      if (!signal) {
        closureSkippedNoSignal++;
      } else if (dryRun) {
        closureStatus = signal.status; // se informa qué haría, sin escribir
      } else {
        const aplicado = setOrderClosure(decision.localOrderId, signal.status, "dropea", signal.at);
        closureStatus = signal.status;
        if (aplicado) {
          closureApplied++;
          closureApplyResult = true;
        } else {
          closureSkippedBlockedTerminal++;
        }
      }
    }

    const item: ReconcileItemResult = {
      resourceId,
      outcome: decision.outcome,
      matchedVia: decision.matchedVia,
      localOrderId: decision.localOrderId,
      closureApplied: closureApplyResult,
      closureStatus,
      error: null,
    };
    items.push(item);
    opts.onItem?.(item);

    if (!dryRun) setSetting(CHECKPOINT_KEY, resourceId);
  }

  const done = lote.length === pendientes.length;
  if (!dryRun && done) {
    setSetting(LAST_RUN_KEY, String(Math.floor(Date.now() / 1000)));
    setSetting(CHECKPOINT_KEY, ""); // recorrido completo: listo para empezar de cero la próxima vez
    logIntegrationEvent(
      "dropea",
      "reconcile_completed",
      "info",
      `reconciliación completa: ${lote.length} pedido(s), ${counts.linked_by_shopify_order_id + counts.linked_by_shopify_order_number} enlazado(s) nuevo(s), ${closureApplied} cierre(s) escrito(s)`
    );
  }

  return {
    total: todos.length,
    processed: lote.length,
    counts,
    closureApplied,
    closureSkippedNoSignal,
    closureSkippedBlockedTerminal,
    items,
    done,
  };
}

export function dropeaReconcileConfigured(): boolean {
  return dropeaCredentialsPresent() && dropeaReadEnabled();
}
