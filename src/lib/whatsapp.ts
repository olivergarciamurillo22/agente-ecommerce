// ============================================================
// Abstracción de envío de WhatsApp — la lógica de negocio NUNCA habla con
// Baileys directamente. Cuando migremos a la Cloud API de Meta, solo se
// cambia la implementación de este módulo.
//
// Implementación actual: patrón OUTBOX del kit. Cualquier proceso (Next.js o
// bot) escribe el mensaje en la tabla `outbox` de SQLite; el proceso del bot
// (src/lib/baileys/outbox.ts) lo entrega por Baileys en ≤2s con reintentos.
//
// SEGURIDAD: este es el CHOKEPOINT de salida. Si los safety gates no lo
// permiten (safe mode, flags, emergency stop, allowlist), el mensaje NO se
// encola — se registra la simulación y no queda nada pendiente que pudiera
// dispararse más tarde al cambiar la configuración. El loop del outbox
// vuelve a comprobar el gate al entregar (defensa en profundidad).
// ============================================================

import {
  getOrCreateConversation,
  insertMessage,
  enqueueOutbox,
  enqueueOutboxRich,
  getConnectionState,
} from "./db";
import { canSendRealWhatsApp, logBlockedSend } from "./safety";
import { whatsappProviderName } from "./whatsapp/provider";
import { metaCloudConfigured } from "./whatsapp/meta-cloud";
import type { InteractiveSpec } from "./whatsapp/interactive";

/**
 * ¿Está WhatsApp operativo ahora mismo?
 *
 * Depende del proveedor activo:
 *  - baileys   → sesión de WhatsApp Web vinculada y conectada (QR).
 *  - cloud_api → credenciales de Meta presentes. No hay sesión que caer:
 *                la conexión es por token en cada llamada.
 */
export function whatsappReady(): boolean {
  if (whatsappProviderName() === "cloud_api") return metaCloudConfigured();
  return getConnectionState().status === "connected";
}

export interface SendOptions {
  name?: string;
  /** true si el mensaje pertenece a un pedido autorizado a mano para el piloto. */
  orderAuthorized?: boolean;
}

/**
 * Envía (encola) un mensaje de WhatsApp a un teléfono en dígitos
 * internacionales (ej. "34612345678").
 *
 * Devuelve true si el mensaje quedó encolado para envío REAL; false si los
 * safety gates lo bloquearon (solo se loguea la simulación).
 */
export function sendWhatsAppMessage(phone: string, text: string, opts: SendOptions = {}): boolean {
  const authorized = opts.orderAuthorized === true;
  if (!canSendRealWhatsApp(phone, { orderAuthorized: authorized })) {
    logBlockedSend(`send-${phone}-${text.slice(0, 24)}`, phone, text);
    return false;
  }
  const convo = getOrCreateConversation(phone, opts.name);
  // Registrado como 'assistant' para que se vea en el panel de Chats.
  insertMessage(convo.id, "assistant", text);
  // La marca viaja con el mensaje: el loop del outbox revalida los gates
  // justo antes de entregar y necesita saber que este envío está autorizado.
  enqueueOutbox(convo.id, phone, text, authorized);
  return true;
}

/**
 * Envía (encola) un mensaje INTERACTIVO — botones o lista.
 *
 * Mismo chokepoint y mismos gates que sendWhatsAppMessage. La diferencia
 * está en QUÉ se encola según el proveedor activo:
 *  - cloud_api → el mensaje interactivo entero (payload_json) con su texto
 *                de fallback en `content` para el panel.
 *  - baileys   → SOLO el texto de fallback: Baileys no tiene botones, y el
 *                fallback es exactamente el flujo 1/2/3 que ya funciona.
 *
 * Así la lógica de negocio llama a UNA función y no sabe qué proveedor hay.
 */
export function sendWhatsAppInteractive(phone: string, spec: InteractiveSpec, opts: SendOptions = {}): boolean {
  const authorized = opts.orderAuthorized === true;
  if (!canSendRealWhatsApp(phone, { orderAuthorized: authorized })) {
    logBlockedSend(`send-${phone}-${spec.fallbackText.slice(0, 24)}`, phone, spec.fallbackText);
    return false;
  }
  const convo = getOrCreateConversation(phone, opts.name);
  insertMessage(convo.id, "assistant", spec.fallbackText);

  if (whatsappProviderName() === "cloud_api") {
    enqueueOutboxRich(convo.id, phone, {
      content: spec.fallbackText,
      messageType: spec.message.kind === "interactive_list" ? "interactive_list" : "interactive_buttons",
      payloadJson: JSON.stringify(spec.message),
      authorized,
    });
  } else {
    enqueueOutbox(convo.id, phone, spec.fallbackText, authorized);
  }
  return true;
}
