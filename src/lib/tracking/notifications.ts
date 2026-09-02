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
//  - Un pedido en `ignored_old` NUNCA recibe un aviso. Ese estado significa
//    literalmente "historial, no actuar jamás": lo usan el backfill (E3), la
//    reconciliación (E5) y el guardia de antigüedad. Desde E4 el histórico
//    puede quedar ENLAZADO a Dropea (y por tanto entrar en el polling de
//    tracking), así que este gate es lo que impide que un pedido de hace dos
//    meses le escriba a su cliente. El estado de envío sí se guarda: lo que
//    se corta es el mensaje, no la trazabilidad.
// ============================================================

import pino from "pino";
import {
  claimTrackingNotification,
  releaseTrackingNotification,
  setOrderSupplierReview,
  type OrderRow,
  type TrackingNotificationKind,
} from "../db";
import { logIntegrationEvent } from "../system/repo";
import { formatMoney } from "../orders/messages";
import { sendWhatsAppInteractive, sendWhatsAppMessage } from "../whatsapp";
import { canSendRealWhatsApp } from "../safety";
import { buildApprovedTemplateMessage, getTemplateReadiness } from "../whatsapp/templates";
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


function trackingOrderNumber(order: OrderRow): string {
  const value = String(order.shopify_order_number ?? "").trim();
  if (!value) return "pedido";
  return value.startsWith("#") ? value : `#${value}`;
}

/**
 * FAIL-CLOSED de datos (P0-C, 02-09): al cliente JAMÁS le llega
 * "No disponible", "el transportista", "—" ni un hueco. Si la plantilla
 * real necesita un dato y no lo tenemos, el aviso NO sale y el pedido va
 * a revisión con motivo tracking_payload_incomplete — visible en Acciones.
 */
export function trackingPayloadIssues(order: OrderRow, event: TrackingEvent): string[] {
  const problemas: string[] = [];
  if (event === "TRACKING_AVAILABLE") {
    // La plantilla real (pedido_confirmado_casamable) lleva transportista,
    // número de seguimiento Y enlace: los tres son huecos del cuerpo.
    if (!(order.carrier ?? "").trim()) problemas.push("sin transportista");
    if (!(order.tracking_number ?? "").trim()) problemas.push("sin número de seguimiento");
    const url = (order.tracking_url ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) problemas.push("sin URL de seguimiento válida");
  }
  if (event === "OUT_FOR_DELIVERY") {
    // reparto_hoy menciona al transportista: solo si existe de verdad.
    if (!(order.carrier ?? "").trim()) problemas.push("sin transportista");
  }
  return problemas;
}

/**
 * Los avisos de tracking resuelven su plantilla por clave LÓGICA (mapping
 * verificado por whatsapp:templates:doctor), igual que la confirmación
 * inicial. Incidente 02-09: reparto_hoy se editó en Meta (título + TTL) y
 * volvió a PENDING; dos avisos de reparto fallaron con 132001 y esos
 * clientes recibieron el paquete sin saber el importe. Con la verificación
 * cacheada, una plantilla en revisión BLOQUEA el aviso con motivo visible.
 */
const EVENT_TEMPLATE_KEY: Partial<Record<TrackingEvent, string>> = {
  TRACKING_AVAILABLE: "tracking_available",
  OUT_FOR_DELIVERY: "out_for_delivery_cod",
};

function buildTrackingAvailableOutbound(order: OrderRow) {
  return {
    message: buildApprovedTemplateMessage("tracking_available", {
      nombre: firstName(order) || "cliente",
      numero_pedido: trackingOrderNumber(order),
      transportista: (order.carrier ?? "").trim(),
      numero_seguimiento: (order.tracking_number ?? "").trim(),
      tracking_url: (order.tracking_url ?? "").trim(),
    }),
    fallbackText: buildTrackingAvailableMessage(order),
  };
}

