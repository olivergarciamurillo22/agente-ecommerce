// ============================================================
// Receptor del webhook de actualizaciones de Dropi PRO.
//
// ⚠️ DESHABILITADO POR DEFECTO (503). No sabemos si Dropi firma estos POSTs,
// y aceptar notificaciones sin autenticar dejaría que cualquiera en internet
// inventara estados de envío y disparara WhatsApps a clientes reales.
//
// Se activa con DROPIPRO_WEBHOOK_ENABLED=1, y solo debería hacerse cuando
// exista un mecanismo de autenticación confirmado (firma, token o filtro por
// IP en el proxy). Ver docs/DROPI-API-CONTRACT.md.
// ============================================================

import pino from "pino";
import {
  getOrderByShopifyId,
  getOrderBySupplierExternalId,
  setOrderSupplierPlatformAndExternalId,
  type OrderRow,
} from "../../db";
import { processSupplierUpdate } from "../../tracking/service";
import { logIntegrationEvent } from "../../system/repo";
import { normalizeDropiStatus } from "./status-map";
import { validateDropiPayload, type DropiOrderUpdatePayload } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export interface DropiWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** ¿Está habilitado el receptor? Por defecto NO (fail-closed). */
export function dropiWebhookEnabled(): boolean {
  return process.env.DROPIPRO_WEBHOOK_ENABLED === "1";
}

/**
 * Localiza nuestro pedido. Orden de preferencia:
 *   1. `shopify_order_id` → nuestro pedido de Shopify (vía más fiable).
 *   2. `order_id` → un pedido que ya tenga ese id externo de Dropi.
 * Nunca por nombre, teléfono ni dirección.
 */
function findOrder(payload: DropiOrderUpdatePayload): { order: OrderRow; via: string } | null {
  if (payload.shopify_order_id !== null) {
    const porShopify = getOrderByShopifyId(String(payload.shopify_order_id));
    if (porShopify) return { order: porShopify, via: "shopify_order_id" };
  }
  const porExterno = getOrderBySupplierExternalId(String(payload.order_id));
  if (porExterno) return { order: porExterno, via: "order_id" };
  return null;
}

/**
 * Procesa una notificación de Dropi. Idempotente: repetir el mismo POST no
 * duplica avisos (lo garantizan los sellos atómicos del motor de tracking).
 */
export function processDropiWebhook(rawBody: string): DropiWebhookResult {
  // 1. FAIL-CLOSED: sin mecanismo de autenticación confirmado, no se procesa.
  if (!dropiWebhookEnabled()) {
    logger.warn(
      "[SUPPLIER] webhook de Dropi recibido pero el receptor está deshabilitado " +
        "(DROPIPRO_WEBHOOK_ENABLED=0): falta confirmar cómo autentica Dropi sus notificaciones"
    );
    return { status: 503, body: { ok: false, error: "receptor deshabilitado" } };
  }

  // 2. Parseo y validación estricta.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: "json inválido" } };
  }

  const validation = validateDropiPayload(parsed);
  if (!validation.ok || !validation.payload) {
    logger.warn(`[SUPPLIER] webhook de Dropi con payload inválido: ${validation.issues.join(", ")}`);
    return { status: 400, body: { ok: false, error: "payload inválido", issues: validation.issues } };
  }
  const payload = validation.payload;

  // 3. Emparejar con nuestro pedido.
  const encontrado = findOrder(payload);
  if (!encontrado) {
    // 200 para que Dropi no reintente eternamente por un pedido que no es
    // nuestro (puede haberse creado fuera de este sistema).
    logger.info(`[SUPPLIER] webhook Dropi order_id=${payload.order_id}: pedido no encontrado`);
    return { status: 200, body: { ok: true, ignored: "pedido desconocido" } };
  }
  const { order, via } = encontrado;

  // 4. Si lo localizamos por Shopify y aún no teníamos su id de Dropi, lo
  //    adoptamos: a partir de ahora ese pedido queda ligado a Dropi. Esto
  //    además nos protege de crearlo por duplicado más adelante.
  if (!order.supplier_external_order_id) {
    setOrderSupplierPlatformAndExternalId(order.id, "dropi", String(payload.order_id));
    logger.info(
      `[SUPPLIER] #${order.shopify_order_number} adoptado id externo de Dropi ${payload.order_id} (vía ${via})`
    );
  }

  // 5. Normalizar el estado. Sin catálogo confirmado → "unknown": se guarda
  //    el texto original pero NO se avisa al cliente de nada.
  const normalizado = normalizeDropiStatus(payload.status_id, payload.status_name);
  if (normalizado === "unknown") {
    logIntegrationEvent(
      "dropi",
      "unknown_status",
      "info",
      `estado sin mapear: id=${payload.status_id} "${payload.status_name}"`
    );
    logger.warn(
      `[SUPPLIER] estado de Dropi sin confirmar: id=${payload.status_id} "${payload.status_name}". ` +
        `Añádelo a DROPI_STATUS_MAP cuando se confirme su significado.`
    );
  }

  // 6. Pasar por el motor de tracking (que ya garantiza idempotencia y
  //    dispara los avisos por outbox, nunca por Baileys directo).
  const resultado = processSupplierUpdate(order, {
    // Se manda el nombre original: el motor lo guarda como raw. La
    // normalización de Dropi la hemos hecho aquí, así que se pasa ya resuelta.
    rawStatus: payload.status_name,
    normalizedOverride: normalizado,
    trackingNumber: payload.tracking_code || null,
    trackingUrl: payload.tracking_url,
    carrier: payload.shipping_company || null,
  });

  logger.info(
    `[SUPPLIER] webhook dropi #${order.shopify_order_number} (vía ${via}): ` +
      `${resultado.previousStatus} → ${resultado.newStatus}` +
      (resultado.notified.length ? ` | avisos: ${resultado.notified.join(", ")}` : "")
  );

  return {
    status: 200,
    body: {
      ok: true,
      order: order.shopify_order_number,
      status: resultado.newStatus,
      events: resultado.events,
      notified: resultado.notified,
    },
  };
}
