// ============================================================
// WEBHOOK OFICIAL DE META — verificación, firma y proceso.
//
// Las tres protecciones obligatorias del repo (CLAUDE.md § 5), en la
// variante de Meta:
//
//  1. FIRMA: X-Hub-Signature-256 = HMAC-SHA256(cuerpo crudo, APP_SECRET),
//     comparada en tiempo constante. Sin secreto configurado → 500 (error
//     NUESTRO); firma inválida → 401. Jamás un camino que acepte sin firma.
//  2. IDEMPOTENCIA por id de MENSAJE (Meta reintenta webhooks): dedupe con
//     claimWebhookEvent, la misma tabla genérica que Shopify y Dropea.
//  3. Estados fuera de orden: los timestamps solo AVANZAN (un `delivered`
//     atrasado no borra un `read`) — eso lo garantiza la capa de DB.
//
// La VERIFICACIÓN inicial (GET) es el reto hub.challenge de Meta: se
// responde solo si hub.verify_token coincide con el nuestro.
// ============================================================

import crypto from "node:crypto";
import pino from "pino";
import { claimWebhookEvent, setSetting } from "../db";
import { logIntegrationEvent, recordServiceCheck } from "../system/repo";
import { sendWhatsAppMessage } from "../whatsapp";
import { handleOrderReply, handleOrderButtonReply } from "../orders/confirmation";
import { updateOutboxStatusByProviderMessageId } from "../db";
import { parseMetaWebhookPayload, type InboundWhatsAppMessage } from "./inbound";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

// --- Verificación inicial (GET de Meta al dar de alta el webhook) ---

export interface VerifyResult {
  status: number;
  body: string;
}

export function verifyMetaWebhookSubscription(params: {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}): VerifyResult {
  const esperado = (process.env.META_WHATSAPP_VERIFY_TOKEN ?? "").trim();
  if (!esperado) {
    // Error nuestro, no de Meta: sin token propio no se puede verificar nada.
    return { status: 500, body: "META_WHATSAPP_VERIFY_TOKEN no configurado" };
  }
  if (params.mode === "subscribe" && params.token === esperado && params.challenge) {
    return { status: 200, body: params.challenge };
  }
  return { status: 403, body: "verificación rechazada" };
}

// --- Firma de los POST ---

export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = (process.env.META_WHATSAPP_APP_SECRET ?? "").trim();
  if (!secret || !signatureHeader) return false;
  const esperada = `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- Proceso ---

export interface MetaWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** Un mensaje entrante normalizado → flujo COD determinista. */
function procesarMensaje(m: InboundWhatsAppMessage): void {
  // Dedupe por id de mensaje: Meta reintenta la entrega del webhook.
  if (!claimWebhookEvent(`meta:${m.messageId}`, "meta_whatsapp", `inbound_${m.kind}`, null)) {
    logger.info(`[META] mensaje ${m.messageId} repetido — ignorado`);
    return;
  }

  let resultado;
  if ((m.kind === "button_reply" || m.kind === "list_reply") && m.payload) {
    // La vía preferida: payload determinista, cero interpretación de texto.
    resultado = handleOrderButtonReply(m.phone, m.payload);
  } else if (m.kind === "text" && m.text) {
    // Compatibilidad: el parser de texto de siempre ("1", "todo correcto").
    resultado = handleOrderReply(m.phone, m.text);
  } else {
    // Audio/imagen/desconocido por Cloud API: fuera del alcance del piloto.
    // No se responde nada (misma política que un número sin pedidos).
    logger.info(`[META] entrante ${m.kind} de ***${m.phone.slice(-4)}: sin manejo en el piloto`);
    return;
  }

  if (resultado.handled && resultado.reply) {
    // La respuesta sale por el OUTBOX, como todo: hereda gates y reintentos.
    sendWhatsAppMessage(m.phone, resultado.reply, {
      name: m.profileName ?? undefined,
      orderAuthorized: resultado.authorized === true,
    });
  }
}

/**
 * Procesa un POST del webhook YA verificado de firma (la ruta HTTP hace la
 * verificación con el cuerpo crudo y llama aquí).
 */
export function processMetaWebhook(rawBody: string, signatureHeader: string | null): MetaWebhookResult {
  const secret = (process.env.META_WHATSAPP_APP_SECRET ?? "").trim();
  if (!secret) {
    logger.error("[META] META_WHATSAPP_APP_SECRET no configurado — webhook rechazado");
    return { status: 500, body: { ok: false, error: "app secret no configurado" } };
  }
  if (!verifyMetaSignature(rawBody, signatureHeader)) {
    logIntegrationEvent("whatsapp", "meta_webhook_bad_signature", "warning", "webhook de Meta rechazado por firma inválida");
    return { status: 401, body: { ok: false, error: "firma inválida" } };
  }

  let parsed;
  try {
    parsed = parseMetaWebhookPayload(JSON.parse(rawBody));
  } catch {
    return { status: 200, body: { ok: false, ignored: "json inválido" } };
  }

  // Latido para el Control Center: el webhook está VIVO.
  setSetting("meta_webhook_last_received_at", String(Math.floor(Date.now() / 1000)));
  recordServiceCheck("whatsapp", { status: "healthy", ok: true });

  for (const m of parsed.messages) procesarMensaje(m);

  let statusesAplicados = 0;
  for (const st of parsed.statuses) {
    if (!st.providerMessageId) continue;
    // Idempotente y solo-avanza: la capa de DB ignora repetidos y atrasados.
    if (updateOutboxStatusByProviderMessageId(st.providerMessageId, st.status, st.timestamp, st.errorDetail)) {
      statusesAplicados++;
    }
    if (st.status === "failed") {
      logIntegrationEvent(
        "whatsapp",
        "meta_message_failed",
        "warning",
        `Meta reporta fallo de entrega: ${st.errorDetail ?? "sin detalle"}`
      );
    }
  }

  return {
    status: 200,
    body: { ok: true, messages: parsed.messages.length, statuses: statusesAplicados },
  };
}
