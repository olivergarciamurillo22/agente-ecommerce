// ============================================================
// Motor de tracking: recibe lo que cuenta el proveedor (por webhook o por
// polling), lo normaliza, detecta QUÉ HA CAMBIADO y dispara los avisos.
//
// Es la única puerta por la que entra información de envíos, así que aquí
// vive toda la garantía de idempotencia: procesar dos veces el mismo update
// no produce dos WhatsApps ni dos transiciones.
// ============================================================

import pino from "pino";
import {
  getOrderById,
  insertOrderStatusHistory,
  setOrderSupplierReview,
  updateOrderTracking,
  type OrderRow,
} from "../db";
import { normalizeSupplierStatus } from "./normalizer";
import { notifyTrackingEvent } from "./notifications";
import { isTerminalTracking } from "./types";
import type { SupplierUpdate, TrackingEvent, TrackingStatus } from "./types";
import { logIntegrationEvent } from "../system/repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export interface ProcessUpdateResult {
  /** Estado normalizado ANTES de este update. */
  previousStatus: TrackingStatus;
  /** Estado normalizado DESPUÉS. */
  newStatus: TrackingStatus;
  /** Eventos detectados en esta transición (vacío si no cambió nada). */
  events: TrackingEvent[];
  /** Eventos que además se han traducido en un WhatsApp encolado. */
  notified: TrackingEvent[];
  /** true si en este update apareció el tracking por primera vez. */
  trackingAppeared: boolean;
  /** Id de la fila de order_status_history creada (null si no hubo transición o era duplicado). */
  historyId: number | null;
}

/** Orden del ciclo de vida: sirve para no "retroceder" con updates atrasados. */
const ORDEN: Record<TrackingStatus, number> = {
  unknown: 0,
  created: 1,
  processing: 2,
  shipped: 3,
  in_transit: 4,
  out_for_delivery: 5,
  delivered: 6,
  // Estados fuera de la línea normal: no compiten por orden.
  // (intento fallido y punto de recogida pueden llegar tras "en reparto" y
  // volver a "en reparto" al día siguiente: no son retrocesos).
  delivery_attempted: -1,
  at_pickup_point: -1,
  incident: -1,
  returned: -1,
  cancelled: -1,
};

function formatPickupPoint(p: SupplierUpdate["pickupPoint"]): string | null {
  if (!p) return null;
  const partes = [p.name, p.address, p.url].map((x) => (x ?? "").trim()).filter(Boolean);
  return partes.length ? partes.join(" · ").slice(0, 500) : null;
}

/**
 * Procesa una actualización del proveedor sobre un pedido.
 *
 * IDEMPOTENTE: si el estado y el tracking no cambian, no pasa nada. Los
 * avisos se reclaman con un sello atómico en la base de datos, así que
 * repetir el mismo webhook no reenvía mensajes.
 */
