// ============================================================
// Elegibilidad de CONFIRMACIÓN — la única verdad sobre si tiene sentido
// seguir pidiéndole a un cliente que confirme su pedido (por WhatsApp o por
// llamada). El hallazgo del 23-08 (10 "pendientes de llamada" de los que 4
// estaban anulados y 5 ya en fulfillment) nació de que cada consumidor
// razonaba por su cuenta; este predicado lo centraliza:
//
//   dashboard · scheduler de WhatsApp · scheduler de llamadas · reminders ·
//   métricas — TODOS preguntan aquí. Prohibido duplicar esta lógica.
//
// Dos ejes distintos (ver CLAUDE.md § 3 y § 5):
//   CLOSURE      = qué pasó con el pedido en el mundo real.
//   ELIGIBILITY  = ¿sigue teniendo sentido contactar para confirmar?
// `fulfilled` (closure in_progress) NO cierra el pedido, pero SÍ lo saca de
// la confirmación: ya salió hacia el cliente, confirmar llega tarde.
// ============================================================

import type { OrderRow } from "../db";

export interface EligibilityVerdict {
  eligible: boolean;
  /** Código estable del motivo (para métricas, panel y tests). */
  reason:
    | "eligible"
    | "no_phone"
    | "already_confirmed"
    | "operationally_cancelled"
    | "historical_import"
    | "processing_error"
    | "closure_cancelled"
    | "closure_delivered"
    | "closure_refused"
    | "fulfillment_in_progress";
  /** Explicación en cristiano para el panel. */
  detail: string;
}

const no = (reason: EligibilityVerdict["reason"], detail: string): EligibilityVerdict => ({
  eligible: false,
  reason,
  detail,
});

/**
 * ¿Sigue teniendo sentido pedirle confirmación al cliente de este pedido?
 * Función PURA sobre la fila: no toca DB ni red. No incluye DNC ni allowlist
 * (eso es política del CANAL de contacto, no del pedido; el scheduler de
 * llamadas lo comprueba aparte).
 */
export function isConfirmationEligible(order: OrderRow): EligibilityVerdict {
  // Eje de cierre: la realidad manda sobre cualquier cola local.
  switch (order.closure_status) {
    case "cancelled":
      return no("closure_cancelled", "cancelado en Shopify (o por fuente autoritativa)");
    case "delivered":
      return no("closure_delivered", "ya entregado");
    case "refused":
      return no("closure_refused", "rehusado/devuelto");
    case "in_progress":
      return no(
        "fulfillment_in_progress",
        "fulfillment en marcha (Shopify lo marcó despachado): confirmar ya no aplica"
      );
  }

  // Eje operativo.
  if (order.status === "confirmed") return no("already_confirmed", "el cliente ya confirmó");
  if (order.status === "cancelled") return no("operationally_cancelled", "cancelado en el agente");
  if (order.status === "ignored_old") {
    return no("historical_import", "histórico importado / demasiado antiguo: nunca accionable");
  }
  if (order.status === "error") return no("processing_error", "en estado de error: revisión humana");

  if (!order.phone) return no("no_phone", "sin teléfono de contacto");

  return { eligible: true, reason: "eligible", detail: "candidato real a confirmación" };
}

/** Azúcar para SQL/joins: closure aún desconocido y estado operativo vivo. */
export const CONFIRMATION_INELIGIBLE_STATUSES = ["confirmed", "cancelled", "ignored_old", "error"] as const;
