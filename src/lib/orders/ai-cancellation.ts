// ============================================================
// AUTO-CANCELACIÓN POR IA (07-09-2026) — docs/AUTO-DESPACHO-COOLDOWN.md
//
// Cambio de diseño pedido por Pedro: cuando la IA de intención devuelve
// `cancelacion` con confianza ≥ AI_CANCEL_MIN_CONFIDENCE (0,85; más estricta
// que la de la FAQ, 0,75, porque aquí la acción es sobre el pedido), el
// sistema cancela el pedido solo, para el cooldown de auto-despacho, avisa a
// una persona DE INMEDIATO (para revertir rápido, no para aprobar antes) y lo
// deja todo auditado. Por debajo de 0,85 nada cambia: escalada, sin cancelar.
//
// Alcance de "cancelar" (fail-closed, sin efectos externos):
//  - eje OPERATIVO local: `orders.status` confirmed → cancelled (como ya hace
//    el resultado de una llamada, `markOrderCancelledByCall`). Ni Shopify ni
//    el proveedor se tocan: siguen siendo acciones humanas con sus gates
//    (CLAUDE.md §2, `beeping/cancel.ts`). El tag WA_CONFIRMED de Shopify no
//    se retira: el evento y la bandeja lo dejan claro.
//  - solo si el pedido NO se ha despachado todavía (cooldown no ejecutado y
//    sin marca al proveedor): si ya salió, cancelar "en local" sería mentir;
//    se escala como hasta ahora.
//  - la reversión desde el panel devuelve el pedido a `confirmed` y REINICIA
//    el cooldown desde ese momento (6 h nuevas), en vez de reanudarlo donde
//    estaba: tras un "cancelar" del cliente y una corrección humana, una
//    ventana entera es más prudente y no exige contabilizar tiempo pausado.
// ============================================================

import {
  getOrderById,
  getOrCreateConversation,
  setMode,
  systemDbHandle,
  type OrderRow,
} from "../db";
import { logIntegrationEvent } from "../system/repo";
import { sendWhatsAppMessage } from "../whatsapp";
import { autoDispatchCooldownSec, getDispatchCooldown } from "./auto-dispatch";
import { escalateOrderToHuman } from "./attention";

/** Umbral de auto-cancelación. Más estricto que INTENT_AI_MIN_CONFIDENCE (FAQ). */
export const AI_CANCEL_MIN_CONFIDENCE = 0.85;
export const AI_CANCEL_WORK_ITEM_REASON = "Cancelación automática por IA: revisar y revertir si es incorrecta";

export interface AiCancellationRow {
  id: number;
  order_id: number;
  phone: string;
  message: string;
  confidence: number;
  model: string | null;
  previous_status: string;
  cooldown_status_before: string | null;
  cooldown_due_before: number | null;
  notified_via: string;
  cancelled_at: number;
  reverted_at: number | null;
  reverted_by: string | null;
  revert_note: string | null;
}

export type AiCancellationOutcome =
  | { status: "cancelled"; row: AiCancellationRow; notified: boolean }
  | { status: "skipped"; reason: string };