function buildOutForDeliveryOutbound(order: OrderRow) {
  return {
    message: buildApprovedTemplateMessage("out_for_delivery_cod", {
      nombre: firstName(order) || "cliente",
      numero_pedido: trackingOrderNumber(order),
      transportista: (order.carrier ?? "").trim(),
      importe: formatMoney(order.total_price, order.currency),
    }),
    fallbackText: buildOutForDeliveryMessage(order),
  };
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
  // Historial: jamás se le escribe a nadie. Va lo PRIMERO, delante de
  // cualquier otro gate, para que ningún camino nuevo lo esquive.
  if (order.status === "ignored_old") {
    logger.info(
      `[TRACKING] #${order.shopify_order_number} ${event}: pedido ignored_old (historial), sin aviso al cliente`
    );
    logIntegrationEvent(
      "tracking",
      "notification_skipped_by_gate",
      "info",
      `aviso ${event} omitido: el pedido está en ignored_old (historial, nunca accionable)`,
      order.shopify_order_number
    );
    return false;
  }

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

  // ── P0-B (02-09): GATE ANTES DEL CLAIM ──
  // El orden viejo era claim → gate: un bloqueo deliberado (TEST_MODE,
  // allowlist, safe mode) CONSUMÍA el sello, y al abrir el gate después el
  // aviso ya no podía salir nunca. Ahora el gate se comprueba PRIMERO: un
  // bloqueo no consume nada, y si el gate se abre más tarde el aviso sigue
  // disponible.
  const opts = {
    name: order.customer_name ?? undefined,
    orderAuthorized: order.pilot_authorized === 1,
  };
  if (!canSendRealWhatsApp(order.phone, { orderAuthorized: opts.orderAuthorized })) {
    logger.info(`[TRACKING] #${order.shopify_order_number} ${event}: bloqueado por safety gates ANTES del claim (no se consume)`);
    logIntegrationEvent(
      "tracking",
      "notification_skipped_by_gate",
      "info",
      `aviso ${event} bloqueado por safety gates (sello NO consumido: saldrá si el gate se abre)`,
      order.shopify_order_number
    );
    return false;
  }

  // ── P0-C (02-09): COMPLETITUD ANTES DEL CLAIM ──
  // Datos incompletos tampoco consumen el sello: cuando el proveedor traiga
  // el tracking/transportista de verdad, el aviso podrá salir.
  const incompleto = trackingPayloadIssues(order, event);
  if (incompleto.length > 0) {
    aRevision(order, `tracking_payload_incomplete: aviso ${event} sin datos suficientes (${incompleto.join(", ")}) — no se envía nada a medias`);
    logIntegrationEvent("tracking", "tracking_payload_incomplete", "warning", `aviso ${event} retenido: ${incompleto.join(", ")}`, order.shopify_order_number);
    return false;
  }

  // ── Plantilla REAL verificada (02-09): PENDING/no verificada = bloqueo
  // visible SIN consumir el sello. Cuando el doctor la vea APPROVED, el
  // aviso podrá salir.
  const tplKey = EVENT_TEMPLATE_KEY[event];
  if (tplKey) {
    const r = getTemplateReadiness(tplKey);
    if (!r.ready) {
      logger.warn(`[TRACKING] #${order.shopify_order_number} ${event}: plantilla no lista (${r.blocker}) — aviso retenido, sello NO consumido`);
      logIntegrationEvent("whatsapp", "template_not_ready", "warning", `aviso ${event} retenido (${r.blocker}): ${r.detail}`.slice(0, 300), order.shopify_order_number);
      return false;
    }
  }

  // Claim atómico: de dos workers con la misma transición, EXACTAMENTE uno
  // pasa de aquí. Si ya se avisó, aquí se acaba.
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
  let encolado: boolean;
  try {
      if (event === "TRACKING_AVAILABLE") {
        encolado = sendWhatsAppInteractive(
          order.phone,
          buildTrackingAvailableOutbound(order),
          opts
        );
      } else if (event === "OUT_FOR_DELIVERY") {
        encolado = sendWhatsAppInteractive(
          order.phone,
          buildOutForDeliveryOutbound(order),
          opts
        );
      } else {
        // Los demás eventos conservan por ahora el comportamiento anterior.
        encolado = sendWhatsAppMessage(order.phone, texto, opts);
      }
  } catch (err) {
    // Fallo real (excepción al encolar, no un bloqueo deliberado): el sello
    // se DEVUELVE — un aviso que no llegó a la cola no puede quedar como
    // "enviado". Sí cuenta para la alerta de avisos fallidos.
    releaseTrackingNotification(order.id, sello);
    const motivo = err instanceof Error ? err.message : String(err);
    logger.error(`[WHATSAPP] #${order.shopify_order_number} ${event}: fallo al encolar — ${motivo} (sello devuelto)`);
    logIntegrationEvent("tracking", "notification_failed", "warning", `aviso ${event} falló al encolar: ${motivo} (se reintentará)`, order.shopify_order_number);
    return false;
  }

  if (!encolado) {
    // El gate cambió entre nuestro pre-check y el encolado (carrera con un
    // cambio de settings/env): el sello se devuelve igual que en el fallo —
    // bloqueado deliberadamente NUNCA consume.
    releaseTrackingNotification(order.id, sello);
    logger.info(`[WHATSAPP] #${order.shopify_order_number} ${event}: bloqueado por safety gates en el encolado (sello devuelto)`);
    logIntegrationEvent("tracking", "notification_skipped_by_gate", "info", `aviso ${event} bloqueado por safety gates (sello devuelto)`, order.shopify_order_number);
    return false;
  }

  logger.info(`[WHATSAPP] #${order.shopify_order_number} queued ${event}`);
  return true;
}
