import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { recordDecision, type DecisionKind } from "@/lib/hunter/decisions";
import { DISCARD_REASONS } from "@/lib/hunter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DECISIONES: DecisionKind[] = ["save", "watch", "discard", "test", "winner", "loser"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  let body: { productId?: string; decision?: string; reason?: string; note?: string; searchId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const decision = body.decision as DecisionKind | undefined;
  if (!body.productId || !decision || !DECISIONES.includes(decision)) {
    return NextResponse.json({ ok: false, error: "decisión no permitida" }, { status: 400 });
  }
  // El motivo es opcional, pero si viene tiene que ser uno de la lista: texto
  // libre aquí convertiría el dataset de aprendizaje en algo inanalizable.
  if (body.reason && !DISCARD_REASONS.some((r) => r.key === body.reason)) {
    return NextResponse.json({ ok: false, error: "motivo no reconocido" }, { status: 400 });
  }

  const op = recordDecision({
    productId: body.productId,
    decision,
    reason: body.reason ?? null,
    note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    searchId: body.searchId ?? null,
    decidedBy: auth.user.name,
  });
  if (!op) return NextResponse.json({ ok: false, error: "oportunidad no encontrada" }, { status: 404 });
  return NextResponse.json({ ok: true, opportunity: op });
}
