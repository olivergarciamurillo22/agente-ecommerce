// ============================================================
// Cancelación en Beeping — SIEMPRE una decisión humana.
//
// Que el cliente pida cancelar NO cancela nada: genera el elemento
// "Cliente solicita cancelar" en Acciones y Pedro decide. Esta pieza es el
// brazo ejecutor de esa decisión: consulta el estado ANTES de escribir y
// solo permite cancelar en los estados que el contrato conocido admite
// (Pending, Pending Stock, To be confirmed).
// ============================================================

import { getOrderById } from "../db";
import { logIntegrationEvent } from "../system/repo";
import { BeepingAmbiguousWriteError, cancelOrder, findOrderByExternalId } from "./client";
import { beepingWriteEnabled } from "./config";
import { updateBeepingSnapshot } from "./repo";
import type { BeepingOrder } from "./types";

/** Estados de Beeping desde los que el contrato conocido admite cancelar. */
const CANCELLABLE_STATUSES = new Set([1, 2, 6]);

export interface BeepingCancelDeps {
  findOrder: (externalId: string) => Promise<BeepingOrder | null>;
  cancelOrder: (externalId: string) => Promise<unknown>;
}

const defaultDeps: BeepingCancelDeps = { findOrder: findOrderByExternalId, cancelOrder };

export type BeepingCancelOutcome =
  | { outcome: "cancelled" }
  | { outcome: "blocked"; reason: string }
  | { outcome: "failed"; error: string }
  | { outcome: "ambiguous"; error: string };

/**
 * Cancela el pedido EN BEEPING, tras verificar estado remoto. No toca el
 * eje de cierre local: eso lo hará la reconciliación al ver el 0/7 de
 * Beeping (o el webhook de Shopify si la cancelación viene de allí).
 */
export async function cancelOrderInBeeping(
  orderId: number,
  actor: string,
  deps: BeepingCancelDeps = defaultDeps
): Promise<BeepingCancelOutcome> {
  const order = getOrderById(orderId);
  if (!order) return { outcome: "blocked", reason: "pedido inexistente" };
  if (!beepingWriteEnabled()) {
    return { outcome: "blocked", reason: "las escrituras a Beeping están desactivadas (BEEPING_WRITE_ENABLED)" };
  }

  let remote: BeepingOrder | null;
  try {
    remote = await deps.findOrder(order.shopify_order_id);
  } catch (err) {
    return { outcome: "failed", error: err instanceof Error ? err.message : "no se pudo consultar Beeping" };
  }
  if (!remote) return { outcome: "blocked", reason: "el pedido no aparece en Beeping" };
  updateBeepingSnapshot(orderId, { orderStatus: remote.status, externalId: remote.external_id });

  if (remote.status === 0) return { outcome: "cancelled" }; // ya estaba
  if (remote.status === null || !CANCELLABLE_STATUSES.has(remote.status)) {
    return {
      outcome: "blocked",
      reason: `Beeping solo admite cancelar en Pending/Pending Stock/To be confirmed (está en status ${remote.status ?? "desconocido"}); si ya está preparado o enviado, gestionar con Beeping directamente`,
    };
  }

  try {
    await deps.cancelOrder(order.shopify_order_id);
  } catch (err) {
    if (err instanceof BeepingAmbiguousWriteError) {
      logIntegrationEvent("beeping", "cancel_ambiguous", "warning", "cancelación sin respuesta: consultar antes de repetir", order.shopify_order_number);
      return { outcome: "ambiguous", error: err.message };
    }
    return { outcome: "failed", error: err instanceof Error ? err.message : "error de Beeping" };
  }

  updateBeepingSnapshot(orderId, { orderStatus: 0, externalId: remote.external_id });
  logIntegrationEvent("beeping", "order_cancelled", "info", `pedido cancelado en Beeping por ${actor}`, order.shopify_order_number);
  return { outcome: "cancelled" };
}
