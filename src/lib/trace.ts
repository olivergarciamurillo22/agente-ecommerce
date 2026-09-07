import { getOrderTimeline } from "./system/followup";
import { systemDbHandle } from "./db";

export interface TraceEvent { at: number; source: string; label: string; detail: string | null }
export interface OrderTrace {
  order: { number: string; status: string; customer: string | null; phone: string; location: string | null };
  events: TraceEvent[];
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `···${digits.slice(-3)}` : "—";
}

export function initial(name: string | null): string | null {
  const value = (name ?? "").trim();
  return value ? `${value[0].toLocaleUpperCase("es-ES")}.` : null;
}

export function buildOrderTrace(orderNumber: string, revealPii = false): OrderTrace | null {
  const db = systemDbHandle();
  const normalized = orderNumber.trim().replace(/^#/, "");
  const order = db.prepare("SELECT * FROM orders WHERE REPLACE(shopify_order_number,'#','')=? ORDER BY id DESC LIMIT 1").get(normalized) as Record<string, unknown> | undefined;
  if (!order) return null;
  const orderId = Number(order.id);
  const phone = String(order.phone ?? "");
  const events: TraceEvent[] = getOrderTimeline(orderId).events.map((event) => ({
    ...event, source: "pedido", detail: revealPii ? event.detail : null,
  }));
  const push = (at: unknown, source: string, label: string, detail: unknown = null) => {
    const timestamp = Number(at);
    if (timestamp > 0) events.push({ at: timestamp, source, label, detail: detail == null ? null : String(detail) });
  };

  const conversation = db.prepare("SELECT id FROM conversations WHERE phone=? LIMIT 1").get(phone) as { id: number } | undefined;
  if (conversation) {
    const messages = db.prepare("SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,id").all(conversation.id) as Array<{ role: string; content: string; created_at: number }>;
    for (const message of messages) push(message.created_at, "conversación", `Mensaje ${message.role}`, revealPii ? message.content : "[contenido oculto por PII]");
    const outbox = db.prepare("SELECT sent,message_type,template_name,content,created_at,sent_at,failed_at,failure_reason FROM outbox WHERE conversation_id=? ORDER BY created_at,id").all(conversation.id) as Array<Record<string, unknown>>;
    for (const item of outbox) {
      const state = item.failed_at ? `fallido: ${item.failure_reason ?? "sin detalle"}` : item.sent ? "enviado" : "pendiente";
      const kind = item.template_name ?? item.message_type ?? "mensaje";
      push(item.sent_at ?? item.created_at, "outbox", `${kind} · ${state}`, revealPii ? item.content : null);
    }
  }
  const refs = [String(order.shopify_order_number ?? ""), normalized, `#${normalized}`];
  const integration = db.prepare("SELECT integration,event_type,severity,message,created_at FROM integration_events WHERE order_ref IN (?,?,?) ORDER BY created_at,id").all(...refs) as Array<Record<string, unknown>>;
  for (const event of integration) push(event.created_at, "integración", `${event.integration}/${event.event_type} · ${event.severity}`, event.message);
  events.sort((a, b) => a.at - b.at || a.source.localeCompare(b.source));
  return {
    order: {
      number: String(order.shopify_order_number), status: String(order.status),
      customer: revealPii ? String(order.customer_name ?? "") || null : initial(String(order.customer_name ?? "") || null),
      phone: revealPii ? phone : maskPhone(phone),
      location: revealPii ? [order.address_line1, order.address_line2, order.city, order.postal_code].filter(Boolean).join(", ") : String(order.city ?? "") || null,
    },
    events,
  };
}
