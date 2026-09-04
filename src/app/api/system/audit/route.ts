import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { listAudit } from "@/lib/workspace";
import { systemDbHandle } from "@/lib/db";

export async function GET(req: NextRequest) {
  const auth = requireOwner(req); if (!auth.ok) return auth.response;
  const q = req.nextUrl.searchParams;
  const users = systemDbHandle().prepare("SELECT id,name FROM users ORDER BY name").all();
  return NextResponse.json({ users, entries: listAudit({ userId: Number(q.get("userId")) || undefined, from: Number(q.get("from")) || undefined, to: Number(q.get("to")) || undefined }) });
}
