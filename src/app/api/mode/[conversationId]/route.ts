import { NextResponse, type NextRequest } from "next/server";
import { setMode, type ConversationMode } from "@/lib/db";
import { requireStaff } from "@/lib/auth/guard";
import { audit } from "@/lib/workspace";

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

  let body: { mode?: string };
  try {
    body = (await req.json()) as { mode?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const mode = body?.mode;

  if (mode !== "AI" && mode !== "HUMAN") {
    return NextResponse.json(
      { ok: false, error: "mode debe ser 'AI' o 'HUMAN'" },
      { status: 400 }
    );
  }
  const auth = requireStaff(req);
  if (!auth.ok) return auth.response;

  setMode(id, mode as ConversationMode);
  audit(auth.user, mode === "HUMAN" ? "take_over" : "return_to_bot", "conversation", id);
  return NextResponse.json({ ok: true });
}
