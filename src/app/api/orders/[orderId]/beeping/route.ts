// ============================================================
// Beeping por pedido: el gate para pintar el CTA, y las acciones de Pedro.
//
//   GET  → estado del gate de liberación (motivos en cristiano) + corte
//   POST → { action: "release" }            liberar (mark-to-send)
//          { action: "resolve_ambiguous" }  resolver un release_unknown
//          { action: "cancel_in_beeping" }  cancelar en Beeping (decisión humana)
//          { action: "dispatch_note", note } guardar la nota interna
//
// Todas las escrituras remotas pasan por los gates (BEEPING_WRITE_ENABLED,
// EMERGENCY_STOP, claim idempotente): un doble clic no libera dos veces.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { getOrderById, setOrderDispatchNote } from "@/lib/db";
import { beepingCutoff } from "@/lib/beeping/cutoff";
import { cancelOrderInBeeping } from "@/lib/beeping/cancel";
import { evaluateLocalReleaseGate, releaseOrderToBeeping, resolveAmbiguousRelease } from "@/lib/beeping/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { orderId } = await ctx.params;
  const id = parseInt(orderId, 10);
  const order = Number.isFinite(id) ? getOrderById(id) : null;
  if (!order) return NextResponse.json({ ok: false, error: "pedido no encontrado" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    gate: evaluateLocalReleaseGate(order),
    cutoff: beepingCutoff(),
    beeping: {
      syncStatus: order.beeping_sync_status,
      orderStatus: order.beeping_order_status,
      externalId: order.beeping_external_id,
      releasedAt: order.beeping_released_at,
      lastSyncAt: order.beeping_last_sync_at,
      lastError: order.beeping_last_error,
    },
    dispatchNote: order.dispatch_note,
  });
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { orderId } = await ctx.params;
  const id = parseInt(orderId, 10);
  const order = Number.isFinite(id) ? getOrderById(id) : null;
  if (!order) return NextResponse.json({ ok: false, error: "pedido no encontrado" }, { status: 404 });

  let body: { action?: string; note?: string };
  try {
    body = (await req.json()) as { action?: string; note?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  switch (body.action) {
    case "release": {
      const res = await releaseOrderToBeeping(id, "pedro");
      const status =
        res.outcome === "released" ? 200 : res.outcome === "claim_lost" ? 409 : res.outcome === "blocked" ? 409 : 502;
      return NextResponse.json({ ok: res.outcome === "released", result: res, order: getOrderById(id) }, { status });
    }
    case "resolve_ambiguous": {
      const res = await resolveAmbiguousRelease(id, "pedro");
      return NextResponse.json({ ok: res !== "unresolved", resolution: res, order: getOrderById(id) }, { status: res === "unresolved" ? 502 : 200 });
    }
    case "cancel_in_beeping": {
      const res = await cancelOrderInBeeping(id, "pedro");
      const status = res.outcome === "cancelled" ? 200 : res.outcome === "blocked" ? 409 : 502;
      return NextResponse.json({ ok: res.outcome === "cancelled", result: res, order: getOrderById(id) }, { status });
    }
    case "dispatch_note": {
      const nota = typeof body.note === "string" ? body.note : "";
      const cambiada = setOrderDispatchNote(id, nota);
      if (!cambiada) {
        return NextResponse.json(
          { ok: false, error: "la nota ya no se puede editar: el pedido está liberado (o liberándose) a Beeping" },
          { status: 409 }
        );
      }
      return NextResponse.json({ ok: true, order: getOrderById(id) });
    }
    default:
      return NextResponse.json({ ok: false, error: "acción desconocida" }, { status: 400 });
  }
}
