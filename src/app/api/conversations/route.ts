import { NextResponse, type NextRequest } from "next/server";
import { listConversations } from "@/lib/db";
import { requireOwner } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const conversations = listConversations();
  return NextResponse.json({ conversations });
}
