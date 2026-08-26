// ============================================================
// POLÍTICA DEL EJE DE CIERRE — un solo sitio donde se decide
// "¿cómo terminó económicamente este pedido?".
//
// Decisión de arquitectura (25-08-2026, Óliver). El sistema tiene CUATRO
// máquinas de estado distintas que NO se fusionan:
//
//   1. CustomerConfirmationStatus  → `orders.status`                (OrderStatus)
//   2. SupplierSyncStatus          → `orders.supplier_sync_status`  (SupplierSyncStatus)
//   3. TrackingStatus              → `orders.supplier_status_normalized`
//   4. OrderClosureStatus          → `orders.closure_status`        (ClosureStatus)
//
// El eje 4 es la FUENTE DE VERDAD DEL NEGOCIO: tasa de entrega, ingresos
// entregados y coste de rehúse salen de ahí y solo de ahí. El eje 3 es
// detalle logístico y puede APORTAR EVIDENCIA, nunca sustituirlo.
// Documentación completa: docs/MODELO-ESTADOS.md.
//
// ── POR QUÉ ESTE FICHERO EXISTE ────────────────────────────────
// Antes, la traducción "estado del proveedor → cierre" vivía dentro del
// reconciliador de Dropea y traducía desde el estado YA NORMALIZADO
// (`returned` → `refused`). Eso mete un error de negocio silencioso: en el
// vocabulario de Dropea `REFUSED` (el cliente rechaza el COD) y
// `REFUSED_LOST_DAMAGED` (el paquete se perdió o se rompió) normalizan los
// DOS a `returned`, y no son lo mismo ni de lejos. Contar el segundo como
// rehúse infla la tasa de rehúse y ensucia justo la métrica que decide si la
// publicidad es rentable.
//
// Por eso aquí se traduce desde los SUB-ESTADOS OFICIALES del proveedor, no
// desde nuestra normalización: menos pérdida de información, y cada regla
// apoyada en el vocabulario que el propio proveedor documenta.
//
// ── REGLA DE ORO ───────────────────────────────────────────────
// Sin evidencia, `null`: no se escribe nada y el pedido se queda como
// estaba. `unknown` significa "no lo sabemos", y es una respuesta legítima
// y preferible a un terminal inventado — que además sería IRREVERSIBLE
// (canTransitionClosure bloquea abandonar un terminal).
// ============================================================

import type { ClosureStatus } from "../db";
import type { TrackingStatus } from "../tracking/types";
import type { DropeaStatus, DropeaSubStatus } from "../suppliers/dropea/status-map";

/** Señal de cierre lista para escribirse. `at` SIEMPRE es la fecha del evento
 *  en la fuente, jamás `now()` (estampar now() corrompe el tiempo-hasta-cierre). */
export interface ClosurePlan {
  status: ClosureStatus;
  at: number;
  /** Por qué se decidió esto. Va a los logs y a integration_events. */
  reason: string;
}

/** Casos que merecen que un humano los mire aunque NO cierren el pedido. */
export interface ClosureReviewFlag {
  kind: "returned_not_refused";
  reason: string;
}

export interface ClosureDecision {
  /** `null` = no hay evidencia suficiente: NO se escribe nada. */
  plan: ClosurePlan | null;
  /** Presente si el caso hay que revisarlo a mano. */
  review: ClosureReviewFlag | null;
}

const SIN_EVIDENCIA: ClosureDecision = { plan: null, review: null };

/**
 * Sub-estados de Dropea que cierran el pedido, con su significado de negocio.
 *
 * Solo entran aquí los que el contrato de Dropea documenta sin ambigüedad
 * (ver `docs/DROPEA-API-CONTRACT.md` y `dropea/status-map.ts`). Lo que no
 * está en esta tabla NO cierra nada.
 */
const CIERRE_POR_SUB_ESTADO: Partial<Record<DropeaSubStatus, ClosureStatus>> = {
  // Entrega efectiva. En COD, PAID es la entrega cobrada: la mejor evidencia
  // posible de que el pedido terminó bien.
  DELIVERED: "delivered",
  PAID: "delivered",
  // Rehúse del cliente. Es LA palabra de Dropea para esto: el cliente no
  // aceptó el contrareembolso. Es el evento que cuesta ~9,37 €.
  REFUSED: "refused",
  // Cancelaciones antes del cierre normal.
  CANCELLED: "cancelled",
  REJECTED: "cancelled",
};

/**
 * Sub-estados que devuelven mercancía SIN que sea un rehúse del cliente.
 * Logísticamente el paquete vuelve (tracking `returned`), pero atribuirlo al
 * cliente sería falso. No cierran: los mira un humano.
 */
const DEVUELTO_PERO_NO_REHUSADO: DropeaSubStatus[] = ["REFUSED_LOST_DAMAGED"];

