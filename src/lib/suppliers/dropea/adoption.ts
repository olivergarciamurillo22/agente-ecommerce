// ============================================================
// Adopción de pedidos creados por la app oficial de Dropea.
//
// Mientras `DROPEA_CREATE_MODE=external_app`, los pedidos los crea su app de
// Shopify. Nuestro trabajo es ENCONTRARLOS y engancharnos a ellos para poder
// seguir el envío y avisar al cliente — sin crear nada.
//
// La búsqueda va por `external_order_id`, que es donde la app oficial deja la
// referencia del pedido de Shopify. Es una comparación exacta: nunca se
// adopta un pedido "parecido".
// ============================================================

import pino from "pino";
import { logIntegrationEvent } from "../../system/repo";
import {
  getOrderById,
  markSupplierCreated,
  setOrderSupplierEvaluation,
  type OrderRow,
} from "../../db";
import { processSupplierUpdate } from "../../tracking/service";
import { findDropeaOrderByExternalId, getDropeaOrder } from "./index";
import { normalizeDropeaStatus } from "./status-map";
import { dropeaReadEnabled } from "./client";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export interface AdoptionResult {
  adopted: boolean;
  externalOrderId: string | null;
  reason: string;
}

/**
 * Busca en Dropea un pedido que corresponda al nuestro y, si existe, lo
 * adopta: guarda su id, marca la sincronización como hecha y arranca el
 * seguimiento con el estado y el tracking que ya tenga.
 *
 * Es idempotente: si ya estaba adoptado, no hace nada.
 */
export async function adoptDropeaOrder(order: OrderRow): Promise<AdoptionResult> {
  if (order.supplier_external_order_id) {
    return {
      adopted: false,
      externalOrderId: order.supplier_external_order_id,
      reason: "ya estaba enganchado a un pedido de Dropea",
    };
  }
  if (!dropeaReadEnabled()) {
    return { adopted: false, externalOrderId: null, reason: "lectura de la API deshabilitada" };
  }
  if (order.status !== "confirmed") {
    return { adopted: false, externalOrderId: null, reason: "el pedido aún no está confirmado" };
  }

  // Buscamos por NUESTRA referencia. Coincidencia exacta.
  let encontrado;
  try {
    encontrado = await findDropeaOrderByExternalId(order.shopify_order_id);
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error consultando Dropea";
    logger.warn(`[SUPPLIER] #${order.shopify_order_number} no se pudo buscar en Dropea: ${mensaje}`);
    return { adopted: false, externalOrderId: null, reason: mensaje };
  }

  if (!encontrado) {
    return {
      adopted: false,
      externalOrderId: null,
      reason: "la app oficial todavía no ha creado este pedido en Dropea",
    };
  }

  const externalId = String(encontrado.id);
  markSupplierCreated(order.id, "dropea", externalId);
  logger.info(
    `[SUPPLIER] #${order.shopify_order_number} adoptado de la app oficial de Dropea (id ${externalId})`
  );
  logIntegrationEvent("dropea", "order_adopted", "info", "pedido adoptado de la app oficial", order.shopify_order_number);

  // Arrancar el seguimiento con lo que ya sepa Dropea de este envío.
  const fresco = getOrderById(order.id) ?? order;
  const normalizado = normalizeDropeaStatus(encontrado.status, encontrado.sub_status ?? null);
  processSupplierUpdate(fresco, {
    rawStatus: encontrado.sub_status
      ? `${encontrado.status}.${encontrado.sub_status}`
      : String(encontrado.status),
    rawSubStatus: encontrado.sub_status ?? null,
    normalizedOverride: normalizado,
    trackingNumber: encontrado.tracking_number ?? null,
    trackingUrl: encontrado.tracking_url ?? null,
    carrier: encontrado.carrier ?? null,
    source: "reconciliation",
  });

  return { adopted: true, externalOrderId: externalId, reason: "adoptado de la app oficial" };
}

/**
 * Refresca un pedido ya adoptado consultando su estado actual.
 * Es la vía de reconciliación cuando se pierde un webhook.
 */
export async function reconcileDropeaOrder(order: OrderRow): Promise<boolean> {
  if (!order.supplier_external_order_id || !dropeaReadEnabled()) return false;
  try {
    const remoto = await getDropeaOrder(order.supplier_external_order_id);
    const normalizado = normalizeDropeaStatus(remoto.status, remoto.sub_status ?? null);
    const raw = remoto.sub_status ? `${remoto.status}.${remoto.sub_status}` : String(remoto.status);
    const r = processSupplierUpdate(order, {
      rawStatus: raw,
      rawSubStatus: remoto.sub_status ?? null,
      normalizedOverride: normalizado,
      trackingNumber: remoto.tracking_number ?? null,
      trackingUrl: remoto.tracking_url ?? null,
      carrier: remoto.carrier ?? null,
      source: "reconciliation",
    });
    if (r.events.length) {
      logger.info(
        `[SUPPLIER] #${order.shopify_order_number} reconciliado con Dropea: ${r.previousStatus} → ${r.newStatus}`
      );
    }
    return r.events.length > 0;
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error";
    setOrderSupplierEvaluation(order.id, order.supplier_platform, order.supplier_sync_status, mensaje);
    return false;
  }
}
