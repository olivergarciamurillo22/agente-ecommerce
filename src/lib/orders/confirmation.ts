// ============================================================
// Máquina de estados de confirmación — interpreta la respuesta del cliente.
//
// 100% determinista, sin IA, coste 0 €. El handler de Baileys la llama ANTES
// del flujo de IA: si el teléfono tiene pedidos activos, la respuesta se
// resuelve aquí y la IA ni se entera.
//
// Reglas de oro:
//  - NUNCA confirmar con una respuesta ambigua (se pide aclaración una vez;
//    a la segunda ambigüedad, el pedido pasa a needs_call).
//  - Si el teléfono tiene VARIOS pedidos activos, se pide el número de pedido:
//    jamás se confirma (ni se asocia una nota) al pedido equivocado.
//  - La dirección corregida se guarda en proposed_address para revisión de
//    Pedro. NUNCA se actualiza Shopify automáticamente.
//  - La nota al repartidor (opción 3) se guarda en delivery_note y NO
//    confirma el pedido: vuelve a quedar esperando el 1/2.
// ============================================================

import pino from "pino";
import {
  getActiveOrdersByPhone,
  markOrderConfirmed,
  markOrderNeedsCorrection,
  markOrderNeedsCall,
  markOrderAwaitingDeliveryNote,
  saveOrderDeliveryNote,
  setOrderCustomerReplied,
  appendOrderProposedAddress,
  incrementOrderClarify,
  setOrderShopifyTagged,
  type OrderRow,
} from "../db";
import { tagOrderConfirmed } from "../shopify/admin";
import { orderActionAllowed } from "../safety";
import {
  MSG_CONFIRMED,
  MSG_ASK_ADDRESS,
  MSG_ADDRESS_SAVED,
  MSG_ASK_NOTE,
  MSG_NOTE_SAVED,
  MSG_CLARIFY,
  MSG_WILL_CALL,
  buildDisambiguationMessage,
} from "./messages";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export interface OrderReplyResult {
  /** true = el mensaje pertenecía al flujo de pedidos: la IA no debe intervenir. */
  handled: boolean;
  /** Respuesta a enviar al cliente (si procede). */
  reply?: string;
  /** true si el pedido implicado está autorizado a mano para el piloto. */
  authorized?: boolean;
}

export type OrderReplyIntent = "confirm" | "change_address" | "delivery_note" | "unknown";

/** minúsculas, sin tildes, sin signos, espacios colapsados — comparación robusta. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Solo frases INEQUÍVOCAS. Cualquier otra cosa pide aclaración.
// (Se comparan ya normalizadas: "sí" y "está bien" entran como "si"/"esta bien".)
const CONFIRM_PHRASES = new Set([
  "1",
  "si",
  "confirmo",
  "confirmado",
  "correcto",
  "todo correcto",
  "si todo correcto",
  "todo bien",
  "si correcto",
  "esta bien",
  "asi es",
  "ok",
  "okey",
  "vale",
  "perfecto",
  "de acuerdo",
]);

const CHANGE_ADDRESS_PHRASES = new Set([
  "2",
  "corregir",
  "cambiar",
  "quiero corregir",
  "quiero cambiar",
  "corregir direccion",
  "cambiar direccion",
  "corregir la direccion",
  "cambiar la direccion",
  "quiero corregir la direccion",
  "quiero cambiar la direccion",
  "la direccion esta mal",
  "direccion incorrecta",
]);

const NOTE_PHRASES = new Set([
  "3",
  "nota",
  "dejar nota",
  "dejar una nota",
  "nota repartidor",
  "nota al repartidor",
  "nota para el repartidor",
  "dejar nota al repartidor",
  "quiero dejar una nota",
  "quiero dejar una nota al repartidor",
]);

/**
 * Clasifica la respuesta del cliente SIN IA. Ante la duda → "unknown"
 * ("creo que sí pero la dirección no sé" jamás confirma).
 */
export function classifyOrderReply(text: string): OrderReplyIntent {
  const n = normalizeText(text);
  if (CONFIRM_PHRASES.has(n) || /^1\b/.test(n)) return "confirm";
  if (CHANGE_ADDRESS_PHRASES.has(n) || /^2\b/.test(n)) return "change_address";
  if (NOTE_PHRASES.has(n) || /^3\b/.test(n)) return "delivery_note";
  return "unknown";
}

