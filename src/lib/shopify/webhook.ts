// ============================================================
// Procesador del webhook orders/create de Shopify.
//
// Separado de la ruta de Next.js para poder testearlo sin levantar el server.
// Reglas de respuesta:
//  - HMAC inválido/ausente → 401 (Shopify reintentará; si es un atacante, fuera).
//  - Secret sin configurar → 500 (error nuestro de configuración).
//  - Payload procesado, ignorado o duplicado → SIEMPRE 200 en <5s, para que
//    Shopify no reintente (reintenta 8 veces en 4h ante cualquier no-2xx).
// ============================================================

import pino from "pino";
import { insertOrderIfNew } from "../db";
import {
  isCodOrder,
  normalizeOrder,
  gatewayHaystack,
  type ShopifyOrderPayload,
} from "../orders/normalize";
import { verifyShopifyHmacEitherSecret } from "./hmac";
import { logIntegrationEvent } from "../system/repo";
import { maxOrderAgeMinutes, orderTooOld } from "../safety";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Anti-ruido: el aviso de "firma con client_secret" sale una vez por arranque. */
let clientSecretMatchAnunciado = false;

export interface WebhookHeaders {
  hmac: string | null;
  topic: string | null;
  webhookId: string | null;
  shopDomain: string | null;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export function processOrdersCreateWebhook(rawBody: string, headers: WebhookHeaders): WebhookResult {
  if (!process.env.SHOPIFY_WEBHOOK_SECRET && !process.env.SHOPIFY_CLIENT_SECRET) {
    logger.error("[SHOPIFY] ni SHOPIFY_WEBHOOK_SECRET ni SHOPIFY_CLIENT_SECRET configurados — webhook rechazado");
    return { status: 500, body: { ok: false, error: "webhook secret no configurado" } };
  }

  // BUG2 (confirmado en producción el 26-08): los webhooks de esta tienda
  // los creó la app, así que Shopify los firma con SHOPIFY_CLIENT_SECRET,
  // no con SHOPIFY_WEBHOOK_SECRET (el de los webhooks creados desde el
  // admin). Se aceptan los dos.
  const verificacion = verifyShopifyHmacEitherSecret(rawBody, headers.hmac);
  if (!verificacion.valid) {
    // topic + webhookId (id de ENTREGA, no de suscripción) para poder
    // correlacionar una racha de rechazos con una entrega/suscripción
    // concreta.
    logger.warn(
      `[SHOPIFY] HMAC inválido (shop=${headers.shopDomain ?? "?"}, topic=${headers.topic ?? "?"}, webhookId=${headers.webhookId ?? "?"}, longitud_cuerpo=${rawBody.length}) — rechazado`
    );
    // Al feed: una racha de estos es un secret mal pegado o alguien probando.
    logIntegrationEvent("shopify", "webhook_bad_signature", "warning", "webhook rechazado por HMAC inválido");
    return { status: 401, body: { ok: false, error: "hmac inválido" } };
  }
  if (verificacion.matchedWith === "client_secret" && !clientSecretMatchAnunciado) {
    // Rastro de que los webhooks vienen firmados con el secreto de la app,
    // no el de la tienda — informativo, nunca cambia la decisión de aceptar.
    // UNA vez por arranque: con decenas de webhooks al día, un evento por
    // cada uno solo serviría para desplazar del feed lo que sí importa.
    clientSecretMatchAnunciado = true;
    logIntegrationEvent(
      "shopify",
      "webhook_client_secret_match",
      "info",
      "webhooks validando con SHOPIFY_CLIENT_SECRET (suscripciones creadas por la app, no desde el admin)"
    );
  }

  // Solo procesamos creación de pedidos. Si llega otro topic (webhook mal
  // configurado), lo aceptamos con 200 para no provocar reintentos.
  if (headers.topic && headers.topic !== "orders/create") {
    logger.info(`[SHOPIFY] topic ${headers.topic} ignorado`);
    return { status: 200, body: { ok: true, ignored: "topic" } };
  }

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    logger.warn("[SHOPIFY] payload no es JSON válido");
    return { status: 200, body: { ok: false, ignored: "json inválido" } };
  }

