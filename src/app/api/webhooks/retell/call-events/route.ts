import { NextResponse, type NextRequest } from "next/server";
import { insertCallEvent } from "@/lib/db";
import { retellProvider } from "@/lib/calls/retell";
import { logIntegrationEvent } from "@/lib/system/repo";

// Webhook de eventos de llamada de Retell (call_started / call_ended /
// call_analyzed). Patrón INBOX: verificar firma → guardar el evento MÍNIMO
// (parseado, sin payload completo con PII) → 200 inmediato. El procesamiento
// de negocio lo hace el orquestador en su siguiente tick — nada de trabajo
// largo dentro del request ni setTimeout tras responder.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-retell-signature");

  if (!retellProvider.verifyWebhook(rawBody, signature)) {
    logIntegrationEvent("system", "call_webhook_bad_signature", "warning", "webhook de Retell rechazado por firma inválida");
    return NextResponse.json({ ok: false, error: "firma inválida" }, { status: 401 });
  }

  const event = retellProvider.parseEvent(rawBody);
  if (!event) {
    // Firma válida pero forma desconocida: 200 (no reintentar), sin efectos.
    logIntegrationEvent("system", "call_webhook_unparseable", "info", "webhook de Retell con forma desconocida: ignorado");
    return NextResponse.json({ ok: true, ignored: "forma desconocida" });
  }

  const dedupeKey = `${event.providerCallId}:${event.type}:${event.eventAt ?? "na"}`;
  const nuevo = insertCallEvent({
    dedupeKey,
    providerCallId: event.providerCallId,
    eventType: event.type,
    eventAt: event.eventAt,
    // Solo lo parseado (sin transcript ni payload completo): minimización.
    payloadJson: JSON.stringify(event),
  });

  return NextResponse.json({ ok: true, duplicate: !nuevo });
}
