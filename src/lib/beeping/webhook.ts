// ============================================================
// Receptor de webhooks de Beeping.
//
// ESTADO DEL CONTRATO (06-09-2026). El panel de Beeping permite dar de alta
// un endpoint y suscribir CUATRO eventos —order.created, order.status_changed,
// order.logistics_status_changed y order.updated—, pero su documentación
// pública NO describe webhooks: el índice de apidocs.gobeeping.com lista 46
// endpoints REST y ninguno es de webhooks, eventos, notificaciones ni
// callbacks. Por tanto NO conocemos, y no se inventan:
//   · cómo autentica o firma sus entregas (cabecera, algoritmo, codificación)
//   · la forma del envoltorio ni el nombre del identificador de entrega
//   · si reintenta, con qué política, ni si garantiza el orden de llegada
//
// De ahí las dos decisiones de diseño de este archivo:
//
//  1. AUTENTICACIÓN FAIL-CLOSED Y DECLARADA A MANO. Mientras no esté puesto
//     el modo real (BEEPING_WEBHOOK_AUTH_MODE) el endpoint responde 503 y no
//     produce NINGÚN efecto. No existe camino que procese sin verificar, ni
//     un "modo abierto para probar": este endpoint es público y aceptar un
//     POST sin verificar dejaría que cualquiera inventara estados de envío,
//     cerrara pedidos como entregados y disparara WhatsApps de postventa.
//
//  2. PARSEO DEFENSIVO, NUNCA ADIVINADO. El evento, el identificador de
//     entrega y el pedido se buscan entre varias claves plausibles; si no
//     aparecen, la entrega se registra y se DESCARTA sin efectos en vez de
//     interpretarla a medias. Cada recepción deja en el feed la FORMA del
//     envoltorio (NOMBRES de claves, jamás su contenido) que es justo lo que
//     hace falta para fijar el contrato real con entregas de verdad.
//
// El negocio NO se reimplementa aquí: los cuatro eventos convergen en
// applyBeepingOrderLocally(), exactamente la misma función que aplica el
// polling. Por eso webhook y reconciliación no pueden divergir ni duplicar
// efectos, y por eso el polling sigue vivo como red de seguridad.
// ============================================================

import crypto from "node:crypto";
import pino from "pino";
import { claimWebhookEvent } from "../db";
import { logIntegrationEvent } from "../system/repo";
import { parseBeepingOrder } from "./client";
import { beepingEnabled, beepingWebhookAuth, type BeepingWebhookAuthConfig } from "./config";
import { parseBeepingDate } from "./mapper";
import { applyBeepingOrderLocally } from "./sync";
import type { BeepingOrder } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Los CUATRO eventos que ofrece el panel de Beeping. No hay más. */
export const BEEPING_WEBHOOK_EVENTS = [
  "order.created",
  "order.status_changed",
  "order.logistics_status_changed",
  "order.updated",
] as const;

export type BeepingWebhookEvent = (typeof BEEPING_WEBHOOK_EVENTS)[number];

