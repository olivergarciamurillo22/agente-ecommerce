import { NextResponse, type NextRequest } from "next/server";
import { listDailyAdSpend, upsertDailyAdSpend } from "@/lib/db";
import { requireOwner } from "@/lib/auth/guard";

// Gasto diario en ads (entrada manual hasta que exista una fuente real).
// Escritura LOCAL en SQLite, detrás del Basic Auth del panel.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ adSpend: listDailyAdSpend() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const day = String(body.day ?? "").trim();
    const amount = typeof body.amount === "number" ? body.amount : parseFloat(String(body.amount ?? "").replace(",", "."));
    upsertDailyAdSpend(day, amount, "manual");
    return NextResponse.json({ ok: true, adSpend: listDailyAdSpend() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status: 400 });
  }
}
