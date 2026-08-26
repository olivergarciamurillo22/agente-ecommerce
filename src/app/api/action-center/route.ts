// La bandeja de trabajo de Pedro: qué requiere acción humana AHORA.
// GET = leer; POST = marcar un elemento como resuelto (no borra nada).
import { NextResponse } from "next/server";
import { getActionCenter } from "@/lib/system/action-center";
import { resolveActionItem, getOrderById } from "@/lib/db";
import { logIntegrationEvent } from "@/lib/system/repo";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ ok: true, ...getActionCenter() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json()) as { orderId?: number; actionType?: string; note?: string };
    if (typeof body.orderId !== "number" || !body.actionType) {
      return NextResponse.json({ ok: false, error: "hacen falta orderId y actionType" }, { status: 400 });
    }
    const order = getOrderById(body.orderId);
    if (!order) return NextResponse.json({ ok: false, error: "pedido no encontrado" }, { status: 404 });
    resolveActionItem(body.orderId, body.actionType, body.note ?? null);
    logIntegrationEvent(
      "system",
      "action_resolved",
      "info",
      `Pedro marcó resuelto: ${body.actionType}${body.note ? ` (${body.note.slice(0, 80)})` : ""}`,
      order.shopify_order_number
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}
