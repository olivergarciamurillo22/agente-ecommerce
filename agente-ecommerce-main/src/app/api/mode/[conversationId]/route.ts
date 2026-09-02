import { NextResponse, type NextRequest } from "next/server";
import { setMode, type ConversationMode } from "@/lib/db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function POST(
  req: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);

  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
  }

  const body = (await req.json()) as { mode?: string };
  const mode = body.mode;

  if (mode !== "AI" && mode !== "HUMAN") {
    return NextResponse.json(
      { ok: false, error: "mode debe ser 'AI' o 'HUMAN'" },
      { status: 400 }
    );
  }

  setMode(id, mode as ConversationMode);
  return NextResponse.json({ ok: true });
}
