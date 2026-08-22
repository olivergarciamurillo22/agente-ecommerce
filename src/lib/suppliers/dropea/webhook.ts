// ============================================================
// Receptor de webhooks de Dropea — según su contrato oficial.
//
//   Cabecera : X-Dropea-Signature: sha256=<base64 de HMAC-SHA256(raw_body, signing_secret)>
//   Topic    : X-Dropea-Topic  (order.created, order.status.changed, …)
//   Evento   : X-Dropea-Event-Id (UUID por entrega)
//
// La firma se verifica SIEMPRE antes de mirar el contenido, en tiempo
// constante y sobre los bytes crudos del cuerpo, como exige el contrato.
//
// Hay que responder 2xx en menos de 5 segundos: por eso todo el trabajo es
// síncrono contra SQLite y los WhatsApps salen por el outbox (no se espera
// a que se envíen).
// ============================================================

import crypto from "node:crypto";
import pino from "pino";
import {
  claimWebhookEvent,
  getOrderByShopifyId,
  getOrderBySupplierExternalId,
  getOrderByTrackingNumber,
  setOrderSupplierPlatformAndExternalId,
  setOrderSupplierReview,
  type OrderRow,
} from "../../db";
import { processSupplierUpdate } from "../../tracking/service";
import { normalizeDropeaStatus } from "./status-map";
import { isDropeaTopic, type DropeaOrder, type DropeaWebhookEnvelope } from "./types";

import { logIntegrationEvent } from "../../system/repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Cabeceras que define el contrato (en minúsculas, como llegan). */
export const DROPEA_SIGNATURE_HEADER = "x-dropea-signature";
export const DROPEA_TOPIC_HEADER = "x-dropea-topic";
export const DROPEA_EVENT_ID_HEADER = "x-dropea-event-id";

export function dropeaWebhookSecret(): string | undefined {
  // El contrato lo llama `signing_secret`; se muestra al crear la API Key.
  return process.env.DROPEA_WEBHOOK_SECRET || undefined;
}

/**
 * Verifica `sha256=<base64 de HMAC-SHA256(raw_body, signing_secret)>`.
 * Comparación en tiempo constante sobre el cuerpo crudo.
 */
