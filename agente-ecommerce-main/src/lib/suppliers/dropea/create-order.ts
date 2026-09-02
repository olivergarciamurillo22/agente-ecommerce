// ============================================================
// Creación de un pedido en Dropea: máquina de estados create → confirm.
//
// Su contrato son DOS pasos (crear deja el pedido en PENDING; confirmar lo
// manda al proveedor), y entre uno y otro el proceso puede caerse. El riesgo
// a evitar es: crear bien → reiniciar → volver a crear.
//
// Cómo se evita:
//   1. La fase se RECLAMA en SQLite antes de tocar la red (claim atómico).
//   2. La `Idempotency-Key` se deriva del pedido y se PERSISTE: un reintento
//      usa la misma clave, así que Dropea devuelve la respuesta cacheada en
//      vez de crear otro pedido.
//   3. Antes de crear se BUSCA por nuestra referencia: si ya existe (porque
//      lo creó su app oficial o un intento anterior), se adopta.
//
// HOY ESTO NO SE EJECUTA: `canCreateDropeaOrder()` lo bloquea con
// DROPEA_CREATE_MODE=external_app. La ruta queda lista y probada.
// ============================================================

import pino from "pino";
import { logIntegrationEvent } from "../../system/repo";
import {
  claimSupplierConfirm,
  claimSupplierCreate,
  getOrderById,
  markSupplierConfirmed,
  markSupplierCreateFailed,
  markSupplierCreated,
  setOrderDeliveryNoteStatus,
  type OrderRow,
} from "../../db";
import { dropeaRequest, DropeaOperationPendingError } from "./client";
import { canCreateDropeaOrder } from "./create-gate";
import { findDropeaOrderByExternalId } from "./index";
import { mapToDropeaCreateOrder, type DropeaMappingContext } from "./mapper";
import type { DropeaOrder } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/**
 * Clave de idempotencia ESTABLE, derivada del pedido. Nunca aleatoria: un
 * reintento debe usar exactamente la misma para que Dropea lo reconozca.
 * Formato admitido por su contrato: ^[A-Za-z0-9_-]{1,255}$
 */
export function buildIdempotencyKey(
  shopifyOrderId: string,
  operation: "create" | "confirm"
): string {
  const limpio = shopifyOrderId.replace(/[^A-Za-z0-9_-]/g, "");
  return `casamable-shopify-${limpio}-${operation}`.slice(0, 255);
}

export interface CreateOrderOutcome {
  ok: boolean;
  externalOrderId: string | null;
  /** Qué ocurrió, en cristiano. */
  detail: string;
  /** Freno que lo impidió, si no se hizo nada. */
  blocker?: string | null;
  /** true si el pedido ya existía y solo se adoptó. */
  adopted?: boolean;
}

/**
 * Crea (o adopta) el pedido en Dropea. Idempotente y segura ante reinicios.
 */
