// ============================================================
// Receptor de los webhooks de Shopify que NO crean pedido: orders/cancelled,
// orders/fulfilled y orders/updated. Los tres comparten forma (HMAC, dedupe,
// localizar el pedido), así que van por un único procesador que despacha por
// `X-Shopify-Topic` — igual que hace el receptor de Dropea con sus topics.
//
// Decisión de negocio (23-08-2026, confirmada con Óliver): "fulfilled" NO
// es "entregado". En Shopify solo significa que el pedido se marcó como
// despachado; la entrega real (o el rehúse) del COD solo la sabe el
// proveedor/transportista. Por eso:
//
//   orders/cancelled → closure_status = 'cancelled', source 'shopify'
//   orders/fulfilled → closure_status = 'in_progress', source 'shopify'
//   orders/updated   → NUNCA toca el eje de cierre. Solo trazabilidad
//                       (integration_event) + el espejo de E4 (abajo).
//
// ESPEJO DE `orders/updated` — LISTA ACORDADA (E4, 24-08-2026, con Óliver).
// Hasta E4 este topic no escribía NADA en `orders`, a propósito: es el
// webhook más ruidoso de Shopify y un espejo "de lo que parezca" corrompe
// datos. La lista acordada tiene UN solo campo:
//
//   supplier_external_order_id  ←  tag `dropea_id:NNNNNNN`
//
// y con estas condiciones, que lo hacen inofensivo frente al ruido:
//   - solo escribe si el campo está VACÍO (latch de un solo sentido: el
//     UPDATE lleva `WHERE supplier_external_order_id IS NULL`);
//   - por eso NO necesita la protección de orden cronológico: da igual en
//     qué orden lleguen los `orders/updated`, el primero que traiga el tag
//     gana y los demás no pueden cambiarlo;
//   - nada más de `orders/updated` se refleja. Ampliar esta lista es otra
//     decisión, no un efecto colateral de un refactor.
//
// `delivered`/`refused` quedan reservados para Dropea o marcado manual.
// canTransitionClosure() ya impide que un webhook de Shopify pise un
// terminal puesto por el proveedor (ver src/lib/db.ts).
//
// Reglas duras:
//  - HMAC obligatorio (X-Shopify-Hmac-Sha256), tiempo constante. Sin
//    secreto configurado → 500 (error nuestro); HMAC inválido → 401.
//  - Idempotencia por X-Shopify-Webhook-Id, NO por contenido del payload:
//    Shopify reintenta, y orders/updated dispara varias veces por el mismo
//    cambio. Reutiliza `supplier_webhook_events` (tabla ya genérica por
//    `platform`, no exclusiva de proveedores de fulfillment).
//  - Los webhooks NO llegan en orden cronológico. Antes de escribir un
//    cierre se compara la fecha del propio evento (cancelled_at/updated_at
//    del payload) con el `closure_at` ya guardado: un evento más antiguo que
//    lo que ya hay se descarta, aunque la transición en sí sería válida.
// ============================================================

import pino from "pino";
import {
  claimWebhookEvent,
  getOrderByShopifyId,
  setOrderClosure,
  type ClosureStatus,
} from "../db";
import { verifyShopifyHmac } from "./hmac";
import { logIntegrationEvent } from "../system/repo";
import { linkDropeaFromShopifyTags } from "../orders/supplier-tags";
import type { ShopifyOrderPayload } from "../orders/normalize";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export type OrdersEventTopic = "orders/cancelled" | "orders/fulfilled" | "orders/updated";

const HANDLED_TOPICS: OrdersEventTopic[] = ["orders/cancelled", "orders/fulfilled", "orders/updated"];

function isHandledTopic(topic: string | null): topic is OrdersEventTopic {
  return HANDLED_TOPICS.includes(topic as OrdersEventTopic);
}

/** A qué closure_status traduce cada topic. orders/updated no tiene entrada: no escribe el eje. */
const TOPIC_TO_CLOSURE: Partial<Record<OrdersEventTopic, ClosureStatus>> = {
  "orders/cancelled": "cancelled",
  "orders/fulfilled": "in_progress",
};

export interface OrdersEventWebhookHeaders {
  hmac: string | null;
  topic: string | null;
  webhookId: string | null;
  shopDomain: string | null;
}