export function verifyDropeaSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined
): boolean {
  if (!secret || !signature) return false;
  const recibida = signature.trim();
  // El contrato fija el prefijo "sha256="; se exige para no aceptar formatos
  // que no sean el suyo.
  if (!recibida.toLowerCase().startsWith("sha256=")) return false;
  const valor = recibida.slice("sha256=".length);

  const esperada = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(valor, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface DropeaWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Localiza nuestro pedido a partir del recurso del evento.
 *
 * En los eventos `order.*` el `resource_id` ES el id del pedido. En los
 * `issue.*` el recurso es una incidencia, cuyo pedido va en `order_id`
 * (y que además trae `tracking_number`, útil como última vía).
 */
function findOrder(
  resourceId: number,
  resource: Record<string, unknown>,
  esIncidencia: boolean
): OrderRow | null {
  // 1. Id del pedido en Dropea: el propio resource_id, o `order_id` si es
  //    una incidencia.
  const idPedido = esIncidencia ? resource.order_id : resourceId;
  if (typeof idPedido === "number" || typeof idPedido === "string") {
    const porExterno = getOrderBySupplierExternalId(String(idPedido));
    if (porExterno) return porExterno;
  }

  // 2. Por nuestra referencia, que Dropea devuelve en cada lectura de pedido.
  const externo = resource.external_order_id;
  if (typeof externo === "string" && externo.trim()) {
    const porReferencia = getOrderByShopifyId(externo.replace(/^#/, "").trim());
    if (porReferencia) return porReferencia;
  }

  // 3. Última vía, solo para incidencias: por número de seguimiento.
  if (esIncidencia && typeof resource.tracking_number === "string" && resource.tracking_number.trim()) {
    const porTracking = getOrderByTrackingNumber(resource.tracking_number.trim());
    if (porTracking) return porTracking;
  }
  return null;
}

/** Aplica un evento de pedido (order.*) al motor de tracking. */
function aplicarEventoPedido(
  order: OrderRow,
  resource: Record<string, unknown>,
  resourceId: number
): DropeaWebhookResult {
  const pedido = resource as unknown as DropeaOrder;

  // Adoptar el id de Dropea si aún no lo teníamos (nos protege de duplicar).
  if (!order.supplier_external_order_id) {
    setOrderSupplierPlatformAndExternalId(order.id, "dropea", String(resourceId));
  }

  const normalizado = normalizeDropeaStatus(pedido.status, pedido.sub_status ?? null);
  const raw = pedido.sub_status ? `${pedido.status}.${pedido.sub_status}` : String(pedido.status);

  if (normalizado === "unknown") {
    logger.warn(
      `[SUPPLIER] Dropea: par de estados no reconocido "${raw}" en el pedido ${resourceId}`
    );
  }

  const resultado = processSupplierUpdate(order, {
    rawStatus: raw,
    normalizedOverride: normalizado,
    trackingNumber: pedido.tracking_number ?? null,
    trackingUrl: pedido.tracking_url ?? null,
    carrier: pedido.carrier ?? null,
  });

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

/** Aplica un evento de incidencia (issue.*): nunca escribe al cliente. */
function aplicarEventoIncidencia(
  order: OrderRow,
  topic: string,
  resource: Record<string, unknown>
): DropeaWebhookResult {
  const estado = typeof resource.status === "string" ? resource.status : "";
  const activa = resource.is_active === true;

  if (topic === "issue.resolved" || estado === "RESOLVED") {
    logger.info(`[SUPPLIER] #${order.shopify_order_number} incidencia de Dropea resuelta`);
    return { status: 200, body: { ok: true, order: order.shopify_order_number, issue: "resuelta" } };
  }

  // El contrato dice: hace falta actuar solo si status=PENDING && is_active.
  const requiereAccion = estado === "PENDING" && activa;
  setOrderSupplierReview(
    order.id,
    `incidencia en Dropea (${estado || topic})${requiereAccion ? " — requiere acción" : ""}`
  );
  logger.info(
    `[SUPPLIER] #${order.shopify_order_number} incidencia de Dropea: ${estado || topic}` +
      (requiereAccion ? " (requiere acción)" : "")
  );
  return {
    status: 200,
    body: { ok: true, order: order.shopify_order_number, issue: estado || topic, requiereAccion },
  };
}

/**
 * Procesa un webhook de Dropea. Idempotente: repetir la misma entrega no
 * duplica avisos (lo garantizan los sellos del motor de tracking).
 */
export function processDropeaWebhook(
  rawBody: string,
  headers: Record<string, string | null>
): DropeaWebhookResult {
  const secret = dropeaWebhookSecret();

  // 1. FAIL-CLOSED: sin secreto configurado no se procesa nada.
  if (!secret) {
    logger.error("[SUPPLIER] webhook de Dropea rechazado: falta DROPEA_WEBHOOK_SECRET");
    return { status: 503, body: { ok: false, error: "webhook no configurado" } };
  }

  // 2. Firma ANTES de mirar el contenido.
  if (!verifyDropeaSignature(rawBody, headers[DROPEA_SIGNATURE_HEADER], secret)) {
    logger.warn("[SUPPLIER] webhook de Dropea con firma inválida — rechazado");
    // Queda en el feed: una racha de estas casi siempre es el secret mal
    // pegado (API key en vez del signing secret) o alguien probando la URL.
    logIntegrationEvent("dropea", "webhook_bad_signature", "warning", "webhook rechazado por firma inválida");
    return { status: 401, body: { ok: false, error: "firma inválida" } };
  }

  // 3. Parseo del envoltorio v2.
  let envelope: DropeaWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as DropeaWebhookEnvelope;
  } catch {
    return { status: 400, body: { ok: false, error: "json inválido" } };
  }
  if (!envelope || typeof envelope.topic !== "string" || typeof envelope.resource_id !== "number") {
    return { status: 400, body: { ok: false, error: "envoltorio inválido" } };
  }

  const topic = envelope.topic;

  // 3.5. DEDUPLICACIÓN por event_id, como pide su contrato ("store it for
  //      idempotent processing"). Un reintento de Dropea no vuelve a
  //      producir efectos, ni siquiera parciales.
  if (typeof envelope.event_id === "string" && envelope.event_id.trim()) {
    const nuevo = claimWebhookEvent(
      envelope.event_id.trim(),
      "dropea",
      topic,
      String(envelope.resource_id)
    );
    if (!nuevo) {
      logger.info(`[SUPPLIER] webhook Dropea ${topic} event_id repetido — ignorado`);
      logIntegrationEvent("dropea", "webhook_duplicate", "info", `reintento de ${topic} ignorado (dedup por event_id)`);
      return { status: 200, body: { ok: true, duplicate: true } };
    }
  }

  // 4. Dispatcher explícito por topic (unión discriminada, sin heurísticas).
  if (!isDropeaTopic(topic)) {
    // Evento desconocido: 200 para que no reintenten, y ningún efecto.
    logger.info(`[SUPPLIER] topic de Dropea desconocido "${topic}" — ignorado sin efectos`);
    return { status: 200, body: { ok: true, ignored: "topic desconocido" } };
  }

  const resource = (envelope.resource ?? {}) as Record<string, unknown>;
  const esIncidencia = topic.startsWith("issue.");
  const order = findOrder(envelope.resource_id, resource, esIncidencia);
  if (!order) {
    logger.info(
      `[SUPPLIER] webhook Dropea ${topic} recurso ${envelope.resource_id}: pedido no encontrado`
    );
    return { status: 200, body: { ok: true, ignored: "pedido desconocido" } };
  }

  switch (topic) {
    case "order.created":
    case "order.status.changed":
    case "order.cancelled":
      return aplicarEventoPedido(order, resource, envelope.resource_id);
    case "issue.created":
    case "issue.status.changed":
    case "issue.resolved":
      return aplicarEventoIncidencia(order, topic, resource);
  }
}
