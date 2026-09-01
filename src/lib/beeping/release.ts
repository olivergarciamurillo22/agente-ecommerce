// ============================================================
// LIBERAR UN PEDIDO A BEEPING (mark-to-send) — la función central.
//
// Dos estados que NUNCA se confunden:
//   · CONFIRMADO POR EL CLIENTE  → orders.status = 'confirmed'
//   · LIBERADO A BEEPING         → orders.beeping_sync_status = 'released'
//
// El gate exige TODAS las condiciones; si falla una, no se envía nada y
// Pedro ve EXACTAMENTE por qué. La idempotencia la da el claim atómico de
// repo.ts (un doble clic no puede liberar dos veces) y un timeout ambiguo
// jamás se reintenta a ciegas: se consulta Beeping por external_id.
//
// MODO MANUAL PRIMERO: la liberación la dispara Pedro desde la ficha.
// autoReleaseIfEnabled existe para el día del piloto real
// (BEEPING_AUTO_RELEASE_CONFIRMED=1) y hoy es un no-op.
// ============================================================

import { getOrderById, isActionResolved, type OrderRow } from "../db";
import { lineItemsFromPayload } from "../orders/line-items";
import { emergencyStop } from "../safety";
import { logIntegrationEvent } from "../system/repo";
import {
  BeepingAmbiguousWriteError,
  findOrderByExternalId,
  markToSend,
} from "./client";
import { beepingAutoReleaseEnabled, beepingEnabled, beepingWriteEnabled } from "./config";
import {
  claimBeepingRelease,
  listAmbiguousBeepingReleases,
  listOrdersAwaitingBeepingRelease,
  markBeepingReleased,
  markBeepingReleaseFailed,
  markBeepingReleaseUnknown,
  resolveBeepingReleaseUnknown,
  updateBeepingSnapshot,
} from "./repo";
import type { BeepingOrder } from "./types";

export interface ReleaseGate {
  ok: boolean;
  /** Motivos por los que NO se puede liberar, en cristiano, para el panel. */
  reasons: string[];
}

/** Dependencias inyectables (tests y simulación corren sin red). */
export interface ReleaseDeps {
  findOrder: (externalId: string) => Promise<BeepingOrder | null>;
  markToSend: (externalId: string) => Promise<unknown>;
}

const defaultDeps: ReleaseDeps = { findOrder: findOrderByExternalId, markToSend };

/**
 * Gate LOCAL: todo lo comprobable sin llamar a Beeping.
 * Se evalúa también para pintar el CTA de la ficha (por eso no lanza).
 */
export function evaluateLocalReleaseGate(order: OrderRow): ReleaseGate {
  const reasons: string[] = [];

  if (order.status !== "confirmed") {
    reasons.push("el cliente todavía no ha confirmado el pedido");
  }
  if (order.cancellation_requested_at && !isActionResolved(order.id, "CANCEL_REQUEST")) {
    reasons.push("hay una solicitud de cancelación del cliente sin resolver");
  }
  if (order.closure_status === "cancelled") {
    reasons.push("el pedido está cancelado en Shopify");
  }
  if (order.closure_status === "delivered" || order.closure_status === "refused") {
    reasons.push(`el pedido ya está cerrado (${order.closure_status})`);
  }
  if (order.possible_duplicate === 1 && !isActionResolved(order.id, "POSSIBLE_DUPLICATE")) {
    reasons.push("posible duplicado sin resolver en Acciones");
  }
  const city = (order.city ?? "").trim();
  if (!(order.address_line1 ?? "").trim() || !city || city === "-" || !(order.postal_code ?? "").trim()) {
    reasons.push("dirección incompleta (calle, localidad y código postal son obligatorios)");
  }
  if (!(order.phone ?? "").trim()) {
    reasons.push("el pedido no tiene teléfono");
  }

  // Productos físicos con SKU. Fail-closed: hasta que Beeping confirme con
  // qué identificador resuelve el producto (sga_product_id/sku/barcode),
  // liberar líneas sin SKU podría preparar el producto equivocado.
  let fisicos = 0;
  let sinSku = 0;
  try {
    const items = order.raw_payload ? lineItemsFromPayload(JSON.parse(order.raw_payload)).filter((i) => !i.isService) : [];
    fisicos = items.length;
    sinSku = items.filter((i) => !(i.sku ?? "").trim()).length;
  } catch {
    fisicos = 0;
  }
  if (fisicos === 0) {
    reasons.push("el pedido no tiene líneas de producto físico legibles");
  } else if (sinSku > 0) {
    reasons.push(`${sinSku} línea(s) de producto sin SKU (Beeping necesita identificar el producto)`);
  }

  if (!beepingEnabled()) {
    reasons.push("la integración con Beeping está desactivada (BEEPING_ENABLED)");
  } else if (!beepingWriteEnabled()) {
    reasons.push("las escrituras a Beeping están desactivadas (BEEPING_WRITE_ENABLED)");
  }
  if (emergencyStop()) {
    reasons.push("EMERGENCY_STOP activo: ninguna acción externa puede salir");
  }

  return { ok: reasons.length === 0, reasons };
}

/** Gate REMOTO: el pedido debe existir en Beeping y estar reteniéndose. */
export function evaluateRemoteReleaseGate(remote: BeepingOrder | null): ReleaseGate & {
  alreadyReleased: boolean;
} {
  if (!remote) {
    return {
      ok: false,
      alreadyReleased: false,
      reasons: [
        "el pedido no aparece en Beeping (¿la app de Shopify lo ha importado ya? puede tardar unos minutos)",
      ],
    };
  }
  // 6 = To be confirmed: el estado que retiene el pedido y el ÚNICO desde el
  // que el contrato conocido permite liberar. 1/2/3/4 significan que YA está
  // liberado (por nosotros antes, o a mano en el panel de Beeping).
  if (remote.status === 6) return { ok: true, alreadyReleased: false, reasons: [] };
  if (remote.status === 1 || remote.status === 2 || remote.status === 3 || remote.status === 4) {
    return { ok: false, alreadyReleased: true, reasons: [`el pedido ya está liberado en Beeping (status ${remote.status})`] };
  }
  return {
    ok: false,
    alreadyReleased: false,
    reasons: [`el pedido está en un estado de Beeping que no admite liberación (status ${remote.status ?? "desconocido"})`],
  };
}