export function isBeepingWebhookEvent(value: string): value is BeepingWebhookEvent {
  return (BEEPING_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export interface BeepingWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

// --- Autenticación ---

/** Comparación en tiempo constante (la diferencia de longitud sí es visible). */
function equalsConstantTime(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifica la entrega según el modo DECLARADO en el entorno. Nunca deduce el
 * modo del contenido: si la cabecera esperada no está, la entrega se rechaza.
 */
export function verifyBeepingWebhookAuth(
  rawBody: string,
  headers: Record<string, string | null>,
  auth: BeepingWebhookAuthConfig
): boolean {
  const presentado = (headers[auth.header] ?? "").trim();
  if (!presentado) return false;

  if (auth.mode === "token") {
    // Se acepta el token pelado o con el prefijo "Bearer", que es como lo
    // manda casi cualquier panel. Nada más: ni query string, ni body.
    const limpio = presentado.replace(/^bearer\s+/i, "").trim();
    return equalsConstantTime(limpio, auth.secret);
  }

  // hmac_sha256 sobre los BYTES CRUDOS del cuerpo. Se tolera el prefijo
  // "sha256=" y las dos codificaciones estándar (hex y base64) porque el
  // panel no documenta cuál emite; ambas se comparan en tiempo constante.
  const valor = presentado.replace(/^sha256=/i, "").trim();
  const mac = crypto.createHmac("sha256", auth.secret).update(rawBody, "utf8").digest();
  return equalsConstantTime(valor, mac.toString("hex")) || equalsConstantTime(valor, mac.toString("base64"));
}

// --- Envoltorio: dónde puede venir cada cosa ---

const EVENT_HEADERS = ["x-beeping-event", "x-beeping-topic", "x-beeping-event-type", "x-webhook-event", "x-event-name"];
const EVENT_BODY_KEYS = ["event", "event_type", "type", "topic", "action"];

/**
 * OJO con lo que NO está en esta lista: un `id` pelado. Si el envoltorio ES
 * el pedido, `id` sería el id del PEDIDO, y usarlo como identificador de
 * entrega haría que el primer evento de un pedido deduplicara a todos los
 * demás — el pedido se quedaría congelado en su primer estado para siempre.
 */
const DELIVERY_HEADERS = ["x-beeping-delivery", "x-beeping-delivery-id", "x-beeping-event-id", "x-webhook-id", "x-request-id"];
const DELIVERY_BODY_KEYS = ["event_id", "delivery_id", "webhook_id", "notification_id", "uuid"];

const ORDER_CONTAINER_KEYS = ["data", "order", "resource", "payload", "object", "record"];
const OCCURRED_AT_KEYS = ["occurred_at", "event_at", "timestamp", "sent_at", "created_at"];

export interface BeepingWebhookEnvelope {
  event: string | null;
  deliveryId: string | null;
  order: BeepingOrder | null;
  occurredAt: number | null;
  /** NOMBRES de las claves de primer nivel. Para fijar el contrato real. */
  shape: string[];
}

function textoDe(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}

/** Epoch (s o ms), ISO o dd-mm-yyyy. Si no se entiende: null, jamás now(). */
function parseEventTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? (n > 1e11 ? Math.floor(n / 1000) : Math.floor(n)) : null;
  }
  return parseBeepingDate(s);
}

/** Busca el objeto de pedido: el propio cuerpo, o uno de los contenedores. */
function localizarPedido(body: Record<string, unknown>): BeepingOrder | null {
  const directo = parseBeepingOrder(body);
  if (directo) return directo;
  for (const clave of ORDER_CONTAINER_KEYS) {
    const dentro = body[clave];
    if (typeof dentro === "object" && dentro !== null && !Array.isArray(dentro)) {
      const anidado = parseBeepingOrder(dentro as Record<string, unknown>);
      if (anidado) return anidado;
    }
  }
  return null;
}

export function parseBeepingWebhookEnvelope(
  body: Record<string, unknown>,
  headers: Record<string, string | null>
): BeepingWebhookEnvelope {
  let event: string | null = null;
  for (const h of EVENT_HEADERS) {
    const v = (headers[h] ?? "").trim();
    if (v) {
      event = v;
      break;
    }
  }
  if (!event) {
    for (const k of EVENT_BODY_KEYS) {
      const v = textoDe(body[k]);
      if (v) {
        event = v;
        break;
      }
    }
  }

  let deliveryId: string | null = null;
  for (const h of DELIVERY_HEADERS) {
    const v = (headers[h] ?? "").trim();
    if (v) {
      deliveryId = v;
      break;
    }
  }
  if (!deliveryId) {
    for (const k of DELIVERY_BODY_KEYS) {
      const v = textoDe(body[k]);
      if (v) {
        deliveryId = v;
        break;
      }
    }
  }

  let occurredAt: number | null = null;
  for (const k of OCCURRED_AT_KEYS) {
    const t = parseEventTimestamp(body[k]);
    if (t !== null) {
      occurredAt = t;
      break;
    }
  }

  return {
    event: event ? event.trim().toLowerCase() : null,
    deliveryId,
    order: localizarPedido(body),
    occurredAt,
    shape: Object.keys(body).slice(0, 20),
  };
}

/**
 * Clave de idempotencia. Con identificador de entrega, es él (namespaced:
 * supplier_webhook_events.event_id es PRIMARY KEY GLOBAL y un id numérico de
 * Beeping podría chocar con uno de Dropea). Sin él, huella determinista del
 * ESTADO que trae el evento: repetir la misma entrega diez veces produce la
 * misma huella y un solo efecto, mientras que un cambio real produce otra.
 */
export function beepingWebhookIdempotencyKey(env: BeepingWebhookEnvelope, event: string): string {
  if (env.deliveryId) return `beeping:evt:${env.deliveryId}`;
  const o = env.order;
  const material = [
    event,
    o?.external_id ?? "",
    o?.status ?? "",
    o?.tracking_stage ?? "",
    o?.tracking_number ?? "",
    o?.date_tracking_update ?? "",
  ].join("|");
  return `beeping:fp:${crypto.createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

// --- El procesador ---

export function processBeepingWebhook(
  rawBody: string,
  headers: Record<string, string | null>
): BeepingWebhookResult {
  // 1. FAIL-CLOSED: sin modo de autenticación declarado no se procesa NADA.
  //    Este es el estado de hoy y lo seguirá siendo hasta que sepamos cómo
  //    autentica Beeping de verdad.
  const auth = beepingWebhookAuth();
  if (!auth) {
    logger.warn("[BEEPING] webhook recibido pero el endpoint no está configurado — descartado sin efectos");
    logIntegrationEvent(
      "beeping",
      "beeping_webhook_not_configured",
      "warning",
      "llegó un webhook de Beeping pero falta BEEPING_WEBHOOK_AUTH_MODE/SECRET: descartado sin efectos"
    );
    return { status: 503, body: { ok: false, error: "WEBHOOK_AUTH_NOT_CONFIGURED" } };
  }

  // 2. Autenticación ANTES de mirar el contenido, sobre los bytes crudos.
  if (!verifyBeepingWebhookAuth(rawBody, headers, auth)) {
    logger.warn("[BEEPING] webhook con autenticación inválida — rechazado");
    logIntegrationEvent(
      "beeping",
      "beeping_webhook_bad_auth",
      "warning",
      `webhook rechazado por autenticación inválida (modo ${auth.mode}, cabecera ${auth.header})`
    );
    return { status: 401, body: { ok: false, error: "WEBHOOK_AUTH_INVALID" } };
  }

  // 3. Mismo interruptor maestro que el polling: si la integración está
  //    apagada, un webhook no puede encenderla por sorpresa.
  if (!beepingEnabled()) {
    return { status: 503, body: { ok: false, error: "BEEPING_DISABLED" } };
  }

  // 4. Cuerpo.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("no es un objeto");
    body = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { ok: false, error: "INVALID_JSON" } };
  }

  const env = parseBeepingWebhookEnvelope(body, headers);

  // 5. Traza de descubrimiento: la FORMA del envoltorio, nunca su contenido.
  //    Es lo que permitirá cerrar el contrato con entregas reales.
  logIntegrationEvent(
    "beeping",
    "beeping_webhook_received",
    "info",
    `evento=${env.event ?? "?"} entrega=${env.deliveryId ? "sí" : "no"} claves=[${env.shape.join(",")}]`
  );

  // 6. Evento desconocido: 200 (reintentar no arregla nada) y CERO efectos.
  if (!env.event || !isBeepingWebhookEvent(env.event)) {
    logIntegrationEvent(
      "beeping",
      "beeping_webhook_unknown_event",
      "warning",
      `evento no soportado "${env.event ?? "(sin identificar)"}": ignorado sin efectos`
    );
    return { status: 200, body: { ok: true, ignored: "unknown_event", event: env.event } };
  }
  const event = env.event;

  // 7. Sin pedido legible el evento no se puede aplicar a nada. No se
  //    adivina por nombre ni teléfono: se registra la forma y se descarta.
  if (!env.order) {
    logIntegrationEvent(
      "beeping",
      "beeping_webhook_unknown_event",
      "warning",
      `${event} sin pedido legible (falta external_id); claves=[${env.shape.join(",")}]: ignorado sin efectos`
    );
    return { status: 200, body: { ok: true, ignored: "no_order_in_payload", event } };
  }

  // 8. Idempotencia. Antes de cualquier efecto: si el reintento nº 10 llega,
  //    aquí se para. Si el pedido aún no existiera localmente, el polling lo
  //    reconcilia después — por eso reclamar aquí es seguro.
  const clave = beepingWebhookIdempotencyKey(env, event);
  if (!claimWebhookEvent(clave, "beeping", event, env.order.external_id)) {
    logIntegrationEvent("beeping", "beeping_webhook_duplicate", "info", `reintento de ${event} ignorado (dedupe)`);
    return { status: 200, body: { ok: true, duplicate: true, event } };
  }

  // 9. Negocio: EXACTAMENTE la misma función que el polling. Las guardas de
  //    terminales (eje logístico y eje de cierre), el anti-retroceso por
  //    llegada fuera de orden y los sellos anti-duplicado de WhatsApp viven
  //    ahí dentro, una sola vez, para las dos vías.
  const r = applyBeepingOrderLocally(env.order, { source: "webhook", eventId: clave, occurredAt: env.occurredAt });

  if (!r.matched) {
    logIntegrationEvent(
      "beeping",
      "beeping_webhook_order_not_found",
      "warning",
      `${event}: el pedido ${env.order.external_id} de Beeping no existe en la base local`
    );
    return { status: 200, body: { ok: true, ignored: "order_not_found", event } };
  }

  logIntegrationEvent(
    "beeping",
    "beeping_webhook_processed",
    "info",
    `${event} aplicado${r.skippedOtherSupplier ? " (solo foto: el pedido va por otro proveedor)" : ""}`,
    r.orderNumber
  );
  logger.info(`[BEEPING] webhook ${event} aplicado a #${r.orderNumber ?? "?"}`);

  return {
    status: 200,
    body: {
      ok: true,
      event,
      order: r.orderNumber,
      updated: r.updated,
      closure_updated: r.closureUpdated,
      review_marked: r.reviewMarked,
      skipped_other_supplier: r.skippedOtherSupplier,
    },
  };
}
