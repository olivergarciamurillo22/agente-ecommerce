// ============================================================
// SEGUIMIENTO (§8): la vista operativa orientada al PEDIDO — no es un
// clon de WhatsApp Web. Agrupa por lo que hay que hacer, con la antigüedad
// desde el ÚLTIMO contacto, y construye una línea temporal por pedido a
// partir de lo que ya sabe la base (fechas del pedido, histórico de
// estados, intentos de llamada). READ-ONLY.
// ============================================================

import { getOrderById, listCallAttemptsForOrder, listOrderStatusHistory, systemDbHandle, type OrderRow } from "../db";

export type FollowUpBucket =
  | "awaiting_reply"
  | "confirmed"
  | "corrections"
  | "delivery_notes"
  | "needs_call"
  | "errors";

export interface FollowUpItem {
  id: number;
  orderNumber: string;
  customer: string | null;
  /** Teléfono ENMASCARADO (···1234): la PII completa vive en la ficha. */
  phoneMasked: string;
  product: string;
  totalPrice: string;
  status: string;
  bucket: FollowUpBucket;
  /** Último contacto (epoch s): respuesta del cliente, o último envío nuestro. */
  lastContactAt: number | null;
  /** Segundos desde el último contacto (para "hace X"). */
  ageSeconds: number | null;
  needsCallAt: number | null;
  confirmedAt: number | null;
  proposedAddress: string | null;
  deliveryNote: string | null;
  cancellationRequested: boolean;
}

export interface FollowUpOverview {
  generatedAt: number;
  counts: Record<FollowUpBucket, number>;
  items: FollowUpItem[];
}

function mask(phone: string): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `···${d.slice(-4)}` : "···";
}

function bucketOf(o: OrderRow): FollowUpBucket | null {
  if (o.status === "error") return "errors";
  if (o.status === "needs_call") return "needs_call";
  if (o.status === "needs_correction") return "corrections";
  if (o.status === "awaiting_delivery_note") return "delivery_notes";
  if (o.status === "confirmed") return "confirmed";
  if (["pending_send", "awaiting_reply", "reminder_sent"].includes(o.status)) return "awaiting_reply";
  return null;
}

export function getFollowUpOverview(nowS = Math.floor(Date.now() / 1000)): FollowUpOverview {
  const rows = systemDbHandle()
    .prepare(
      `SELECT * FROM orders
       WHERE status IN ('pending_send','awaiting_reply','reminder_sent','awaiting_delivery_note','needs_correction','needs_call','confirmed','error')
         AND closure_status IN ('unknown','in_progress')
         AND shopify_order_id NOT LIKE 'TEST-%'
       ORDER BY COALESCE(customer_replied_at, reminder_sent_at, whatsapp_sent_at, created_at) ASC
       LIMIT 400`
    )
    .all() as OrderRow[];

  const counts: Record<FollowUpBucket, number> = { awaiting_reply: 0, confirmed: 0, corrections: 0, delivery_notes: 0, needs_call: 0, errors: 0 };
  const items: FollowUpItem[] = [];
  for (const o of rows) {
    const bucket = bucketOf(o);
    if (!bucket) continue;
    // Confirmados: solo los de las últimas 48 h (los demás ya son fulfillment, no seguimiento).
    if (bucket === "confirmed" && (o.confirmed_at ?? 0) < nowS - 48 * 3600) continue;
    counts[bucket]++;
    const lastContact = o.customer_replied_at ?? o.reminder_sent_at ?? o.whatsapp_sent_at ?? null;
    items.push({
      id: o.id,
      orderNumber: o.shopify_order_number,
      customer: o.customer_name,
      phoneMasked: mask(o.phone),
      product: o.product_summary,
      totalPrice: o.total_price,
      status: o.status,
      bucket,
      lastContactAt: lastContact,
      ageSeconds: lastContact ? nowS - lastContact : null,
      needsCallAt: o.needs_call_at,
      confirmedAt: o.confirmed_at,
      proposedAddress: o.proposed_address,
      deliveryNote: o.delivery_note,
      cancellationRequested: o.cancellation_requested_at !== null,
    });
  }
  return { generatedAt: nowS, counts, items };
}

export interface TimelineEvent {
  at: number;
  kind:
    | "order_received"
    | "whatsapp_prepared"
    | "message_sent"
    | "reminder_sent"
    | "reply_received"
    | "address_corrected"
    | "note_added"
    | "confirmed"
    | "escalated"
    | "call"
    | "call_result"
    | "status";
  label: string;
  detail: string | null;
}

/** Línea temporal de un pedido: solo hechos con fecha (nunca inventados). */
export function getOrderTimeline(orderId: number): { order: { id: number; orderNumber: string; status: string } | null; events: TimelineEvent[] } {
  const o = getOrderById(orderId);
  if (!o) return { order: null, events: [] };
  const ev: TimelineEvent[] = [];
  const push = (at: number | null, kind: TimelineEvent["kind"], label: string, detail: string | null = null) => {
    if (at) ev.push({ at, kind, label, detail });
  };
  push(o.ordered_at ?? o.created_at, "order_received", "Pedido recibido", o.product_summary);
  if (o.deferred_until && !o.whatsapp_sent_at) push(o.created_at, "whatsapp_prepared", "WhatsApp preparado", "esperando ventana horaria");
  push(o.whatsapp_sent_at, "message_sent", "Mensaje de confirmación enviado");
  push(o.reminder_sent_at, "reminder_sent", "Recordatorio enviado");
  push(o.customer_replied_at, "reply_received", "Respuesta del cliente");
  if (o.proposed_address) push(o.customer_replied_at ?? o.updated_at, "address_corrected", "Dirección propuesta por el cliente", o.proposed_address);
  if (o.delivery_note) push(o.customer_replied_at ?? o.updated_at, "note_added", "Nota para el repartidor", o.delivery_note);
  push(o.confirmed_at, "confirmed", "Pedido confirmado");
  push(o.needs_call_at, "escalated", "Escalado a llamada", "sin respuesta por WhatsApp");
  push(o.cancellation_requested_at, "status", "El cliente pide cancelar", "pendiente de decisión");

  for (const c of listCallAttemptsForOrder(o.id)) {
    push(c.started_at ?? c.scheduled_at, "call", `Llamada (intento ${c.contact_number})`, c.state);
    if (c.result) push(c.ended_at ?? c.updated_at, "call_result", "Resultado de la llamada", c.result);
  }
  for (const h of listOrderStatusHistory(o.id)) {
    if (h.status_axis === "tracking" || h.status_axis === "closure") {
      push(h.occurred_at, "status", `${h.status_axis === "closure" ? "Cierre" : "Envío"}: ${h.new_status}`, h.raw_status);
    }
  }
  ev.sort((a, b) => a.at - b.at);
  return { order: { id: o.id, orderNumber: o.shopify_order_number, status: o.status }, events: ev };
}
