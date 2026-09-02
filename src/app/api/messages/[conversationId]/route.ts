import { NextResponse, type NextRequest } from "next/server";
import {
  getConversationById,
  getMessages,
  insertMessage,
  enqueueOutbox,
} from "@/lib/db";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteContext
): Promise<NextResponse> {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);

  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
  }

  const messages = getMessages(id, 200);
  return NextResponse.json({ messages });
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

  const conv = getConversationById(id);
  if (!conv) {
    return NextResponse.json({ ok: false, error: "conversación no encontrada" }, { status: 404 });
  }

  // Cuerpo malformado → 400 con motivo, nunca un 500 con stack.
  let body: { content?: string };
  try {
    body = (await req.json()) as { content?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const content = (typeof body?.content === "string" ? body.content : "").trim();
  if (content === "") {
    return NextResponse.json({ ok: false, error: "contenido vacío" }, { status: 400 });
  }

  // 1) Insertar el mensaje como 'human' (visible inmediatamente en el dashboard)
  const messageId = insertMessage(id, "human", content);

  // 2) Encolar en outbox para que el bot lo envíe por WhatsApp
  enqueueOutbox(id, conv.phone, content);

  return NextResponse.json({ ok: true, messageId });
}
