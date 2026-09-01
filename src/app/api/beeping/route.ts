// ============================================================
// Beeping global: salud + tienda + sync manual.
//
//   GET  → salud local (sin llamar a Beeping) + corte + tienda cacheada
//   POST → { action: "sync" }                    reconciliación (read-only remoto)
//          { action: "discover_shops" }          listar tiendas (GET remoto)
//          { action: "select_shop", shopId, shopName } fijar tienda
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { beepingCutoff } from "@/lib/beeping/cutoff";
import { getBeepingHealth } from "@/lib/beeping/health";
import { cacheBeepingShop } from "@/lib/beeping/config";
import { ensureBeepingShop, reconcileBeepingOrders } from "@/lib/beeping/sync";
import { resolveAllAmbiguousReleases } from "@/lib/beeping/release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, health: getBeepingHealth(), cutoff: beepingCutoff() });
}

export async function POST(req: NextRequest) {
  let body: { action?: string; shopId?: number; shopName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  switch (body.action) {
    case "sync": {
      const report = await reconcileBeepingOrders();
      // Aprovechar la pasada para resolver liberaciones ambiguas pendientes.
      const ambiguousResolved = report.skipped ? 0 : await resolveAllAmbiguousReleases();
      return NextResponse.json({ ok: !report.skipped, report, ambiguousResolved, health: getBeepingHealth() });
    }
    case "discover_shops": {
      const discovery = await ensureBeepingShop();
      return NextResponse.json({ ok: discovery.outcome !== "error", discovery });
    }
    case "select_shop": {
      if (typeof body.shopId !== "number" || !Number.isFinite(body.shopId)) {
        return NextResponse.json({ ok: false, error: "shopId inválido" }, { status: 400 });
      }
      cacheBeepingShop(body.shopId, (body.shopName ?? `tienda ${body.shopId}`).slice(0, 120));
      return NextResponse.json({ ok: true, health: getBeepingHealth() });
    }
    default:
      return NextResponse.json({ ok: false, error: "acción desconocida" }, { status: 400 });
  }
}
