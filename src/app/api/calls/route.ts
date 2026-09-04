import { NextResponse, type NextRequest } from "next/server";
import {
  getCallQueueSummary,
  listCallAttemptsByState,
  getOrderById,
  systemDbHandle,
} from "@/lib/db";
import { getCallConfigView, setCallConfig, PANEL_EDITABLE_KEYS, type PanelCallKey } from "@/lib/calls/config";
import { madridDate, madridParts } from "@/lib/calls/schedule";
import { requireOwner } from "@/lib/auth/guard";

// Estado y controles del orquestador de llamadas para el panel.
// READ + configuración operativa (kill switch, shadow, cap, allowlist).
// NUNCA devuelve secretos (solo configured/missing) ni teléfonos completos.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(phone: string): string {
  const d = phone.replace(/[^\d]/g, "");
  return d.length > 4 ? `···${d.slice(-4)}` : "···";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req); if (!auth.ok) return auth.response;
  const now = new Date();
  const p = madridParts(now);
  const startDay = Math.floor(madridDate(p.year, p.month, p.day, 0, 0).getTime() / 1000);

  const attemptView = (state: Parameters<typeof listCallAttemptsByState>[0], limit = 20) =>
    listCallAttemptsByState(state, limit).map((a) => {
      const order = getOrderById(a.order_id);
      return {
        id: a.id,
        order: order?.shopify_order_number ?? String(a.order_id),
        phone: order ? mask(order.phone) : "···",
        contact: a.contact_number,
        state: a.state,
        scheduledAt: a.scheduled_at,
        result: a.result,
        reason: a.reason,
        shadowLogged: a.shadow_logged_at !== null,
      };
    });

  const recent = (
    systemDbHandle()
      .prepare(
        "SELECT * FROM call_attempts WHERE state = 'completed' ORDER BY ended_at DESC LIMIT 15"
      )
      .all() as Array<Record<string, unknown>>
  ).map((a) => {
    const order = getOrderById(a.order_id as number);
    return {
      id: a.id,
      order: order?.shopify_order_number ?? String(a.order_id),
      contact: a.contact_number,
      result: a.result,
      endedAt: a.ended_at,
      retryConsumed: a.retry_consumed === 1,
    };
  });

  return NextResponse.json({
    config: getCallConfigView(),
    summary: getCallQueueSummary(startDay),
    pending: attemptView("planned"),
    inFlight: attemptView("in_flight"),
    manualReview: attemptView("manual_review", 30),
    recentCompleted: recent,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req); if (!auth.ok) return auth.response;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const key = String(body.key ?? "");
    const value = String(body.value ?? "");
    if (!(PANEL_EDITABLE_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json({ error: `clave no editable: ${key}` }, { status: 400 });
    }
    setCallConfig(key as PanelCallKey, value);
    return NextResponse.json({ ok: true, config: getCallConfigView() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status: 400 });
  }
}
