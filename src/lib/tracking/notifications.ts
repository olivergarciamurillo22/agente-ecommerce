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
  setOrderSupplierReview,
  type OrderRow,
  type TrackingNotificationKind,
} from "../db";
import { logIntegrationEvent } from "../system/repo";
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

/**
 * Aviso de "intento de entrega fallido". APAGADO por defecto: hasta revisar el
 * copy con Pedro, un intento fallido va a revisión humana y no al cliente.
 * Con DELIVERY_ATTEMPT_WHATSAPP_ENABLED=1 se envía (pasa por los gates igual).
 */
export function deliveryAttemptWhatsAppEnabled(): boolean {
  return process.env.DELIVERY_ATTEMPT_WHATSAPP_ENABLED === "1";
}

/** Aviso de "disponible en punto de recogida". Apagado por defecto. */
export function pickupPointWhatsAppEnabled(): boolean {
  return process.env.PICKUP_POINT_WHATSAPP_ENABLED === "1";
}

/** Tope de avisos de postventa por pedido (anti-spam). */
export function maxTrackingNotificationsPerOrder(): number {
  const v = parseInt(process.env.TRACKING_MAX_NOTIFICATIONS_PER_ORDER ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 4;
}

/** Cuántos avisos de postventa lleva ya este pedido (sellos puestos). */
export function trackingNotificationsSent(order: OrderRow): number {
  return [
    order.tracking_notification_sent_at,
    order.out_for_delivery_notification_sent_at,
    order.delivered_notification_sent_at,
    order.delivery_attempt_notification_sent_at,
    order.pickup_point_notification_sent_at,
  ].filter((x) => x != null).length;
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

/**
 * Intento de entrega fallido. El texto es CONFIGURABLE con
 * DELIVERY_ATTEMPT_MESSAGE (admite {nombre}, {tienda}, {importe}, {url});
 * si no está, se usa este por defecto. Evita afirmar cosas que no sabemos
 * (no dice "mañana": el transportista decide cuándo vuelve).
 */
export function buildDeliveryAttemptMessage(order: OrderRow): string {
  const nombre = firstName(order);
  const importe = formatMoney(order.total_price, order.currency);
  const url = order.tracking_url?.trim() ?? "";
  const plantilla = (process.env.DELIVERY_ATTEMPT_MESSAGE ?? "").trim();
  if (plantilla) {
    return plantilla
      .replace(/\{nombre\}/g, nombre)
      .replace(/\{tienda\}/g, shopName())
      .replace(/\{importe\}/g, importe)
      .replace(/\{url\}/g, url)
      .replace(/\\n/g, "\n")
      .trim();
  }
  return (
    `Hola${nombre ? ` ${nombre}` : ""} 👋\n\n` +
    `El repartidor ha intentado entregar tu pedido de ${shopName()} y no ha podido. ` +
    `Volverá a intentarlo en los próximos días.\n\n` +
    `Si no vas a estar o prefieres otra dirección, respóndeme a este mensaje y lo gestionamos.` +
    (url ? `\n\nSeguimiento:\n${url}` : "")
  );
}

/** Disponible en punto de recogida. SOLO se usa si hay datos útiles del punto. */
export function buildPickupPointMessage(order: OrderRow): string {
  const nombre = firstName(order);
  const importe = formatMoney(order.total_price, order.currency);
  return (
    `Hola${nombre ? ` ${nombre}` : ""} 👋\n\n` +
    `Tu pedido de ${shopName()} está disponible para recoger en:\n${order.pickup_point_info}\n\n` +
    `Recuerda llevar ${importe} en efectivo.`
  );
}

// --- Envío ---

const EVENTO_A_SELLO: Partial<Record<TrackingEvent, TrackingNotificationKind>> = {
  TRACKING_AVAILABLE: "tracking",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
  DELIVERY_ATTEMPT_FAILED: "delivery_attempt",
  PICKUP_POINT_AVAILABLE: "pickup_point",
};

function aRevision(order: OrderRow, motivo: string): void {
  setOrderSupplierReview(order.id, motivo);
  logIntegrationEvent("tracking", "needs_review", "warning", motivo, order.shopify_order_number);
}

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

  // Intento fallido: si el aviso está apagado, NO se manda nada ambiguo;
  // el pedido pasa a revisión humana para que alguien llame o escriba.
  if (event === "DELIVERY_ATTEMPT_FAILED" && !deliveryAttemptWhatsAppEnabled()) {
    aRevision(order, "intento de entrega fallido: aviso automático apagado, requiere gestión humana");
    return false;
  }

  // Punto de recogida: sin nombre/dirección/enlace útil, no hay mensaje.
  if (event === "PICKUP_POINT_AVAILABLE") {
    if (!pickupPointWhatsAppEnabled()) {
      aRevision(order, "disponible en punto de recogida: aviso automático apagado");
      return false;
    }
    if (!(order.pickup_point_info ?? "").trim()) {
      aRevision(order, "disponible en punto de recogida pero el proveedor no dijo dónde: revisar");
      return false;
    }
  }

  const sello = EVENTO_A_SELLO[event];
  if (!sello) return false;

  // Anti-spam: tope de avisos por pedido (además de un sello por tipo).
  if (trackingNotificationsSent(order) >= maxTrackingNotificationsPerOrder()) {
    logger.warn(
      `[TRACKING] #${order.shopify_order_number} ${event}: tope de avisos por pedido alcanzado, no se envía`
    );
    logIntegrationEvent("tracking", "notification_capped", "info", `tope de avisos alcanzado (${event})`, order.shopify_order_number);
    return false;
  }

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
        : event === "DELIVERY_ATTEMPT_FAILED"
          ? buildDeliveryAttemptMessage(order)
          : event === "PICKUP_POINT_AVAILABLE"
            ? buildPickupPointMessage(order)
            : buildDeliveredMessage(order);

  // Vía outbox (nunca Baileys directo): hereda reintentos y safety gates.
  const encolado = sendWhatsAppMessage(order.phone, texto, {
    name: order.customer_name ?? undefined,
    orderAuthorized: order.pilot_authorized === 1,
  });

  logger.info(
    `[WHATSAPP] #${order.shopify_order_number} queued ${event}${encolado ? "" : " (bloqueado por safety gates)"}`
  );
  if (!encolado) {
    // Cuenta para la alerta "avisos de tracking fallidos" del Control Center.
    logIntegrationEvent("tracking", "notification_blocked", "warning", `aviso ${event} bloqueado por safety gates`, order.shopify_order_number);
  }
  return encolado;
}
