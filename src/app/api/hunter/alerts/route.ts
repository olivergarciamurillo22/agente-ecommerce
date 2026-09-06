import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { listAlerts, markAlertsRead } from "@/lib/hunter/decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const todas = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({ ok: true, alerts: listAlerts(!todas, 100) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  let body: { ids?: number[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const ids = (body.ids ?? []).filter((n) => Number.isInteger(n));
  markAlertsRead(ids);
  return NextResponse.json({ ok: true, marked: ids.length });
}
