// ============================================================
// Estados de envío normalizados y eventos internos.
//
// Cada proveedor (Dropi, Dropea, y sus transportistas) usa sus propias
// palabras para decir lo mismo. Aquí vive NUESTRO vocabulario: el resto del
// sistema solo entiende estos estados, nunca los del proveedor.
// ============================================================

/**
 * Máquina de estados del envío.
 *
 *   unknown          → todavía no sabemos nada
 *   created          → el pedido existe en el proveedor
 *   processing       → lo están preparando
 *   shipped          → entregado al transportista (suele traer tracking)
 *   in_transit       → viajando
 *   out_for_delivery → EN REPARTO hoy (momento de recordar el efectivo)
 *   delivered        → entregado. TERMINAL
 *   incident         → incidencia (dirección mal, ausente, rechazo…)
 *   returned         → devuelto al origen. TERMINAL
 *   cancelled        → anulado. TERMINAL
 */
export type TrackingStatus =
  | "unknown"
  | "created"
  | "processing"
  | "shipped"
  | "in_transit"
  | "out_for_delivery"
  /**
   * Intento de entrega fallido (cliente ausente…). Confirmado en el contrato
   * de Dropea (`sub_status = DELIVERY_ATTEMPTED`). El envío sigue vivo: el
   * transportista volverá a intentarlo.
   */
  | "delivery_attempted"
  /**
   * Disponible en punto de recogida. NINGÚN proveedor lo reporta hoy (no
   * está en el spec de Dropea; Dropi sin catálogo). Existe en el vocabulario
   * para que el día que un proveedor lo confirme solo haya que mapearlo.
   */
  | "at_pickup_point"
  | "delivered"
  | "incident"
  | "returned"
  | "cancelled";

export const TRACKING_STATUSES: TrackingStatus[] = [
  "unknown",
  "created",
  "processing",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivery_attempted",
  "at_pickup_point",
  "delivered",
  "incident",
  "returned",
  "cancelled",
];

/** Estados en los que ya no hay nada más que consultar. */
export const TERMINAL_TRACKING_STATUSES: TrackingStatus[] = [
  "delivered",
  "returned",
  "cancelled",
];

export function isTerminalTracking(status: string): boolean {
  return (TERMINAL_TRACKING_STATUSES as string[]).includes(status);
}

/**
 * Eventos internos que produce el motor al comparar el estado anterior con
 * el nuevo. Son la ÚNICA vía por la que se dispara un WhatsApp de postventa.
 */
export type TrackingEvent =
  | "TRACKING_AVAILABLE"
  | "OUT_FOR_DELIVERY"
  | "DELIVERY_ATTEMPT_FAILED"
  | "PICKUP_POINT_AVAILABLE"
  | "DELIVERED"
  | "INCIDENT"
  | "RETURNED";

/** De dónde viene una actualización (se persiste en order_status_history). */
export type TrackingSource = "webhook" | "polling" | "manual" | "reconciliation";

/** Datos del punto de recogida, si el proveedor los manda. Sin PII nuestra. */
export interface PickupPointInfo {
  name?: string | null;
  address?: string | null;
  url?: string | null;
}

/** Lo que un proveedor nos cuenta de un envío (ya sea por webhook o polling). */
export interface SupplierUpdate {
  /** Estado con las palabras del proveedor, sin tocar. */
  rawStatus: string | null;
  /**
   * Estado YA normalizado por el provider, cuando este tiene su propio mapa
   * (p. ej. Dropi, que traduce por `status_id`). Si viene, manda sobre el
   * normalizador genérico: nadie conoce sus estados mejor que su provider.
   */
  normalizedOverride?: TrackingStatus;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrier?: string | null;
  /** Sub-estado del proveedor, tal cual (Dropea lo tiene; Dropi no). */
  rawSubStatus?: string | null;
  /** Origen del update. Por defecto "polling" (el caso sin webhook). */
  source?: TrackingSource;
  /** Id del evento del proveedor, si existe: dedupe del histórico. */
  eventId?: string | null;
  /** Momento del hecho según el proveedor (epoch s). Si no, ahora. */
  occurredAt?: number | null;
  /** Punto de recogida, si el proveedor lo reporta. */
  pickupPoint?: PickupPointInfo | null;
  /**
   * true → este update actualiza estado, histórico y cierre pero NO encola
   * ningún WhatsApp de postventa. Lo usa la reconciliación de Beeping
   * mientras sus avisos no estén habilitados (BEEPING_NOTIFICATIONS_ENABLED):
   * los safety gates siguen detrás, esto es una capa EXTRA deliberada.
   */
  suppressNotifications?: boolean;
}
