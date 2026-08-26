// ============================================================
// Webhook oficial de la Cloud API de Meta.
//
//   GET  → verificación inicial (hub.challenge)
//   POST → mensajes entrantes, respuestas a botones y estados de entrega
//
// La lógica vive en src/lib/whatsapp/meta-webhook.ts (testeable sin HTTP).
// El cuerpo se lee CRUDO: la firma HMAC se calcula sobre los bytes exactos.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { processMetaWebhook, verifyMetaWebhookSubscription } from "@/lib/whatsapp/meta-webhook";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const p = req.nextUrl.searchParams;
  const r = verifyMetaWebhookSubscription({
    mode: p.get("hub.mode"),
    token: p.get("hub.verify_token"),
    challenge: p.get("hub.challenge"),
  });
  // Meta espera el challenge como TEXTO PLANO, no JSON.
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const r = processMetaWebhook(rawBody, req.headers.get("x-hub-signature-256"));
  return NextResponse.json(r.body, { status: r.status });
}
