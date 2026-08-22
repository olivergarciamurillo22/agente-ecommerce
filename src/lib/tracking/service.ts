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
  setOrderSupplierReview,
  updateOrderTracking,
  type OrderRow,
} from "../db";
import { normalizeSupplierStatus } from "./normalizer";
import { notifyTrackingEvent } from "./notifications";
import type { SupplierUpdate, TrackingEvent, TrackingStatus } from "./types";

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
  incident: -1,
  returned: -1,
  cancelled: -1,
};

/**
 * Procesa una actualización del proveedor sobre un pedido.
 *
 * IDEMPOTENTE: si el estado y el tracking no cambian, no pasa nada. Los
 * avisos se reclaman con un sello atómico en la base de datos, así que
 * repetir el mismo webhook no reenvía mensajes.
 */
export function processSupplierUpdate(order: OrderRow, update: SupplierUpdate): ProcessUpdateResult {
  const previousStatus = (order.supplier_status_normalized ?? "unknown") as TrackingStatus;
  const normalizado = normalizeSupplierStatus(update.rawStatus);

  // Un estado desconocido NO pisa lo que ya sabíamos: si el proveedor manda
  // una palabra que no entendemos, conservamos el estado anterior.
  let newStatus: TrackingStatus = normalizado === "unknown" ? previousStatus : normalizado;

  // Updates atrasados (llegan desordenados): no retroceder en la línea
  // normal. Incidencias, devoluciones y cancelaciones sí mandan siempre.
  if (ORDEN[newStatus] >= 0 && ORDEN[previousStatus] > ORDEN[newStatus]) {
    logger.info(
      `[TRACKING] #${order.shopify_order_number} update atrasado (${newStatus} tras ${previousStatus}): se ignora`
    );
    newStatus = previousStatus;
  }

  const nuevoTracking = (update.trackingNumber ?? "").trim() || null;
  const teniaTracking = Boolean((order.tracking_number ?? "").trim());
  const trackingAppeared = !teniaTracking && Boolean(nuevoTracking);

  // 1. Persistir lo que sabemos ahora.
  updateOrderTracking(order.id, {
    rawStatus: update.rawStatus ?? null,
    normalizedStatus: newStatus,
    trackingNumber: nuevoTracking,
    trackingUrl: update.trackingUrl ?? null,
    carrier: update.carrier ?? null,
    firstTracking: trackingAppeared,
  });

  // 2. ¿Qué eventos produce este cambio?
  const events: TrackingEvent[] = [];
  if (trackingAppeared) events.push("TRACKING_AVAILABLE");
  if (newStatus !== previousStatus) {
    if (newStatus === "out_for_delivery") events.push("OUT_FOR_DELIVERY");
    if (newStatus === "delivered") events.push("DELIVERED");
    if (newStatus === "incident") events.push("INCIDENT");
    if (newStatus === "returned") events.push("RETURNED");
    logger.info(
      `[TRACKING] #${order.shopify_order_number} ${previousStatus} → ${newStatus}`
    );
  }

  // 3. Avisar. Cada notificación tiene su propio sello anti-duplicado.
  const fresco = getOrderById(order.id) ?? order;
  const notified: TrackingEvent[] = [];
  for (const evento of events) {
    if (notifyTrackingEvent(fresco, evento)) notified.push(evento);
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

  return { previousStatus, newStatus, events, notified, trackingAppeared };
}