export type ReleaseOutcome =
  | { outcome: "released"; alreadyReleased: boolean }
  | { outcome: "blocked"; reasons: string[] }
  | { outcome: "claim_lost" }
  | { outcome: "failed"; error: string }
  | { outcome: "ambiguous"; error: string };

/**
 * Libera un pedido a Beeping, con todas las garantías. `actor` identifica
 * quién lo pidió ("pedro" desde el panel, "auto" el día del auto-release).
 */
export async function releaseOrderToBeeping(
  orderId: number,
  actor: string,
  deps: ReleaseDeps = defaultDeps
): Promise<ReleaseOutcome> {
  const order = getOrderById(orderId);
  if (!order) return { outcome: "blocked", reasons: ["pedido inexistente"] };

  const gate = evaluateLocalReleaseGate(order);
  if (!gate.ok) return { outcome: "blocked", reasons: gate.reasons };

  // Claim atómico: de dos dobles clics, exactamente uno pasa de aquí.
  if (!claimBeepingRelease(orderId, actor)) return { outcome: "claim_lost" };

  // Consultar Beeping ANTES de escribir (y re-verificar el estado remoto).
  let remote: BeepingOrder | null;
  try {
    remote = await deps.findOrder(order.shopify_order_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error consultando Beeping";
    markBeepingReleaseFailed(orderId, `no se pudo consultar el pedido en Beeping: ${msg}`, actor);
    return { outcome: "failed", error: msg };
  }

  if (remote) updateBeepingSnapshot(orderId, { orderStatus: remote.status, externalId: remote.external_id });

  const remoteGate = evaluateRemoteReleaseGate(remote);
  if (remoteGate.alreadyReleased && remote) {
    // Idempotencia con el mundo real: ya estaba liberado → nuestro estado
    // local se alinea, sin llamar a mark-to-send otra vez.
    markBeepingReleased(orderId, remote.external_id, actor);
    return { outcome: "released", alreadyReleased: true };
  }
  if (!remoteGate.ok) {
    markBeepingReleaseFailed(orderId, remoteGate.reasons.join(" · "), actor);
    return { outcome: "blocked", reasons: remoteGate.reasons };
  }

  try {
    await deps.markToSend(order.shopify_order_id);
  } catch (err) {
    if (err instanceof BeepingAmbiguousWriteError) {
      markBeepingReleaseUnknown(orderId, err.message, actor);
      return { outcome: "ambiguous", error: err.message };
    }
    const msg = err instanceof Error ? err.message : "error de Beeping";
    markBeepingReleaseFailed(orderId, msg, actor);
    return { outcome: "failed", error: msg };
  }

  markBeepingReleased(orderId, remote!.external_id, actor);
  return { outcome: "released", alreadyReleased: false };
}

/**
 * Resuelve una liberación AMBIGUA consultando Beeping: si el pedido salió
 * de "To be confirmed", el mark-to-send llegó; si sigue en 6, no llegó.
 */
export async function resolveAmbiguousRelease(
  orderId: number,
  actor: string,
  deps: ReleaseDeps = defaultDeps
): Promise<"released" | "not_released" | "unresolved"> {
  const order = getOrderById(orderId);
  if (!order || order.beeping_sync_status !== "release_unknown") return "unresolved";
  let remote: BeepingOrder | null;
  try {
    remote = await deps.findOrder(order.shopify_order_id);
  } catch {
    return "unresolved"; // sin respuesta: sigue ambiguo, se reintenta después
  }
  if (remote && remote.status !== null && remote.status !== 6) {
    resolveBeepingReleaseUnknown(orderId, "released", remote.external_id, actor);
    return "released";
  }
  if (remote && remote.status === 6) {
    resolveBeepingReleaseUnknown(orderId, "not_released", remote.external_id, actor);
    return "not_released";
  }
  return "unresolved";
}

/**
 * Auto-release al confirmar (FUTURO, §piloto): recorre los confirmados
 * pendientes y los libera. Hoy BEEPING_AUTO_RELEASE_CONFIRMED=0 → no-op.
 * Lo llama el scheduler de Beeping, NO la máquina de confirmación: así el
 * flag se puede encender sin tocar código maduro.
 */
export async function autoReleasePendingConfirmed(deps: ReleaseDeps = defaultDeps): Promise<number> {
  if (!beepingAutoReleaseEnabled()) return 0;
  let liberados = 0;
  for (const order of listOrdersAwaitingBeepingRelease()) {
    const res = await releaseOrderToBeeping(order.id, "auto", deps);
    if (res.outcome === "released") liberados++;
  }
  if (liberados > 0) {
    logIntegrationEvent("beeping", "auto_release", "info", `${liberados} pedido(s) liberados automáticamente al confirmar`);
  }
  return liberados;
}

/** Reintenta resolver TODAS las liberaciones ambiguas (scheduler/doctor). */
export async function resolveAllAmbiguousReleases(deps: ReleaseDeps = defaultDeps): Promise<number> {
  let resueltas = 0;
  for (const order of listAmbiguousBeepingReleases()) {
    if ((await resolveAmbiguousRelease(order.id, "system", deps)) !== "unresolved") resueltas++;
  }
  return resueltas;
}