/**
 * Confirma un pedido (por respuesta del cliente o a mano desde el panel) y
 * lanza el tag WA_CONFIRMED en Shopify en segundo plano (tagsAdd: añade sin
 * tocar los tags existentes; si falla, el scheduler lo reintenta).
 *
 * - El claim de la DB garantiza que una doble confirmación (dos "1" seguidos,
 *   o panel + respuesta a la vez) dispara el tag UNA sola vez.
 * - En TEST_MODE el tag solo sale para teléfonos de la allowlist (los pedidos
 *   de clientes reales jamás se tocan en Shopify durante las pruebas).
 */
export function confirmOrder(order: OrderRow, via: "reply" | "manual"): void {
  const claimed = markOrderConfirmed(order.id, via === "reply");
  if (!claimed) {
    logger.warn(
      `[ORDER] #${order.shopify_order_number} transición a confirmed RECHAZADA (estado ${order.status}) — sin side effects`
    );
    return;
  }
  logger.info(`[ORDER] #${order.shopify_order_number} -> confirmed (${via})`);
  if (!orderActionAllowed(order)) {
    logger.info(
      `[TEST MODE] tag WA_CONFIRMED de #${order.shopify_order_number} omitido: fuera de allowlist y sin autorizar`
    );
    return;
  }
  void tagOrderConfirmed(order.shopify_order_id).then((ok) => {
    if (ok) setOrderShopifyTagged(order.id);
  });
}

/** Respuesta 1/2/3/desconocida sobre un pedido en awaiting_reply/reminder_sent. */
function applyIntent(order: OrderRow, intent: OrderReplyIntent): OrderReplyResult {
  if (intent === "confirm") {
    logger.info(`[WHATSAPP] Customer confirmed #${order.shopify_order_number}`);
    confirmOrder(order, "reply");
    return { handled: true, reply: MSG_CONFIRMED };
  }
  if (intent === "change_address") {
    markOrderNeedsCorrection(order.id);
    logger.info(`[ORDER] #${order.shopify_order_number} -> needs_correction`);
    return { handled: true, reply: MSG_ASK_ADDRESS };
  }
  if (intent === "delivery_note") {
    markOrderAwaitingDeliveryNote(order.id);
    logger.info(`[ORDER] #${order.shopify_order_number} -> awaiting_delivery_note`);
    return { handled: true, reply: MSG_ASK_NOTE };
  }
  // Ambigua: una aclaración y, si reincide, a la lista de llamadas.
  setOrderCustomerReplied(order.id);
  const clarifies = incrementOrderClarify(order.id);
  if (clarifies <= 1) {
    return { handled: true, reply: MSG_CLARIFY };
  }
  markOrderNeedsCall(order.id);
  logger.info(`[ORDER] #${order.shopify_order_number} -> needs_call (respuestas ambiguas)`);
  return { handled: true, reply: MSG_WILL_CALL };
}

/** El pedido está en needs_correction: capturamos su dirección propuesta. */
function captureAddress(order: OrderRow, rawText: string, intent: OrderReplyIntent): OrderReplyResult {
  // "1" (u otra confirmación clara) SIN haber mandado dirección = al final
  // todo estaba bien. Con dirección ya propuesta, es un simple asentimiento.
  if (intent === "confirm") {
    if (!order.proposed_address) {
      logger.info(`[WHATSAPP] Customer confirmed #${order.shopify_order_number} (tras dudar)`);
      confirmOrder(order, "reply");
      return { handled: true, reply: MSG_CONFIRMED };
    }
    return { handled: true, reply: "¡Gracias! Revisamos la dirección y preparamos tu pedido 👍" };
  }
  // "2" otra vez, o texto vacío: repetimos qué necesitamos, sin guardar basura.
  if (intent === "change_address" || !rawText.trim()) {
    return { handled: true, reply: MSG_ASK_ADDRESS };
  }
  // "3": prefiere dejar nota al repartidor; la dirección propuesta (si la hay) se conserva.
  if (intent === "delivery_note") {
    markOrderAwaitingDeliveryNote(order.id);
    logger.info(`[ORDER] #${order.shopify_order_number} -> awaiting_delivery_note`);
    return { handled: true, reply: MSG_ASK_NOTE };
  }
  const firstChunk = !order.proposed_address;
  appendOrderProposedAddress(order.id, rawText);
  logger.info(`[ORDER] #${order.shopify_order_number} dirección propuesta recibida`);
  // Si manda la dirección en varios mensajes, solo agradecemos el primero.
  return { handled: true, reply: firstChunk ? MSG_ADDRESS_SAVED : undefined };
}

