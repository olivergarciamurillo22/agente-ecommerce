import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { applyManualOverride, getProduct, listProductsByStatus } from "@/lib/hunter/repo";
import { buildLandingHandoff, buildTestPlan } from "@/lib/hunter/test-plan";
import type { OpportunityStatus } from "@/lib/hunter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ESTADOS: OpportunityStatus[] = ["new", "saved", "watching", "testing", "discarded", "winner", "loser"];

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const op = getProduct(id);
    if (!op) return NextResponse.json({ ok: false, error: "no encontrada" }, { status: 404 });
    return NextResponse.json({ ok: true, opportunity: op, testPlan: buildTestPlan(op), landing: buildLandingHandoff(op) });
  }

  const pedidos = (req.nextUrl.searchParams.get("status") ?? "new,saved,watching")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is OpportunityStatus => (ESTADOS as string[]).includes(s));

  return NextResponse.json({ ok: true, opportunities: listProductsByStatus(pedidos.length > 0 ? pedidos : ESTADOS, 200) });
}

/** Correcciones a mano de Pedro (§73). Su valor manda sobre el del proveedor. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  let body: { id?: string; canonicalName?: string; category?: string; supplierCost?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ ok: false, error: "falta id" }, { status: 400 });
  if (!getProduct(body.id)) return NextResponse.json({ ok: false, error: "no encontrada" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (typeof body.canonicalName === "string" && body.canonicalName.trim()) patch.canonicalName = body.canonicalName.trim().slice(0, 200);
  if (typeof body.category === "string") patch.category = body.category.trim().slice(0, 80);
  if (typeof body.supplierCost === "number" && Number.isFinite(body.supplierCost) && body.supplierCost >= 0) {
    patch.supplierCost = body.supplierCost;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ ok: false, error: "nada que cambiar" }, { status: 400 });

  applyManualOverride(body.id, { ...patch, editedBy: auth.user.name, editedAt: Math.floor(Date.now() / 1000) });
  return NextResponse.json({ ok: true, opportunity: getProduct(body.id) });
}