export function getActiveAiCancellation(orderId: number): AiCancellationRow | null {
  return (systemDbHandle()
    .prepare("SELECT * FROM ai_cancellations WHERE order_id = ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(orderId) as AiCancellationRow | undefined) ?? null;
}

export function listAiCancellations(orderId: number): AiCancellationRow[] {
  return systemDbHandle().prepare("SELECT * FROM ai_cancellations WHERE order_id = ? ORDER BY id DESC").all(orderId) as AiCancellationRow[];
}

/** Ids de pedidos con una cancelación automática vigente (insignia del panel). */
export function listAiCancelledOrderIds(): Set<number> {
  const rows = systemDbHandle().prepare("SELECT DISTINCT order_id FROM ai_cancellations WHERE reverted_at IS NULL").all() as Array<{ order_id: number }>;
  return new Set(rows.map((r) => r.order_id));
}

function baseUrl(env: Record<string, string | undefined>): string {
  return (env.PUBLIC_BASE_URL ?? "https://agente.casamable.es").replace(/\/+$/, "");
}

/** Enlaces directos: ficha del pedido (panel) y conversación (bandeja de atención). */
export function aiCancellationLinks(orderId: number, conversationId: number, env: Record<string, string | undefined> = process.env): { order: string; conversation: string } {
  const b = baseUrl(env);
  return { order: `${b}/?order=${orderId}`, conversation: `${b}/trabajo?conversationId=${conversationId}` };
}

/**
 * Aviso inmediato a una persona. Dos vías, ambas siempre:
 *  1. work_item + modo HUMAN en la bandeja de atención (siempre funciona, sin red);
 *  2. WhatsApp a ALERT_WHATSAPP por el outbox, pasando por los safety gates
 *     (en SAFE MODE queda solo en el log, como los avisos del watchdog).
 */
export function notifyAiCancellation(order: OrderRow, input: { confidence: number; message: string }, env: Record<string, string | undefined> = process.env): { conversationId: number; whatsapp: boolean } {
  const conversationId = escalateOrderToHuman({
    order,
    reason: AI_CANCEL_WORK_ITEM_REASON,
    eventType: "ai_cancellation_notified",
    severity: "critical",
    eventMessage: `pedido cancelado automáticamente por IA (confianza ${input.confidence.toFixed(2)}); aviso a persona para revisar y revertir si es incorrecto`,
  });
  const links = aiCancellationLinks(order.id, conversationId, env);
  const text =
    `Pedido #${order.shopify_order_number} cancelado automáticamente por IA (confianza ${input.confidence.toFixed(2)}). ` +
    `Revisar y revertir si es incorrecto.\n` +
    `Cliente: ${order.customer_name ?? "—"} (+${order.phone})\n` +
    `Mensaje: «${input.message.slice(0, 160)}»\n` +
    `Pedido: ${links.order}\n` +
    `Conversación: ${links.conversation}`;
  const alertPhone = (env.ALERT_WHATSAPP ?? "").replace(/\D/g, "");
  let whatsapp = false;
  if (alertPhone) {
    try {
      whatsapp = sendWhatsAppMessage(alertPhone, text, { name: "Alertas Casamable" });
    } catch {
      whatsapp = false;
    }
  }
  if (!whatsapp) {
    logIntegrationEvent("whatsapp", "ai_cancellation_alert_not_sent", "warning", alertPhone ? "aviso por WhatsApp retenido por los gates (queda la bandeja de atención)" : "sin ALERT_WHATSAPP: el aviso queda solo en la bandeja de atención", order.shopify_order_number);
  }
  return { conversationId, whatsapp };
}

/**
 * Cancela el pedido de forma automática. Idempotente por pedido (una
 * cancelación vigente): repetir no duplica ni notifica dos veces.
 */
export function cancelOrderByAi(
  order: OrderRow,
  input: { message: string; confidence: number; model: string | null },
  deps: { env?: Record<string, string | undefined>; nowSec?: number } = {}
): AiCancellationOutcome {
  const env = deps.env ?? process.env;
  const now = deps.nowSec ?? Math.floor(Date.now() / 1000);
  if (input.confidence < AI_CANCEL_MIN_CONFIDENCE) return { status: "skipped", reason: `confianza ${input.confidence.toFixed(2)} < ${AI_CANCEL_MIN_CONFIDENCE}` };
  const fresh = getOrderById(order.id);
  if (!fresh) return { status: "skipped", reason: "pedido inexistente" };
  if (getActiveAiCancellation(fresh.id)) return { status: "skipped", reason: "ya cancelado automáticamente" };
  if (fresh.status !== "confirmed") return { status: "skipped", reason: `el pedido no está confirmado (estado ${fresh.status})` };
  if (fresh.closure_status === "delivered" || fresh.closure_status === "refused" || fresh.closure_status === "cancelled") {
    return { status: "skipped", reason: `el pedido ya está cerrado (${fresh.closure_status})` };
  }
  const cooldown = getDispatchCooldown(fresh.id);
  if (cooldown?.status === "executed") return { status: "skipped", reason: "el pedido ya se despachó: cancelar exige gestión humana con el proveedor" };
  if (fresh.supplier_sync_status === "syncing" || fresh.supplier_sync_status === "synced") {
    return { status: "skipped", reason: `el pedido ya está en el proveedor (${fresh.supplier_sync_status}): cancelar exige gestión humana` };
  }

  const db = systemDbHandle();
  const row = db.transaction(() => {
    db.prepare(
      `UPDATE orders SET status = 'cancelled', cancellation_requested_at = COALESCE(cancellation_requested_at, ?), updated_at = unixepoch()
       WHERE id = ? AND status = 'confirmed'`
    ).run(now, fresh.id);
    if (cooldown && cooldown.status === "scheduled") {
      db.prepare("UPDATE dispatch_cooldowns SET status = 'cancelled', evaluated_at = ?, outcome = ? WHERE order_id = ?")
        .run(now, `cancelado automáticamente por IA (confianza ${input.confidence.toFixed(2)})`, fresh.id);
    }
    const r = db.prepare(
      `INSERT INTO ai_cancellations (order_id, phone, message, confidence, model, previous_status, cooldown_status_before, cooldown_due_before, notified_via, cancelled_at)
       VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, 'pending', ?)`
    ).run(fresh.id, fresh.phone, input.message.slice(0, 2000), input.confidence, input.model, cooldown?.status ?? null, cooldown?.due_at ?? null, now);
    return db.prepare("SELECT * FROM ai_cancellations WHERE id = ?").get(r.lastInsertRowid) as AiCancellationRow;
  })();

  logIntegrationEvent(
    "whatsapp",
    "ai_cancellation_executed",
    "critical",
    `pedido cancelado automáticamente por IA (confianza ${input.confidence.toFixed(2)}, ${input.model ?? "modelo n/a"}); cooldown ${cooldown ? `${cooldown.status} → cancelled` : "sin cooldown"}; Shopify y proveedor sin tocar`,
    fresh.shopify_order_number
  );
  const notified = notifyAiCancellation(fresh, { confidence: input.confidence, message: input.message }, env);
  db.prepare("UPDATE ai_cancellations SET notified_via = ? WHERE id = ?").run(notified.whatsapp ? "work_item+whatsapp" : "work_item", row.id);
  return { status: "cancelled", row: { ...row, notified_via: notified.whatsapp ? "work_item+whatsapp" : "work_item" }, notified: notified.whatsapp };
}

export type RevertOutcome =
  | { status: "reverted"; cooldown: "restarted" | "none"; dueAt: number | null }
  | { status: "rejected"; reason: string };

/**
 * Reversión desde el panel: pedido de vuelta a `confirmed`, solicitud de
 * cancelación borrada, work_item cerrado y cooldown REINICIADO (si el
 * cooldown está activo por env). La conversación sigue en HUMAN: la persona
 * que revierte ya está atendiéndola; devolverla al bot es su decisión.
 */
export function revertAiCancellation(
  orderId: number,
  by: string,
  note: string | null = null,
  deps: { env?: Record<string, string | undefined>; nowSec?: number } = {}
): RevertOutcome {
  const env = deps.env ?? process.env;
  const now = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const active = getActiveAiCancellation(orderId);
  if (!active) return { status: "rejected", reason: "este pedido no tiene una cancelación automática vigente" };
  const order = getOrderById(orderId);
  if (!order) return { status: "rejected", reason: "pedido inexistente" };
  if (order.status !== "cancelled") return { status: "rejected", reason: `el pedido ya no está cancelado (estado ${order.status})` };
  if (order.closure_status === "cancelled") return { status: "rejected", reason: "el pedido está cancelado en Shopify: revertir ahí primero" };

  const db = systemDbHandle();
  const restart = env.AUTO_DISPATCH_COOLDOWN_ENABLED === "1";
  const cooldown: "restarted" | "none" = restart ? "restarted" : "none";
  const dueAt: number | null = restart ? now + autoDispatchCooldownSec(env) : null;
  db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'confirmed', cancellation_requested_at = NULL, updated_at = unixepoch() WHERE id = ? AND status = 'cancelled'").run(orderId);
    db.prepare("UPDATE ai_cancellations SET reverted_at = ?, reverted_by = ?, revert_note = ? WHERE id = ?").run(now, by.slice(0, 120), note ? note.slice(0, 500) : null, active.id);
    db.prepare("UPDATE work_items SET resolved_at = ?, resolution_note = ? WHERE order_id = ? AND reason = ? AND resolved_at IS NULL")
      .run(now, `cancelación automática revertida por ${by}`.slice(0, 300), orderId, AI_CANCEL_WORK_ITEM_REASON);
    if (restart) {
      db.prepare(
        `INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at) VALUES (?, 'scheduled', ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET status = 'scheduled', scheduled_at = excluded.scheduled_at, due_at = excluded.due_at,
           evaluated_at = NULL, executed_at = NULL, executed_via = NULL, blocked_reason = NULL, outcome = 'reiniciado tras revertir cancelación automática'`
      ).run(orderId, now, dueAt);
    }
  })();
  // La conversación queda tal cual (HUMAN): quien revierte ya la está atendiendo.
  const convo = getOrCreateConversation(order.phone, order.customer_name ?? undefined);
  if (convo.mode !== "HUMAN") setMode(convo.id, "HUMAN");
  logIntegrationEvent(
    "whatsapp",
    "ai_cancellation_reverted",
    "warning",
    `cancelación automática revertida por ${by}${note ? `: ${note.slice(0, 120)}` : ""}; pedido de nuevo confirmado; cooldown ${cooldown === "restarted" ? `reiniciado (vence ${new Date((dueAt ?? 0) * 1000).toISOString()})` : "no activo por env"}`,
    order.shopify_order_number
  );
  return { status: "reverted", cooldown, dueAt };
}
