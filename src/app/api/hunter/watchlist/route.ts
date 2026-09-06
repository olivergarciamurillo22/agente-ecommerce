import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { listWatchlist } from "@/lib/hunter/decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ ok: true, watchlist: listWatchlist() });
}
