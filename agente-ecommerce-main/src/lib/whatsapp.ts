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

import { getOrCreateConversation, insertMessage, enqueueOutbox, getConnectionState } from "./db";
import { canSendRealWhatsApp, logBlockedSend } from "./safety";

/** ¿Está WhatsApp operativo ahora mismo? (sesión vinculada y conectada) */
export function whatsappReady(): boolean {
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