export function processSupplierUpdate(order: OrderRow, update: SupplierUpdate): ProcessUpdateResult {
  const previousStatus = (order.supplier_status_normalized ?? "unknown") as TrackingStatus;
  // Si el provider ya lo tradujo con su propio catálogo, se respeta; si no,
  // se usa el normalizador genérico.
  const normalizado = update.normalizedOverride ?? normalizeSupplierStatus(update.rawStatus);

  // Un estado desconocido NO pisa lo que ya sabíamos: si el proveedor manda
  // una palabra que no entendemos, conservamos el estado anterior.
  let newStatus: TrackingStatus = normalizado === "unknown" ? previousStatus : normalizado;

  // CAPA 1 — Estados TERMINALES del eje logístico: no se abandonan.
  //
  // El guardado por ORDEN de abajo NO cubría esto: `returned`, `cancelled` e
  // `incident` valen -1, así que quedaban fuera de la comparación y CUALQUIER
  // evento posterior podía sacarlos de ahí. Comprobado antes de arreglarlo:
  // `returned → shipped`, `cancelled → delivered` y `returned → delivered`
  // pasaban sin problema. Un webhook atrasado o un reintento del proveedor
  // convertía una devolución en un envío vivo, y el pedido volvía a las
  // colas de seguimiento como si nada.
  //
  // Política, igual que en el eje de cierre (canTransitionClosure): un
  // terminal solo admite repetirse a sí mismo. Cualquier otra cosa se
  // descarta y queda registrada para que la vea un humano — porque si el
  // proveedor de verdad está diciendo eso, hay algo que entender, no que
  // aplicar a ciegas.
  if (isTerminalTracking(previousStatus) && newStatus !== previousStatus) {
    logger.warn(
      `[TRACKING] #${order.shopify_order_number} intento de salir del terminal ${previousStatus} hacia ${newStatus}: descartado`
    );
    logIntegrationEvent(
      "tracking",
      "terminal_regression_blocked",
      "warning",
      `el proveedor reporta "${newStatus}" sobre un envío ya ${previousStatus}: no se aplica, revisar a mano`,
      order.shopify_order_number
    );
    newStatus = previousStatus;
  }

  // CAPA 2 — Updates atrasados dentro de la línea normal: no retroceder.
  // Incidencias, intentos de entrega y puntos de recogida sí pueden llegar
  // tras "en reparto" y volver a "en reparto" al día siguiente: no son
  // retrocesos y por eso quedan fuera de esta comparación.
  if (ORDEN[newStatus] >= 0 && ORDEN[previousStatus] > ORDEN[newStatus]) {
    logger.info(
      `[TRACKING] #${order.shopify_order_number} update atrasado (${newStatus} tras ${previousStatus}): se ignora`
    );
    newStatus = previousStatus;
  }

  const nuevoTracking = (update.trackingNumber ?? "").trim() || null;
  const teniaTracking = Boolean((order.tracking_number ?? "").trim());
  const trackingAppeared = !teniaTracking && Boolean(nuevoTracking);

  const pickupInfo = formatPickupPoint(update.pickupPoint);

  // 1. Persistir lo que sabemos ahora.
  updateOrderTracking(order.id, {
    rawStatus: update.rawStatus ?? null,
    normalizedStatus: newStatus,
    trackingNumber: nuevoTracking,
    trackingUrl: update.trackingUrl ?? null,
    carrier: update.carrier ?? null,
    pickupPointInfo: pickupInfo,
    firstTracking: trackingAppeared,
  });

  // 2. ¿Qué eventos produce este cambio?
  const events: TrackingEvent[] = [];
  let historyId: number | null = null;
  if (trackingAppeared) events.push("TRACKING_AVAILABLE");
  if (newStatus !== previousStatus) {
    if (newStatus === "out_for_delivery") events.push("OUT_FOR_DELIVERY");
    if (newStatus === "delivery_attempted") events.push("DELIVERY_ATTEMPT_FAILED");
    if (newStatus === "at_pickup_point") events.push("PICKUP_POINT_AVAILABLE");
    if (newStatus === "delivered") events.push("DELIVERED");
    if (newStatus === "incident") events.push("INCIDENT");
    if (newStatus === "returned") events.push("RETURNED");
    logger.info(
      `[TRACKING] #${order.shopify_order_number} ${previousStatus} → ${newStatus}`
    );
    // Histórico: la transición REAL, una sola vez (dedupe por event_id o
    // por transición reciente). Es la base de la tasa de entrega.
    historyId = insertOrderStatusHistory({
      orderId: order.id,
      shopifyOrderId: order.shopify_order_id,
      supplierPlatform: order.supplier_platform ?? null,
      carrier: (update.carrier ?? order.carrier) ?? null,
      previousStatus,
      newStatus,
      rawStatus: update.rawStatus ?? null,
      rawSubStatus: update.rawSubStatus ?? null,
      source: update.source ?? "polling",
      eventId: update.eventId ?? null,
      occurredAt: update.occurredAt ?? null,
    });
    // Feed del Control Center: qué cambió, en qué pedido, desde qué proveedor.
    logIntegrationEvent(
      (order.supplier_platform === "dropea" || order.supplier_platform === "dropi"
        ? order.supplier_platform
        : "tracking"),
      "tracking_update",
      newStatus === "incident" || newStatus === "returned" ? "warning" : "info",
      `envío: ${previousStatus} → ${newStatus}`,
      order.shopify_order_number
    );
  }

  // 3. Avisar. Cada notificación tiene su propio sello anti-duplicado.
  //    Con suppressNotifications, el estado se actualiza igual pero no se
  //    encola nada: el aviso NO queda pendiente para más tarde (el sello
  //    anti-duplicado no se reclama), es un silencio deliberado.
  const fresco = getOrderById(order.id) ?? order;
  const notified: TrackingEvent[] = [];
  if (!update.suppressNotifications) {
    for (const evento of events) {
      if (notifyTrackingEvent(fresco, evento)) notified.push(evento);
    }
  }

  // 4. Las incidencias y devoluciones piden intervención humana: se marcan
  //    para que Pedro las vea en el panel, SIN escribir al cliente.
  //
  //    A propósito NO se toca `orders.status`: ese campo representa si el
  //    CLIENTE confirmó su pedido, y la lista de "necesitan llamada" es de
  //    quien no contestó al WhatsApp. Una incidencia de envío es otra cosa y
  //    vive en supplier_sync_status, visible en la columna Proveedor.
  if (events.includes("INCIDENT") || events.includes("RETURNED")) {
    setOrderSupplierReview(
      order.id,
      `el proveedor reporta "${update.rawStatus ?? newStatus}": requiere revisión`
    );
  }

  return { previousStatus, newStatus, events, notified, trackingAppeared, historyId };
}
