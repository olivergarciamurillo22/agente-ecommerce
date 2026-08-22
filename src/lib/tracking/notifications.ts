// ============================================================
// Avisos de postventa por WhatsApp (tracking, reparto, entrega).
//
// Reglas duras:
//  - Cada aviso se manda UNA sola vez. El sello en la base de datos
//    (`*_notification_sent_at`) es la garantía: se reclama de forma atómica
//    ANTES de encolar, así que ni un reintento ni dos webhooks a la vez
//    pueden duplicar el mensaje.
//  - NUNCA se llama a Baileys desde aquí: todo va por el outbox, que ya
//    tiene reintentos y revalida los safety gates antes de entregar.
//  - Las incidencias NO generan mensaje automático: van a revisión humana.
// ============================================================

import pino from "pino";
import {
  claimTrackingNotification,
  type OrderRow,
  type TrackingNotificationKind,
} from "../db";
import { formatMoney } from "../orders/messages";
import { sendWhatsAppMessage } from "../whatsapp";
import type { TrackingEvent } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

function shopName(): string {
  return process.env.SHOP_NAME?.trim() || "Casamable™";
}

/** Primer nombre presentable (misma regla que en los mensajes de confirmación). */
function firstName(order: OrderRow): string {
  const raw = (order.customer_name ?? "").trim().split(/\s+/)[0] || "";
  if (!raw) return "";
  const uniforme = raw === raw.toLowerCase() || raw === raw.toUpperCase();
  return uniforme ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : raw;
}

/** El aviso de entrega está apagado por defecto hasta revisar el copy. */
export function deliveredWhatsAppEnabled(): boolean {
  return process.env.DELIVERED_WHATSAPP_ENABLED === "1";
}

// --- Plantillas ---

export function buildTrackingAvailableMessage(order: OrderRow): string {
  const nombre = firstName(order);
  const url = order.tracking_url?.trim();
  return (
    `Hola${nombre ? ` ${nombre}` : ""}, tu pedido de ${shopName()} ya está en camino 📦\n\n` +
    `Número de seguimiento:\n${order.tracking_number ?? "—"}\n` +
    (url ? `\n${url}\n` : "") +
    `\nTe iremos avisando de las novedades de tu envío.`
  );
}

export function buildOutForDeliveryMessage(order: OrderRow): string {
  const nombre = firstName(order);
  const importe = formatMoney(order.total_price, order.currency);
  const url = order.tracking_url?.trim();
  return (
    `Hola${nombre ? ` ${nombre}` : ""} 👋\n\n` +
    `Tu pedido de ${shopName()} está en reparto y debería llegar pronto.\n\n` +
    `Recuerda tener preparados ${importe} en efectivo para el repartidor.` +
    (url ? `\n\nSeguimiento:\n${url}` : "")
  );
}

export function buildDeliveredMessage(order: OrderRow): string {
  return `Tu pedido de ${shopName()} aparece como entregado ✅\n\nGracias por confiar en nosotros.`;
}

// --- Envío ---

const EVENTO_A_SELLO: Partial<Record<TrackingEvent, TrackingNotificationKind>> = {
  TRACKING_AVAILABLE: "tracking",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
};

/**
 * Encola el aviso correspondiente a un evento, si procede.
 * Devuelve true solo si el mensaje se ha encolado de verdad.
 *
 * El orden importa: primero se RECLAMA el sello en la base de datos y solo
 * si se gana el claim se encola. Así, si dos procesos ven la misma
 * transición a la vez, únicamente uno manda el WhatsApp.
 */
export function notifyTrackingEvent(order: OrderRow, event: TrackingEvent): boolean {
  // Las incidencias y devoluciones no avisan al cliente: revisión humana.
  if (event === "INCIDENT" || event === "RETURNED") {
    logger.info(
      `[TRACKING] #${order.shopify_order_number} ${event}: sin aviso automático, va a revisión manual`
    );
    return false;
  }

  if (event === "DELIVERED" && !deliveredWhatsAppEnabled()) {
    logger.info(
      `[TRACKING] #${order.shopify_order_number} entregado: aviso desactivado (DELIVERED_WHATSAPP_ENABLED=0)`
    );
    return false;
  }

  const sello = EVENTO_A_SELLO[event];
  if (!sello) return false;

  // Claim atómico: si ya se avisó, aquí se acaba.
  if (!claimTrackingNotification(order.id, sello)) {
    logger.info(`[TRACKING] #${order.shopify_order_number} ${event}: ya se avisó, no se repite`);
    return false;
  }

  const texto =
    event === "TRACKING_AVAILABLE"
      ? buildTrackingAvailableMessage(order)
      : event === "OUT_FOR_DELIVERY"
        ? buildOutForDeliveryMessage(order)
        : buildDeliveredMessage(order);

  // Vía outbox (nunca Baileys directo): hereda reintentos y safety gates.
  const encolado = sendWhatsAppMessage(order.phone, texto, {
    name: order.customer_name ?? undefined,
    orderAuthorized: order.pilot_authorized === 1,
  });

  logger.info(
    `[WHATSAPP] #${order.shopify_order_number} queued ${event}${encolado ? "" : " (bloqueado por safety gates)"}`
  );
  return encolado;
}