export async function createDropeaOrderForOrder(
  order: OrderRow,
  ctx: DropeaMappingContext,
  input: Parameters<typeof mapToDropeaCreateOrder>[0]
): Promise<CreateOrderOutcome> {
  // 1. GATE: hoy siempre bloquea (external_app).
  const gate = canCreateDropeaOrder(order);
  if (!gate.allowed) {
    return { ok: false, externalOrderId: null, detail: gate.reason ?? "bloqueado", blocker: gate.blocker };
  }

  // 2. Construir el cuerpo. Si falta un dato obligatorio, no se llama a nadie.
  const mapping = mapToDropeaCreateOrder(input, ctx);
  setOrderDeliveryNoteStatus(order.id, mapping.deliveryNoteStatus);
  if (!mapping.request) {
    markSupplierCreateFailed(order.id, mapping.errors.join("; "));
    return {
      ok: false,
      externalOrderId: null,
      detail: `no se puede construir el pedido: ${mapping.errors.join("; ")}`,
      blocker: "mapping",
    };
  }
  for (const w of mapping.warnings) {
    logger.warn(`[SUPPLIER] #${order.shopify_order_number}: ${w}`);
  }

  // 3. ANTES de crear: ¿existe ya en Dropea con nuestra referencia?
  //    Protege frente a la app oficial y frente a un intento previo perdido.
  try {
    const existente = await findDropeaOrderByExternalId(order.shopify_order_id);
    if (existente) {
      markSupplierCreated(order.id, "dropea", String(existente.id));
      logger.info(
        `[SUPPLIER] #${order.shopify_order_number} ya existía en Dropea (${existente.id}): adoptado, no se crea`
      );
      logIntegrationEvent("dropea", "order_adopted", "info", "ya existía en Dropea: adoptado en vez de crear", order.shopify_order_number);
      return {
        ok: true,
        externalOrderId: String(existente.id),
        detail: "el pedido ya existía en Dropea: adoptado",
        adopted: true,
      };
    }
  } catch (err) {
    // Si no podemos comprobarlo, NO creamos: crear a ciegas puede duplicar.
    const mensaje = err instanceof Error ? err.message : "error";
    return {
      ok: false,
      externalOrderId: null,
      detail: `no se pudo comprobar si el pedido ya existe en Dropea (${mensaje}): no se crea nada`,
      blocker: "precheck_failed",
    };
  }

  // 4. Reclamar la fase de creación con la clave estable.
  const idempotencyKey = buildIdempotencyKey(order.shopify_order_id, "create");
  if (!claimSupplierCreate(order.id, idempotencyKey)) {
    return {
      ok: false,
      externalOrderId: null,
      detail: "otra operación de creación ya está en curso o el pedido cambió de fase",
      blocker: "claim_failed",
    };
  }

  // 5. Crear de verdad. Sin reintentos automáticos.
  try {
    const creado = await dropeaRequest<DropeaOrder>({
      method: "POST",
      path: "/dropshipper/orders",
      body: mapping.request,
      idempotencyKey,
    });
    const externalId = String(creado.id);
    markSupplierCreated(order.id, "dropea", externalId);
    logger.info(`[SUPPLIER] #${order.shopify_order_number} creado en Dropea (${externalId})`);
    return { ok: true, externalOrderId: externalId, detail: "pedido creado en Dropea" };
  } catch (err) {
    if (err instanceof DropeaOperationPendingError) {
      // Sigue en curso: NO se marca como fallido (reintentar con la misma
      // clave devolvería el resultado, pero primero hay que consultar).
      logger.warn(
        `[SUPPLIER] #${order.shopify_order_number} creación en curso en Dropea (${err.operationId})`
      );
      return {
        ok: false,
        externalOrderId: null,
        detail: err.message,
        blocker: "operation_pending",
      };
    }
    const mensaje = err instanceof Error ? err.message : "error desconocido";
    markSupplierCreateFailed(order.id, mensaje);
    return { ok: false, externalOrderId: null, detail: mensaje, blocker: "api_error" };
  }
}

/**
 * Segundo paso: confirmar el pedido para que llegue al proveedor.
 * Solo procede si la creación terminó (fase `created`).
 */
export async function confirmDropeaOrder(orderId: number): Promise<CreateOrderOutcome> {
  const order = getOrderById(orderId);
  if (!order) return { ok: false, externalOrderId: null, detail: "pedido no encontrado" };
  if (!order.supplier_external_order_id) {
    return { ok: false, externalOrderId: null, detail: "el pedido aún no existe en Dropea", blocker: "not_created" };
  }
  if (order.supplier_create_phase === "confirmed") {
    return {
      ok: true,
      externalOrderId: order.supplier_external_order_id,
      detail: "ya estaba confirmado",
    };
  }

  const gate = canCreateDropeaOrder({ ...order, supplier_external_order_id: null });
  if (!gate.allowed && gate.blocker !== "already_exists") {
    return { ok: false, externalOrderId: null, detail: gate.reason ?? "bloqueado", blocker: gate.blocker };
  }

  const key = buildIdempotencyKey(order.shopify_order_id, "confirm");
  if (!claimSupplierConfirm(order.id, key)) {
    return {
      ok: false,
      externalOrderId: order.supplier_external_order_id,
      detail: "no se puede confirmar en la fase actual",
      blocker: "claim_failed",
    };
  }

  try {
    await dropeaRequest<DropeaOrder>({
      method: "POST",
      path: `/dropshipper/orders/${order.supplier_external_order_id}/confirm`,
      idempotencyKey: key,
    });
    markSupplierConfirmed(order.id);
    logger.info(`[SUPPLIER] #${order.shopify_order_number} confirmado en Dropea`);
    return {
      ok: true,
      externalOrderId: order.supplier_external_order_id,
      detail: "pedido confirmado en Dropea",
    };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error";
    markSupplierCreateFailed(order.id, `confirmación: ${mensaje}`);
    return {
      ok: false,
      externalOrderId: order.supplier_external_order_id,
      detail: mensaje,
      blocker: "api_error",
    };
  }
}
