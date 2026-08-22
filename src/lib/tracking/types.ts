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
  | "DELIVERED"
  | "INCIDENT"
  | "RETURNED";

/** Lo que un proveedor nos cuenta de un envío (ya sea por webhook o polling). */
export interface SupplierUpdate {
  /** Estado con las palabras del proveedor, sin tocar. */
  rawStatus: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrier?: string | null;
}
