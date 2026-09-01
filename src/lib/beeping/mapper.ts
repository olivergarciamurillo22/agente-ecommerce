// ============================================================
// Traducción de los estados de Beeping a nuestro vocabulario.
//
// Dos catálogos documentados: `status` del pedido (0-6) y `tracking_stage`
// logístico (1-8). Cuando hay estado logístico real (>1), MANDA sobre el
// del pedido — es más preciso, igual que el sub_status de Dropea.
//
// Decisiones deliberadas (no "mejorarlas" sin contrato):
//  - Returned (5 / stage 6) NO se asume rehúse del cliente: va a `returned`
//    en el eje logístico y el CIERRE queda para revisión humana. `refused`
//    y `returned` tienen consecuencias económicas distintas.
//  - Damaged (stage 8) → incidencia / revisión manual, jamás un aviso al
//    cliente.
//  - Solo delivered y cancelled escriben el eje de cierre automáticamente.
// ============================================================

import type { ClosureStatus } from "../db";
import type { TrackingStatus } from "../tracking/types";
import { BEEPING_COURIERS, BEEPING_LOGISTICS_STATUS, BEEPING_ORDER_STATUS } from "./types";

export interface BeepingStatusMapping {
  /** Nuestro eje logístico. */
  tracking: TrackingStatus;
  /** Cierre de negocio, si este estado lo determina por sí solo. */
  closure: ClosureStatus | null;
  /** true → debe aparecer en revisión humana (Action Center). */
  needsReview: boolean;
}

/** `status` del pedido (0-6) → nuestro vocabulario. */
export function mapBeepingOrderStatus(code: number | null): BeepingStatusMapping {
  switch (code) {
    case 0: // Cancelled
      return { tracking: "cancelled", closure: "cancelled", needsReview: false };
    case 1: // Pending: liberado, en cola del almacén
      return { tracking: "created", closure: "in_progress", needsReview: false };
    case 2: // Pending Stock: retenido por stock — Pedro debe saberlo
      return { tracking: "processing", closure: "in_progress", needsReview: true };
    case 3: // In Preparation
      return { tracking: "processing", closure: "in_progress", needsReview: false };
    case 4: // Shipped
      return { tracking: "shipped", closure: "in_progress", needsReview: false };
    case 5: // Returned — ¿rehusado? ¿perdido? El cierre lo decide un humano.
      return { tracking: "returned", closure: null, needsReview: true };
    case 6: // To be confirmed: aún retenido por Casamable, nada que trackear
      return { tracking: "unknown", closure: null, needsReview: false };
    default:
      return { tracking: "unknown", closure: null, needsReview: false };
  }
}

/** `tracking_stage` logístico (1-8) → nuestro vocabulario. */
export function mapBeepingLogistics(code: number | null): BeepingStatusMapping | null {
  switch (code) {
    case 2:
      return { tracking: "in_transit", closure: "in_progress", needsReview: false };
    case 3:
      return { tracking: "out_for_delivery", closure: "in_progress", needsReview: false };
    case 4:
      return { tracking: "at_pickup_point", closure: "in_progress", needsReview: false };
    case 5:
      return { tracking: "delivered", closure: "delivered", needsReview: false };
    case 6: // Returned to Sender — NO asumir rehúse: revisión humana
      return { tracking: "returned", closure: null, needsReview: true };
    case 7:
      return { tracking: "cancelled", closure: "cancelled", needsReview: false };
    case 8: // Damaged — incidencia, jamás mensaje al cliente
      return { tracking: "incident", closure: null, needsReview: true };
    case 1: // "No logistic status": no aporta nada
    default:
      return null;
  }
}

/**
 * Mapping combinado de un pedido de Beeping: el estado logístico real (>1)
 * manda; si no lo hay, decide el `status` del pedido.
 */
export function mapBeepingOrder(status: number | null, trackingStage: number | null): BeepingStatusMapping {
  return mapBeepingLogistics(trackingStage) ?? mapBeepingOrderStatus(status);
}

/** Texto crudo legible para supplier_status_raw (conservar SIEMPRE el raw). */
export function beepingRawStatusLabel(status: number | null, trackingStage: number | null): string {
  const s = status !== null ? (BEEPING_ORDER_STATUS[status as keyof typeof BEEPING_ORDER_STATUS] ?? `status_${status}`) : "status_null";
  const t =
    trackingStage !== null
      ? (BEEPING_LOGISTICS_STATUS[trackingStage as keyof typeof BEEPING_LOGISTICS_STATUS] ?? `stage_${trackingStage}`)
      : null;
  return t && trackingStage !== 1 ? `${s}/${t}` : s;
}

export function beepingCourierName(courierId: number | null): string | null {
  if (courierId === null) return null;
  return BEEPING_COURIERS[courierId] ?? `courier_${courierId}`;
}

// --- Editar pedido (dirección corregida) ---

export type BeepingUpdatability =
  | { allowed: true }
  | { allowed: false; reason: "needs_manual_validation" | "unsupported_status"; message: string };

/**
 * La doc de PUT /api/order/{external_id} dice que SOLO se pueden editar
 * pedidos en 1 (Pending) o 2 (Pending Stock). Hay una inconsistencia
 * aparente con el flujo de 6 (To be confirmed): NO adivinamos. Hasta probar
 * el contrato real, un pedido en 6 va a validación manual.
 */
export function canUpdateBeepingOrder(status: number | null): BeepingUpdatability {
  if (status === 1 || status === 2) return { allowed: true };
  if (status === 6) {
    return {
      allowed: false,
      reason: "needs_manual_validation",
      message:
        "el pedido está en 'To be confirmed' y la doc de Beeping solo documenta edición en Pending/Pending Stock: corregir en el panel de Beeping a mano hasta confirmar el contrato",
    };
  }
  return {
    allowed: false,
    reason: "unsupported_status",
    message: "Beeping solo documenta edición de pedidos en Pending o Pending Stock",
  };
}

// --- Fechas de Beeping (módulo PURO: los scripts de datos importan esto
// sin arrastrar el motor de tracking ni nada que alcance WhatsApp) ---

/** dd-mm-yyyy, el formato que documenta el filtro from_date de Beeping. */
export function toBeepingDate(epochS: number): string {
  const d = new Date(epochS * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/**
 * Fecha de Beeping → epoch. El formato real no está documentado: se acepta
 * ISO y dd-mm-yyyy[ hh:mm[:ss]]. Si no se entiende, null (JAMÁS inventar
 * un now() como fecha del hecho).
 */
export function parseBeepingDate(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) {
    const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  const iso = Date.parse(v);
  if (Number.isFinite(iso)) return Math.floor(iso / 1000);
  return null;
}

// --- Nota de expedición ---

export type DispatchNoteMapping = { supported: false; reason: string } | { supported: true; field: string; value: string };

/**
 * Adapter FUTURO de la nota de expedición hacia Beeping. La API pública no
 * documenta ningún campo de notas/comentarios en el pedido, así que hoy
 * SIEMPRE devuelve unsupported: la nota es interna de Casamable. Cuando
 * Beeping confirme campo y semántica, solo habrá que rellenar esto.
 */
export function mapDispatchNote(_note: string): DispatchNoteMapping {
  return {
    supported: false,
    reason: "la API pública de Beeping no documenta campo de notas de pedido (pregunta enviada; ver docs/BEEPING-INTEGRATION.md)",
  };
}