/** El pedido está en awaiting_delivery_note: el siguiente texto ES la nota. */
function captureNote(order: OrderRow, rawText: string, intent: OrderReplyIntent): OrderReplyResult {
  // Cambió de idea: confirma directamente (la nota queda sin dejar).
  if (intent === "confirm") {
    logger.info(`[WHATSAPP] Customer confirmed #${order.shopify_order_number} (sin nota)`);
    confirmOrder(order, "reply");
    return { handled: true, reply: MSG_CONFIRMED };
  }
  if (intent === "change_address") {
    markOrderNeedsCorrection(order.id);
    logger.info(`[ORDER] #${order.shopify_order_number} -> needs_correction`);
    return { handled: true, reply: MSG_ASK_ADDRESS };
  }
  // "3"/"nota" otra vez, o vacío: seguimos esperando el texto de la nota.
  if (intent === "delivery_note" || !rawText.trim()) {
    return { handled: true, reply: MSG_ASK_NOTE };
  }
  // Guardar la nota NO confirma: vuelve a awaiting_reply esperando el 1/2.
  saveOrderDeliveryNote(order.id, rawText);
  logger.info(`[ORDER] #${order.shopify_order_number} nota para el repartidor guardada`);
  return { handled: true, reply: MSG_NOTE_SAVED };
}

/** Enruta el mensaje según el estado del pedido concreto. */
function routeToOrder(order: OrderRow, rawText: string, intent: OrderReplyIntent): OrderReplyResult {
  if (order.status === "needs_correction") return captureAddress(order, rawText, intent);
  if (order.status === "awaiting_delivery_note") return captureNote(order, rawText, intent);
  return applyIntent(order, intent);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Busca un número de pedido activo mencionado en el texto ("35010484 1", "#35010484"...). */
function matchOrderByNumber(orders: OrderRow[], rawText: string): { order: OrderRow; rest: string } | null {
  const matches: Array<{ order: OrderRow; rest: string }> = [];
  for (const o of orders) {
    const num = o.shopify_order_number;
    if (!num) continue;
    const re = new RegExp(`(?:^|[^0-9])#?(${escapeRegex(num)})(?:[^0-9]|$)`);
    if (re.test(rawText)) {
      matches.push({ order: o, rest: rawText.replace(new RegExp(`#?${escapeRegex(num)}`), " ") });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Punto de entrada: procesa un mensaje entrante de este teléfono.
 * Devuelve handled=false si el teléfono no tiene pedidos activos (y entonces
 * el mensaje sigue su curso normal: IA si está configurada, o nada).
 */
export function handleOrderReply(phone: string, text: string): OrderReplyResult {
  // Solo pedidos sobre los que PODEMOS actuar: en TEST_MODE, los de la
  // allowlist o los autorizados a mano para el piloto. Un pedido no elegible
  // nunca recibió el mensaje inicial, así que su "respuesta" no es tal.
  const active = getActiveOrdersByPhone(phone).filter((o) => orderActionAllowed(o));
  if (active.length === 0) return { handled: false };

  // La respuesta hereda la autorización del pedido concreto al que afecta.
  const authorized = (r: OrderReplyResult, order: OrderRow): OrderReplyResult => ({
    ...r,
    authorized: order.pilot_authorized === 1,
  });

  const intent = classifyOrderReply(text);

  // --- Caso simple: un único pedido activo ---
  if (active.length === 1) {
    return authorized(routeToOrder(active[0], text, intent), active[0]);
  }

  // --- Varios pedidos activos del mismo teléfono ---
  // 1) ¿Menciona un número de pedido concreto? → operamos sobre ese.
  const byNumber = matchOrderByNumber(active, text);
  if (byNumber) {
    return authorized(
      routeToOrder(byNumber.order, byNumber.rest.trim(), classifyOrderReply(byNumber.rest)),
      byNumber.order
    );
  }

  // 2) Texto libre y EXACTAMENTE un pedido espera texto (dirección o nota):
  //    el mensaje es para ese. Con dos esperando, jamás adivinamos.
  const capturing = active.filter(
    (o) => o.status === "needs_correction" || o.status === "awaiting_delivery_note"
  );
  if (capturing.length === 1 && intent === "unknown") {
    return authorized(routeToOrder(capturing[0], text, intent), capturing[0]);
  }

  // 3) Ambiguo de verdad: pedimos que concrete. JAMÁS adivinamos el pedido.
  for (const o of active) setOrderCustomerReplied(o.id);
  logger.info(`[ORDER] respuesta ambigua con ${active.length} pedidos activos — pido nº de pedido`);
  return {
    handled: true,
    reply: buildDisambiguationMessage(active),
    // Basta con que uno de los pedidos activos esté autorizado para poder
    // contestarle: el mensaje solo enumera sus propios pedidos.
    authorized: active.some((o) => o.pilot_authorized === 1),
  };
}
