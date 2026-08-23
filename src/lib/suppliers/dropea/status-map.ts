// ============================================================
// Traducción de los estados de Dropea a los nuestros.
//
// Basado en el spec OpenAPI oficial (verificado): 8 valores de `status` y
// 22 de `sub_status`. Ver docs/DROPEA-API-CONTRACT.md § 7.
//
// El `sub_status` MANDA sobre el `status` cuando existe, porque es mucho más
// preciso: `SHIPPING` solo dice "en manos del transportista", mientras que
// `OUT_FOR_DELIVERY` es exactamente el momento de avisar al cliente de que
// tenga preparado el efectivo.
// ============================================================

import type { TrackingStatus } from "../../tracking/types";

/** Los 8 valores de `status` del spec. */
export type DropeaStatus =
  | "DRAFT"
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "SHIPPING"
  | "DELIVERED"
  | "FINISH"
  | "ERROR";

/** Los 22 valores de `sub_status` del spec. */
export type DropeaSubStatus =
  | "CREATING"
  | "PENDING"
  | "PENDING_SUPPLIER"
  | "PICKING"
  | "PACKED"
  | "AWAITING_PICKUP"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERY_ATTEMPTED"
  | "DELIVERED"
  | "PAID"
  | "CANCELLED"
  | "REFUSED"
  | "LOST_DAMAGED"
  | "REFUSED_LOST_DAMAGED"
  | "DELIVERY_EXCEPTION"
  | "REVIEW"
  | "TECHNICAL_ERROR"
  | "REJECTED"
  | "INSUFFICIENT_STOCK"
  | "CARRIER_VALIDATION_FAILED"
  | "WAREHOUSE_INTEGRATION_FAILED";

export const DROPEA_STATUSES: DropeaStatus[] = [
  "DRAFT",
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPING",
  "DELIVERED",
  "FINISH",
  "ERROR",
];

export const DROPEA_SUB_STATUSES: DropeaSubStatus[] = [
  "CREATING",
  "PENDING",
  "PENDING_SUPPLIER",
  "PICKING",
  "PACKED",
  "AWAITING_PICKUP",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERY_ATTEMPTED",
  "DELIVERED",
  "PAID",
  "CANCELLED",
  "REFUSED",
  "LOST_DAMAGED",
  "REFUSED_LOST_DAMAGED",
  "DELIVERY_EXCEPTION",
  "REVIEW",
  "TECHNICAL_ERROR",
  "REJECTED",
  "INSUFFICIENT_STOCK",
  "CARRIER_VALIDATION_FAILED",
  "WAREHOUSE_INTEGRATION_FAILED",
];

/**
 * `sub_status` → estado nuestro. Cubre los 22 valores del spec.
 * Cuando un sub-estado es ambiguo por sí solo (`PENDING`), se deja fuera y
 * decide el `status` de primer nivel.
 */
const POR_SUB_STATUS: Partial<Record<DropeaSubStatus, TrackingStatus>> = {
  // Preparación
  CREATING: "created",
  PENDING_SUPPLIER: "processing",
  PICKING: "processing",
  PACKED: "processing",
  AWAITING_PICKUP: "processing",
  // En manos del transportista
  SHIPPED: "shipped",
  OUT_FOR_DELIVERY: "out_for_delivery",
  // Entregado / cobrado (COD): ambos son entrega efectiva
  DELIVERED: "delivered",
  PAID: "delivered",
  // Cancelaciones
  CANCELLED: "cancelled",
  REJECTED: "cancelled",
  // Devoluciones al origen
  REFUSED: "returned",
  REFUSED_LOST_DAMAGED: "returned",
  // Intento de entrega fallido: el envío sigue vivo, el transportista
  // volverá a pasar. Es el momento de avisar al cliente (Fase A).
  DELIVERY_ATTEMPTED: "delivery_attempted",
  // Problemas que requieren intervención humana
  DELIVERY_EXCEPTION: "incident",
  LOST_DAMAGED: "incident",
  REVIEW: "incident",
  TECHNICAL_ERROR: "incident",
  INSUFFICIENT_STOCK: "incident",
  CARRIER_VALIDATION_FAILED: "incident",
  WAREHOUSE_INTEGRATION_FAILED: "incident",
  // PENDING queda fuera a propósito: significa cosas distintas según el
  // status padre, así que decide el nivel superior.
};

/** `status` → estado nuestro, para cuando no hay sub-estado o es ambiguo. */
const POR_STATUS: Record<DropeaStatus, TrackingStatus> = {
  DRAFT: "created",
  PENDING: "created",
  CONFIRMED: "processing",
  PROCESSING: "processing",
  SHIPPING: "in_transit",
  // Legacy: los pedidos nuevos nunca llegan aquí, pero los históricos sí.
  DELIVERED: "delivered",
  // FINISH es terminal, pero el QUÉ lo dice el sub_status (DELIVERED,
  // CANCELLED, PAID…). Sin sub-estado no se puede afirmar que se entregó.
  FINISH: "unknown",
  ERROR: "incident",
};

/**
 * Traduce el par (status, sub_status) de Dropea al nuestro.
 * Un valor no reconocido devuelve "unknown": no se adivina.
 */
export function normalizeDropeaStatus(
  status: string | null | undefined,
  subStatus?: string | null
): TrackingStatus {
  const sub = (subStatus ?? "").trim().toUpperCase() as DropeaSubStatus;
  const porSub = POR_SUB_STATUS[sub];
  if (porSub) return porSub;

  const st = (status ?? "").trim().toUpperCase() as DropeaStatus;
  const porStatus = POR_STATUS[st];
  if (porStatus) return porStatus;

  return "unknown";
}

/** ¿Reconocemos este par de estados? (para detectar huecos del mapa) */
export function isDropeaStatusKnown(status: string | null, subStatus?: string | null): boolean {
  return normalizeDropeaStatus(status, subStatus) !== "unknown";
}
