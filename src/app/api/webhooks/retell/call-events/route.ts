import { NextResponse, type NextRequest } from "next/server";
import { getSetting, insertCallEvent, setSetting } from "@/lib/db";
import { retellProvider } from "@/lib/calls/retell";
import { describeRetellSignature } from "@/lib/calls/retell-webhook";
import { logIntegrationEvent } from "@/lib/system/repo";

// Webhook de eventos de llamada de Retell (call_started / call_ended /
// call_analyzed). Patrón INBOX: verificar firma → guardar el evento MÍNIMO
// (parseado, sin payload completo con PII) → 200 inmediato. El procesamiento
// de negocio lo hace el orquestador en su siguiente tick — nada de trabajo
// largo dentro del request ni setTimeout tras responder.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Marca de que una firma REAL de Retell ha validado alguna vez aquí. Es la
 *  única evidencia honesta de que la API key configurada es la que lleva el
 *  "webhook badge"; el doctor la lee para no cantar victoria sin pruebas. */
export const RETELL_WEBHOOK_VERIFIED_KEY = "retell_webhook_signature_verified_at";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RAW body: se verifica EXACTAMENTE lo recibido, antes de cualquier parseo.
  const rawBody = await req.text();
  const signature = req.headers.get("x-retell-signature");

  const check = retellProvider.verifyWebhookDetailed!(rawBody, signature);
  if (!check.valid) {
    // Diagnóstico sin filtrar nada: forma de la cabecera, jamás el digest.
    const forma = describeRetellSignature(signature);
    logIntegrationEvent(
      "system",
      "call_webhook_bad_signature",
      "warning",
      `webhook de Retell rechazado (${check.reason}): ${JSON.stringify(forma)}` +
        (check.reason === "digest_mismatch"
          ? " — si la forma es correcta, la RETELL_API_KEY configurada no es la que lleva el distintivo 'webhook' en el panel de Retell: solo esa firma los webhooks"
          : "")
    );
    return NextResponse.json({ ok: false, error: "firma inválida" }, { status: 401 });
  }

  // Primera firma real validada: se deja constancia (una sola vez).
  try {
    if (!getSetting(RETELL_WEBHOOK_VERIFIED_KEY)) {
      setSetting(RETELL_WEBHOOK_VERIFIED_KEY, String(Math.floor(Date.now() / 1000)));
      logIntegrationEvent("system", "call_webhook_signature_verified", "info", "primera firma REAL de Retell verificada correctamente");
    }
  } catch {
    /* la marca es informativa: nunca puede tumbar el webhook */
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