  const orderLabel = `#${payload.order_number ?? payload.name ?? payload.id ?? "?"}`;
  logger.info(`[SHOPIFY] Order ${orderLabel} received`);

  if (!payload.id) {
    return { status: 200, body: { ok: false, ignored: "sin id de pedido" } };
  }

  if (!isCodOrder(payload)) {
    // Dejamos rastro de los gateways para poder afinar COD_GATEWAY_KEYWORDS.
    logger.info(
      `[ORDER] ${orderLabel} no es COD (gateways: "${gatewayHaystack(payload).slice(0, 120)}") — ignorado`
    );
    return { status: 200, body: { ok: true, ignored: "no COD" } };
  }
  logger.info(`[ORDER] COD detected ${orderLabel}`);

  const n = normalizeOrder(payload);

  // SEGURIDAD anti-replay/backfill (T2): la antigüedad se mide SIEMPRE contra
  // ordered_at (n.orderedAt — la fecha REAL de compra en Shopify, de T1),
  // nunca contra cuándo nos enteramos nosotros del pedido. Un pedido creado
  // hace más de MAX_ORDER_AGE_MINUTES no dispara NINGUNA acción (ni WhatsApp,
  // ni reminders, ni Shopify). Se guarda como ignored_old para poder verlo.
  // Si el payload no trae created_at (n.orderedAt === null), no se puede medir
  // la antigüedad: se deja pasar (igual que antes de T2) en vez de bloquear
  // por una ausencia que no es indicio de nada.
  let tooOld = false;
  if (n.orderedAt !== null) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (orderTooOld(n.orderedAt, nowSec)) {
      tooOld = true;
      const ageMin = (nowSec - n.orderedAt) / 60;
      logger.warn(
        `[SAFETY] Order ${orderLabel} ignored_old_order (creado hace ${Math.round(ageMin)} min > ${maxOrderAgeMinutes()})`
      );
    }
  }

  const keepRaw = process.env.STORE_RAW_PAYLOAD !== "0";
  const { created, order } = insertOrderIfNew({
    shopify_order_id: n.shopifyOrderId,
    shopify_order_number: n.orderNumber,
    customer_name: n.customerName,
    phone: n.phone,
    email: n.email,
    product_summary: n.productSummary,
    total_price: n.totalPrice,
    currency: n.currency,
    address_line1: n.addressLine1,
    address_line2: n.addressLine2,
    city: n.city,
    province: n.province,
    postal_code: n.postalCode,
    country: n.country,
    // Antiguo → ignored_old (jamás se actúa). Sin teléfono → ERROR visible.
    status: tooOld ? "ignored_old" : n.phone ? "pending_send" : "error",
    customer_note: n.customerNote,
    last_error: tooOld
      ? "ignored_old_order: llegó con más antigüedad que MAX_ORDER_AGE_MINUTES"
      : n.phone
        ? null
        : "El pedido no trae teléfono — imposible enviar WhatsApp",
    raw_payload: keepRaw ? rawBody.slice(0, 200_000) : null,
    ordered_at: n.orderedAt,
  });

  if (!created) {
    logger.info(`[ORDER] ${orderLabel} duplicado (webhook reintentado) — ignorado`);
    return { status: 200, body: { ok: true, duplicate: true, orderId: order.id } };
  }

  if (tooOld) {
    logger.info(`[ORDER] ${orderLabel} guardado → ignored_old (sin acciones)`);
  } else if (!n.phone) {
    logger.warn(`[ORDER] ${orderLabel} sin teléfono → estado error`);
  } else {
    logger.info(`[ORDER] ${orderLabel} guardado → pending_send (tel ***${n.phone.slice(-4)})`);
  }

  return { status: 200, body: { ok: true, orderId: order.id, status: order.status } };
}
