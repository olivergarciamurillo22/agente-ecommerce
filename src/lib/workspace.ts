import { systemDbHandle, type OrderRow } from "./db";
import type { AuthPrincipal } from "./auth/guard";

export type AuditAction = "take_over" | "return_to_bot" | "send_message" | "correct_address" | "delivery_note" | "resolve" | "escalate" | "resend_confirmation";

export function audit(user: AuthPrincipal, action: AuditAction, subjectType: string, subjectId: string | number, detail?: unknown): void {
  systemDbHandle().prepare(
    `INSERT INTO audit_log (user_id, user_name, action, subject_type, subject_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.name, action, subjectType, String(subjectId), detail === undefined ? null : JSON.stringify(detail));
}

export function safeOrder(order: OrderRow | null) {
  if (!order) return null;
  return {
    id: order.id,
    orderNumber: order.shopify_order_number,
    customerName: order.customer_name,
    status: order.status,
    product: order.product_summary,
    units: quantities(order.raw_payload),
    amount: order.total_price,
    currency: order.currency,
    address: [order.address_line1, order.address_line2].filter(Boolean).join(", "),
    city: order.city,
    postalCode: order.postal_code,
    carrier: order.carrier,
    trackingNumber: order.tracking_number,
    orderedAt: order.ordered_at ?? order.created_at,
    proposedAddress: order.proposed_address,
    deliveryNote: order.delivery_note,
  };
}

function quantities(raw: string | null): number | null {
  try {
    const parsed = JSON.parse(raw ?? "{}") as { line_items?: Array<{ quantity?: number }> };
    return parsed.line_items?.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0) ?? null;
  } catch { return null; }
}

export function listAudit(filters: { userId?: number; from?: number; to?: number }) {
  const clauses: string[] = [];
  const args: number[] = [];
  if (filters.userId) { clauses.push("user_id = ?"); args.push(filters.userId); }
  if (filters.from) { clauses.push("created_at >= ?"); args.push(filters.from); }
  if (filters.to) { clauses.push("created_at < ?"); args.push(filters.to); }
  return systemDbHandle().prepare(
    `SELECT id, user_id, user_name, action, subject_type, subject_id, detail, created_at
       FROM audit_log ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT 500`
  ).all(...args);
}
