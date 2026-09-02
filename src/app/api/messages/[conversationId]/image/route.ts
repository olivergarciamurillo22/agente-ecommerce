import { NextResponse, type NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getConversationById, insertMessage, enqueueOutboxImage } from "@/lib/db";

// Subida de una imagen desde el panel para enviarla al lead por WhatsApp.
// Guarda el archivo en data/media/ (volumen persistente), registra el mensaje
// como 'human' y lo encola en el outbox para que el bot lo envíe.
export const dynamic = "force-dynamic";

const MEDIA_DIR = path.resolve(process.cwd(), "data", "media");
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

interface RouteContext {
  params: Promise<{ conversationId: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ ok: false, error: "id inválido" }, { status: 400 });
  }

  const conv = getConversationById(id);
  if (!conv) {
    return NextResponse.json({ ok: false, error: "conversación no encontrada" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "el cuerpo no es multipart/form-data válido" }, { status: 400 });
  }
  const file = form.get("image");
  const caption = ((form.get("caption") as string | null) ?? "").trim();

  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "no se recibió ninguna imagen" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ ok: false, error: "el archivo no es una imagen" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "imagen demasiado grande (máx 8 MB)" }, { status: 400 });
  }

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const mediaPath = path.join(MEDIA_DIR, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(mediaPath, Buffer.from(await file.arrayBuffer()));

  const messageId = insertMessage(id, "human", caption ? `📷 ${caption}` : "📷 [imagen enviada]");
  enqueueOutboxImage(id, conv.phone, mediaPath, caption);

  return NextResponse.json({ ok: true, messageId });
}
