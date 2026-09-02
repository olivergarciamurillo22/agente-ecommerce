// Seguimiento (§8): buckets operativos + línea temporal por pedido.
import { NextResponse, type NextRequest } from "next/server";
import { getFollowUpOverview, getOrderTimeline } from "../../../lib/system/followup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const orderId = req.nextUrl.searchParams.get("orderId");
    if (orderId) {
      const id = parseInt(orderId, 10);
      if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: "orderId inválido" }, { status: 400 });
      const t = getOrderTimeline(id);
      if (!t.order) return NextResponse.json({ ok: false, error: "pedido no encontrado" }, { status: 404 });
      return NextResponse.json({ ok: true, ...t });
    }
    return NextResponse.json({ ok: true, ...getFollowUpOverview() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error interno" }, { status: 500 });
  }
}
