import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth/guard";
import { getMessages, getOrderById, listOrderStatusHistory, systemDbHandle } from "@/lib/db";
import { safeOrder } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = requireStaff(req); if (!auth.ok) return auth.response;
  const rows = systemDbHandle().prepare(`
    SELECT c.id, c.name, c.mode, c.last_message_at, c.phone,
      (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last_message,
      (SELECT reason FROM work_items w
        WHERE w.conversation_id=c.id AND w.owner_only=0 AND w.resolved_at IS NULL
        ORDER BY CASE WHEN w.reason='Posible cancelación' THEN 0 WHEN w.reason='Dirección sospechosa' THEN 1 ELSE 2 END,
                 w.created_at DESC, w.id DESC LIMIT 1) attention_reason,
      (SELECT id FROM orders o WHERE o.phone=c.phone ORDER BY o.created_at DESC LIMIT 1) order_id,
      (SELECT shopify_order_number FROM orders o WHERE o.phone=c.phone ORDER BY o.created_at DESC LIMIT 1) order_number,
      (SELECT status FROM orders o WHERE o.phone=c.phone ORDER BY o.created_at DESC LIMIT 1) order_status
    FROM conversations c
    WHERE NOT EXISTS (SELECT 1 FROM work_items w WHERE w.conversation_id=c.id AND w.owner_only=0 AND w.resolved_at IS NOT NULL)
    ORDER BY CASE
      WHEN EXISTS (SELECT 1 FROM work_items w WHERE w.conversation_id=c.id AND w.reason='Posible cancelación' AND w.resolved_at IS NULL) THEN 0
      WHEN EXISTS (SELECT 1 FROM work_items w WHERE w.conversation_id=c.id AND w.reason='Dirección sospechosa' AND w.resolved_at IS NULL) THEN 1
      WHEN c.mode='HUMAN' THEN 2 ELSE 3 END,
      COALESCE(c.last_message_at,c.created_at) ASC`).all() as Array<{
      id:number; name:string|null; mode:string; last_message_at:number|null; phone:string;
      last_message:string|null; attention_reason:string|null; order_id:number|null; order_number:string|null; order_status:string|null;
    }>;
  const items = rows.map((row) => ({
    ...row,
    waitingMinutes: Math.max(0, Math.floor((Date.now() / 1000 - Number(row.last_message_at ?? 0)) / 60)),
    reason: row.attention_reason ?? reasonFor(String(row.order_status ?? "")),
  }));
  const selected = Number(req.nextUrl.searchParams.get("conversationId") ?? items[0]?.id ?? 0);
  const item = items.find((candidate) => Number(candidate.id) === selected);
  const orderId = Number(item?.order_id ?? 0);
  return NextResponse.json({
    items,
    selected: selected ? {
      conversationId: selected,
      messages: getMessages(selected, 200),
      order: safeOrder(orderId ? getOrderById(orderId) : null),
      history: orderId ? listOrderStatusHistory(orderId) : [],
      windowOpen: isWindowOpen(selected),
    } : null,
  });
}

function reasonFor(status: string) {
  if (status === "needs_correction") return "dirección nueva";
  if (status === "cancelled") return "pide cancelar";
  if (["error", "needs_call"].includes(status)) return "incidencia de envío";
  if (status === "awaiting_delivery_note") return "no entiende";
  return "sin clasificar";
}

function isWindowOpen(conversationId: number): boolean {
  const row = systemDbHandle().prepare(
    "SELECT created_at FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at DESC LIMIT 1"
  ).get(conversationId) as { created_at: number } | undefined;
  return Boolean(row && row.created_at >= Math.floor(Date.now() / 1000) - 86400);
}