/** Sub-estados que significan "sigue en marcha": cierre `in_progress`. */
const EN_CURSO_POR_SUB_ESTADO: DropeaSubStatus[] = [
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERY_ATTEMPTED",
];

/**
 * Traduce el par (status, sub_status) OFICIAL de Dropea a una decisión de
 * cierre. `at` lo pone quien llama, con la fecha del evento en la fuente.
 *
 * Reglas, en orden:
 *  1. Sub-estado con significado de cierre documentado → ese cierre.
 *  2. `REFUSED_LOST_DAMAGED` → NO cierra + marca de revisión: volvió el
 *     paquete, pero no por decisión del cliente.
 *  3. Sub-estado "en manos del transportista" → `in_progress`.
 *  4. Incidencias (`DELIVERY_EXCEPTION`, `LOST_DAMAGED`, `REVIEW`,
 *     `TECHNICAL_ERROR`, `INSUFFICIENT_STOCK`, `CARRIER_VALIDATION_FAILED`,
 *     `WAREHOUSE_INTEGRATION_FAILED`) → NO tocan el cierre. Una incidencia
 *     no es un desenlace: el pedido se queda donde estaba.
 *  5. Preparación (`CREATING`, `PICKING`, `PACKED`…) → NO cierra: aún no ha
 *     salido nada, `in_progress` sería mentira.
 *  6. Cualquier otra cosa → sin evidencia.
 */
export function planClosureFromDropea(
  status: string | null | undefined,
  subStatus: string | null | undefined,
  at: number | null
): ClosureDecision {
  const sub = (subStatus ?? "").trim().toUpperCase() as DropeaSubStatus;
  const st = (status ?? "").trim().toUpperCase() as DropeaStatus;

  if (DEVUELTO_PERO_NO_REHUSADO.includes(sub)) {
    return {
      plan: null,
      review: {
        kind: "returned_not_refused",
        reason:
          `Dropea reporta ${sub}: el paquete volvió, pero por pérdida o daño, ` +
          "NO por rehúse del cliente. No se cierra como refused para no ensuciar la tasa de rehúse — decidir a mano",
      },
    };
  }

  if (at === null) return SIN_EVIDENCIA; // sin fecha de la fuente no se escribe: nunca now()

  const cierre = CIERRE_POR_SUB_ESTADO[sub];
  if (cierre) {
    return { plan: { status: cierre, at, reason: `Dropea sub_status=${sub}` }, review: null };
  }

  if (EN_CURSO_POR_SUB_ESTADO.includes(sub)) {
    return { plan: { status: "in_progress", at, reason: `Dropea sub_status=${sub}` }, review: null };
  }

  // Sin sub-estado útil, el status de primer nivel solo puede afirmar "va en
  // camino". FINISH NO entra: es terminal, pero el QUÉ lo dice el sub_status,
  // y sin él no se puede afirmar que se entregó.
  if (!sub && st === "SHIPPING") {
    return { plan: { status: "in_progress", at, reason: "Dropea status=SHIPPING" }, review: null };
  }

  return SIN_EVIDENCIA;
}

/**
 * Puente GENÉRICO tracking → cierre, para fuentes que no son Dropea.
 *
 * Hoy devuelve `null` siempre y a propósito:
 *  - **Dropi PRO** no tiene mapa de estados confirmado (su API sigue sin
 *    documentar). Inferir un cierre de un estado que no entendemos sería
 *    inventarse el dato de negocio más caro que tenemos.
 *  - Cualquier proveedor futuro entra por aquí y arranca igual de cerrado.
 *
 * Se deja como función (y no como "no existe") para que el día que llegue el
 * catálogo de Dropi haya UN sitio evidente donde enchufarlo, con su test.
 */
export function planClosureFromTracking(
  _tracking: TrackingStatus,
  _platform: string | null,
  _at: number | null
): ClosureDecision {
  return SIN_EVIDENCIA;
}

/**
 * ¿Este cierre cuenta para la tasa de entrega?
 *
 * FÓRMULA ACORDADA:
 *     tasa = delivered / (delivered + refused)
 *
 * `unknown`, `in_progress` y `cancelled` NO entran ni en el numerador ni en
 * el denominador. Un pedido cancelado no es una entrega fallida: nunca se
 * intentó entregar. Meterlo en el denominador hundiría la tasa por motivos
 * que no tienen nada que ver con la logística.
 */
export function countsInDeliveryRate(closure: ClosureStatus): boolean {
  return closure === "delivered" || closure === "refused";
}

/** delivered / (delivered + refused). `null` si no hay ni un pedido resuelto. */
export function computeClosureDeliveryRate(delivered: number, refused: number): number | null {
  const resueltos = delivered + refused;
  if (resueltos === 0) return null;
  return Math.round((delivered / resueltos) * 10000) / 100;
}
