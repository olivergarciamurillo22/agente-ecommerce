// ============================================================
// Receptor genérico de webhooks de proveedor (Dropi / Dropea).
//
// La MECÁNICA está implementada y probada: verificar firma, identificar el
// pedido, normalizar el estado, detectar transiciones y avisar al cliente
// una sola vez.
//
// Lo que falta del handoff es la FORMA de la firma y del cuerpo, y por eso
// todo es configurable por entorno y FAIL-CLOSED: sin secreto configurado,
// cualquier webhook se rechaza. Nunca se procesa un mensaje sin autenticar.
// ============================================================

import crypto from "node:crypto";
import pino from "pino";
import { getOrderBySupplierExternalId, getOrderByShopifyId, type OrderRow } from "../db";
import { processSupplierUpdate } from "../tracking/service";
import type { SupplierPlatform } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export interface SupplierWebhookConfig {
  /** Secreto compartido con el proveedor. Sin él, todo se rechaza. */
  secret: string | undefined;
  /** Cabecera donde viaja la firma (configurable: cada API usa la suya). */
  signatureHeader: string;
  /** Codificación de la firma. */
  encoding: "base64" | "hex";
}

export function webhookConfig(platform: SupplierPlatform): SupplierWebhookConfig {
  const p = platform === "dropi" ? "DROPIPRO" : "DROPEA";
  const enc = (process.env[`${p}_WEBHOOK_SIGNATURE_ENCODING`] ?? "hex").toLowerCase();
  return {
    secret: process.env[`${p}_WEBHOOK_SECRET`] || process.env[`${p}_HMAC_SECRET`],
    signatureHeader: (process.env[`${p}_WEBHOOK_SIGNATURE_HEADER`] ?? "x-signature").toLowerCase(),
    encoding: enc === "base64" ? "base64" : "hex",
  };
}

/**
 * Verifica la firma HMAC-SHA256 del cuerpo crudo, en tiempo constante.
 * Acepta el prefijo "sha256=" que usan algunas APIs.
 */
export function verifySupplierSignature(
  rawBody: string,
  signature: string | null | undefined,
  config: SupplierWebhookConfig
): boolean {
  if (!config.secret || !signature) return false;
  const limpia = signature.trim().replace(/^sha256=/i, "");
  const esperada = crypto
    .createHmac("sha256", config.secret)
    .update(rawBody)
    .digest(config.encoding);
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(limpia, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Localiza el pedido al que se refiere el webhook. Se buscan varias claves
 * porque todavía no sabemos cuál manda cada proveedor; en cuanto lo sepamos,
 * esto se reduce a la suya.
 */
function findOrder(payload: Record<string, unknown>): OrderRow | null {
  const candidatosExternos = [
    payload.order_id,
    payload.id,
    payload.external_order_id,
    payload.orderId,
  ];
  for (const c of candidatosExternos) {
    if (c === undefined || c === null) continue;
    const encontrado = getOrderBySupplierExternalId(String(c));
    if (encontrado) return encontrado;
  }
  // Nuestra propia referencia (shopify_order_id), si nos la devuelven.
  const referencias = [payload.reference, payload.external_reference, payload.merchant_reference];
  for (const r of referencias) {
    if (r === undefined || r === null) continue;
    const encontrado = getOrderByShopifyId(String(r));
    if (encontrado) return encontrado;
  }
  return null;
}

/** Extrae estado y tracking del cuerpo, tolerando varios nombres de campo. */
function extractUpdate(payload: Record<string, unknown>) {
  const str = (v: unknown): string | null =>
    v === undefined || v === null || v === "" ? null : String(v);
  return {
    rawStatus: str(payload.status ?? payload.state ?? payload.estado),
    trackingNumber: str(payload.tracking_number ?? payload.trackingNumber ?? payload.guia),
    trackingUrl: str(payload.tracking_url ?? payload.trackingUrl),
    carrier: str(payload.carrier ?? payload.transportadora ?? payload.courier),
  };
}

/**
 * Procesa un webhook de proveedor. Idempotente: repetir el mismo mensaje no
 * duplica avisos (lo garantizan los sellos de notificación en la DB).
 */
export function processSupplierWebhook(
  platform: SupplierPlatform,
  rawBody: string,
  headers: Record<string, string | null>
): WebhookResult {
  const config = webhookConfig(platform);

  // FAIL-CLOSED: sin secreto configurado no se procesa nada.
  if (!config.secret) {
    logger.error(`[SUPPLIER] webhook de ${platform} rechazado: falta el secreto de firma`);
    return { status: 503, body: { ok: false, error: "webhook no configurado" } };
  }

  const firma = headers[config.signatureHeader] ?? null;
  if (!verifySupplierSignature(rawBody, firma, config)) {
    logger.warn(`[SUPPLIER] webhook de ${platform} con firma inválida — rechazado`);
    return { status: 401, body: { ok: false, error: "firma inválida" } };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { status: 200, body: { ok: false, ignored: "json inválido" } };
  }

  const order = findOrder(payload);
  if (!order) {
    // 200 para que el proveedor no reintente eternamente por un pedido nuestro
    // que no existe (p.ej. creado fuera de este sistema).
    logger.info(`[SUPPLIER] webhook de ${platform}: pedido no encontrado, ignorado`);
    return { status: 200, body: { ok: true, ignored: "pedido desconocido" } };
  }

  const update = extractUpdate(payload);
  if (!update.rawStatus && !update.trackingNumber) {
    return { status: 200, body: { ok: true, ignored: "sin estado ni tracking" } };
  }

  const resultado = processSupplierUpdate(order, update);
  logger.info(
    `[SUPPLIER] webhook ${platform} #${order.shopify_order_number}: ` +
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
