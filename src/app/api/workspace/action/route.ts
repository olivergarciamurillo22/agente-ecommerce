import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth/guard";
import { getConversationById, getOrderById, systemDbHandle } from "@/lib/db";
import { audit } from "@/lib/workspace";

type Body = { action?: string; conversationId?: number; orderId?: number; value?: string };

export async function POST(req: NextRequest) {
  const auth = requireStaff(req); if (!auth.ok) return auth.response;
  let body: Body; try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON inválido" }, { status: 400 }); }
  const value = (body.value ?? "").trim();
  const conversationId = Number(body.conversationId);
  const orderId = Number(body.orderId);
  const conv = conversationId ? getConversationById(conversationId) : null;
  const order = orderId ? getOrderById(orderId) : null;
  const db = systemDbHandle();

  if (body.action === "correct_address" || body.action === "delivery_note") {
    if (!order || !value) return NextResponse.json({ error: "Pedido y texto son obligatorios" }, { status: 400 });
    const column = body.action === "correct_address" ? "proposed_address" : "delivery_note";
    db.transaction(() => {
      db.prepare(`UPDATE orders SET ${column}=?, updated_at=unixepoch() WHERE id=?`).run(value.slice(0, 1000), orderId);
      audit(auth.user, body.action as "correct_address" | "delivery_note", "order", orderId, { value });
    })();
    return NextResponse.json({ ok: true });
  }
  if (body.action === "resolve") {
    if (!conv || !value) return NextResponse.json({ error: "La nota de resolución es obligatoria" }, { status: 400 });
    db.transaction(() => {
      db.prepare(`INSERT INTO work_items(conversation_id,order_id,reason,resolved_at,resolution_note)
        VALUES(?,?,?,unixepoch(),?)`).run(conversationId, order || null ? orderId : null, "resuelto por agente", value);
      audit(auth.user, "resolve", "conversation", conversationId, { note: value });
    })();
    return NextResponse.json({ ok: true });
  }
  if (body.action === "escalate") {
    if (!conv || !value) return NextResponse.json({ error: "Indica el motivo" }, { status: 400 });
    db.transaction(() => {
      db.prepare("INSERT INTO work_items(conversation_id,order_id,reason,owner_only) VALUES(?,?,?,1)").run(conversationId, order ? orderId : null, value);
      audit(auth.user, "escalate", "conversation", conversationId, { reason: value });
    })();
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Acción no permitida" }, { status: 400 });
}
