import { NextResponse, type NextRequest } from "next/server";
import { deleteConversation } from "@/lib/db";
import { requireOwner } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function DELETE(req: NextRequest,
  { params }: RouteContext): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);

  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
  }

  deleteConversation(id);
  return NextResponse.json({ ok: true });
}