export interface OrdersEventWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** Fecha del propio evento, en epoch segundos. `null` si no se puede determinar. */
function eventTimestamp(topic: OrdersEventTopic, payload: ShopifyOrderPayload): number | null {
  const raw =
    topic === "orders/cancelled"
      ? (payload.cancelled_at ?? payload.updated_at)
      : payload.updated_at;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function processOrdersEventWebhook(
  rawBody: string,
  headers: OrdersEventWebhookHeaders
): OrdersEventWebhookResult {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("[SHOPIFY] SHOPIFY_WEBHOOK_SECRET no configurado — webhook rechazado");
    return { status: 500, body: { ok: false, error: "webhook secret no configurado" } };
  }

  if (!verifyShopifyHmac(rawBody, headers.hmac, secret)) {
    logger.warn(`[SHOPIFY] HMAC inválido (shop=${headers.shopDomain ?? "?"}, topic=${headers.topic ?? "?"}) — rechazado`);
    logIntegrationEvent("shopify", "webhook_bad_signature", "warning", "webhook rechazado por HMAC inválido");
    return { status: 401, body: { ok: false, error: "hmac inválido" } };
  }

  const topic = headers.topic;
  if (!isHandledTopic(topic)) {
    // Webhook mal configurado (topic que no esperábamos en esta ruta): 200
    // para no provocar reintentos, sin ningún efecto.
    logger.info(`[SHOPIFY] topic ${topic ?? "(vacío)"} no manejado en orders-events — ignorado`);
    return { status: 200, body: { ok: true, ignored: "topic" } };
  }

  // Idempotencia por el ID de la ENTREGA del webhook, no por el payload:
  // Shopify reintenta la misma entrega, y orders/updated dispara varias veces
  // por el mismo cambio con ligeras variaciones de payload. Sin webhook_id no
  // podemos deduplicar (no debería pasar con Shopify real); se procesa igual
  // en vez de fallar cerrado por un header ausente, pero queda registrado.
  if (headers.webhookId) {
    const nuevo = claimWebhookEvent(headers.webhookId, "shopify", topic, null);
    if (!nuevo) {
      logger.info(`[SHOPIFY] ${topic} webhook_id repetido — ignorado`);
      return { status: 200, body: { ok: true, duplicate: true } };
    }
  } else {
    logger.warn(`[SHOPIFY] ${topic} sin X-Shopify-Webhook-Id: se procesa sin dedupe`);
  }

  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    logger.warn(`[SHOPIFY] ${topic}: payload no es JSON válido`);
    return { status: 200, body: { ok: false, ignored: "json inválido" } };
  }

  if (!payload.id) {
    return { status: 200, body: { ok: false, ignored: "sin id de pedido" } };
  }

  const order = getOrderByShopifyId(String(payload.id));
  if (!order) {
    logger.info(`[SHOPIFY] ${topic} pedido ${payload.id}: no es nuestro — ignorado`);
    return { status: 200, body: { ok: true, ignored: "pedido desconocido" } };
  }

  if (topic === "orders/updated") {
    // Cero efectos en el eje de cierre — eso no cambia con E4. El ÚNICO
    // campo del espejo acordado es supplier_external_order_id, y solo
    // cuando el pedido trae el tag `dropea_id:` y aún no estaba enlazado
    // (ver la lista acordada en la cabecera de este fichero).
    const enlace = linkDropeaFromShopifyTags(order, payload, "webhook orders/updated");
    logIntegrationEvent(
      "shopify",
      "order_updated_received",
      "info",
      enlace.linked
        ? `orders/updated recibido: sin tocar el eje de cierre; enlazado a Dropea ${enlace.dropeaId} por tag (E4)`
        : "orders/updated recibido: sin escritura en el eje de cierre ni en el espejo",
      order.shopify_order_number
    );
    return {
      status: 200,
      body: {
        ok: true,
        order: order.shopify_order_number,
        noted: true,
        dropea_linked: enlace.linked,
        dropea_id: enlace.dropeaId,
      },
    };
  }

  const closureStatus = TOPIC_TO_CLOSURE[topic]!;
  const eventAt = eventTimestamp(topic, payload);
  const effectiveAt = eventAt ?? Math.floor(Date.now() / 1000);

  // Protección contra llegada fuera de orden: si ya hay un cierre con fecha
  // igual o más reciente que este evento, este evento es más viejo que lo
  // que ya sabemos — se descarta, aunque la transición en sí sería válida.
  if (order.closure_at !== null && effectiveAt <= order.closure_at) {
    logger.info(
      `[SHOPIFY] ${topic} #${order.shopify_order_number}: evento (${effectiveAt}) no es más reciente que el cierre guardado (${order.closure_at}) — descartado por orden`
    );
    return { status: 200, body: { ok: true, order: order.shopify_order_number, ignored: "stale_event" } };
  }

  const aplicado = setOrderClosure(order.id, closureStatus, "shopify", effectiveAt);
  if (!aplicado) {
    logger.info(
      `[SHOPIFY] ${topic} #${order.shopify_order_number}: cierre "${closureStatus}" no aplicado (ya está en un cierre terminal distinto)`
    );
  } else {
    logger.info(`[SHOPIFY] ${topic} #${order.shopify_order_number}: closure_status → ${closureStatus}`);
  }

  return {
    status: 200,
    body: { ok: true, order: order.shopify_order_number, closure_status: closureStatus, applied: aplicado },
  };
}
