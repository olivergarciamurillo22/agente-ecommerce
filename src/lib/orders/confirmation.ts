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
  clearSelectedOrderContext,
  getActiveOrdersByPhone,
  getNeedsCallOrdersByPhone,
  getLatestCustomerOrderByPhone,
  getOrCreateConversation,
  getOrderById,
  getConversationOrderContext,
  markOrderPossibleDuplicate,
  recordConversationPrompt,
  requestOrderCancellation,
  requestConfirmedOrderCancellation,
  resetConversationPrompt,
  setPendingCancelContext,
  setSelectedOrderContext,
  markOrderConfirmed,
  markOrderNeedsCorrection,
  markOrderNeedsCall,
  markOrderAwaitingDeliveryNote,
  saveOrderDeliveryNote,
  setOrderCustomerReplied,
  appendOrderProposedAddress,
  setOrderShopifyTagged,
  setMode,
  type OrderRow,
} from "../db";
import { tagOrderConfirmed } from "../shopify/admin";
import { orderActionAllowed } from "../safety";
import {
  buildCancelConfirmPrompt,
  buildCancelMultiPrompt,
  buildDuplicateReviewMessage,
  buildOrderActionMenu,
  MSG_CANCEL_RECEIVED,
  MSG_ESCALATE_TO_HUMAN,
  MSG_CONFIRMED,
  MSG_ASK_ADDRESS,
  MSG_ADDRESS_SAVED,
  MSG_ASK_NOTE,
  MSG_NOTE_SAVED,
  buildDisambiguationMessage,
} from "./messages";
import {
  claimsSingleOrder,
  findPossibleDuplicates,
  isCancelIntent,
  isExplicitCancelConfirmation,
  matchOrderByProduct,
  saysBoth,
} from "./multi-order";
import { logIntegrationEvent } from "../system/repo";
import { assessOrderAddress } from "./address-quality";
import { markOrderToSend } from "../suppliers/beeping";

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

/** Detector deliberadamente pequeño: solo escala, nunca cancela ni responde. */
export function isPossibleCancellationText(text: string): boolean {
  const n = normalizeText(text);
  return (
    /\b(cancelar|cancela|cancele|cancelacion|anular|anula|devolver|devolucion)\b/.test(n) ||
    /\bno lo quiero\b/.test(n) ||
    /\bsin mi permiso\b/.test(n) ||
    /\bequivocacion\b/.test(n) ||
    /\berror en el pedido\b/.test(n)
  );
}

function requiresImmediateHumanForCancellation(text: string): boolean {
  const n = normalizeText(text);
  return (
    /\bsin mi permiso\b/.test(n) ||
    /\bdevolver|devolucion\b/.test(n) ||
    /\bequivocacion\b/.test(n) ||
    /\berror en el pedido\b/.test(n)
  );
}

function escalateFreeText(phone: string, orders: OrderRow[], cancellation: boolean): OrderReplyResult {
  const convo = getOrCreateConversation(phone);
  setMode(convo.id, "HUMAN");
  for (const order of orders) markOrderNeedsCall(order.id);
  const order = orders[0];
  logIntegrationEvent(
    "whatsapp",
    cancellation ? "posible_cancelacion_texto_libre" : "texto_libre_requiere_atencion",
    "critical",
    cancellation
      ? "posible cancelación detectada en texto libre; conversación derivada a HUMAN"
      : "texto libre no reconocido; conversación derivada a HUMAN por seguridad",
    order?.shopify_order_number ?? null
  );
  return { handled: true, authorized: orders.some((o) => o.pilot_authorized === 1) };
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
  // Best-effort y en segundo plano: nunca retrasa WhatsApp ni revierte el
  // estado local si Beeping falla.
  void markOrderToSend(order.shopify_order_number);
  void tagOrderConfirmed(order.shopify_order_id).then((ok) => {
    if (ok) setOrderShopifyTagged(order.id);
  });
}

/** Respuesta 1/2/3/desconocida sobre un pedido en awaiting_reply/reminder_sent. */
function applyIntent(order: OrderRow, intent: OrderReplyIntent): OrderReplyResult {
  if (intent === "confirm") {
    const address = assessOrderAddress(order.address_line1);
    if (address.suspicious) {
      markOrderNeedsCorrection(order.id);
      logIntegrationEvent(
        "whatsapp",
        "direccion_sospechosa",
        "warning",
        `confirmación automática bloqueada: ${address.reason}`,
        order.shopify_order_number
      );
      logger.warn(`[ORDER] #${order.shopify_order_number} -> needs_correction (dirección sospechosa: ${address.reason})`);
      return { handled: true, reply: MSG_ASK_ADDRESS };
    }
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
  // Fuera de un flujo esperado, el texto libre no se archiva en silencio:
  // se aparta el bot y lo revisa una persona. No se genera respuesta.
  return escalateFreeText(order.phone, [order], false);
}

/** El pedido está en needs_correction: capturamos su dirección propuesta. */
function captureAddress(order: OrderRow, rawText: string, intent: OrderReplyIntent): OrderReplyResult {
  // "1" (u otra confirmación clara) SIN haber mandado dirección = al final
  // todo estaba bien. Con dirección ya propuesta, es un simple asentimiento.
  if (intent === "confirm") {
    if (!order.proposed_address) {
      return applyIntent(order, intent);
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
  if (isPossibleCancellationText(rawText)) {
    return escalateFreeText(order.phone, [order], true);
  }
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

// --- Contexto de conversación (memoria entre mensajes) ---

function selectedOrderTtlMinutes(): number {
  const v = parseInt(process.env.SELECTED_ORDER_TTL_MINUTES ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 45;
}

function maxSamePromptRepeats(): number {
  const v = parseInt(process.env.MAX_SAME_PROMPT_REPEATS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 2;
}

interface LoadedContext {
  /** Fila cruda (para last_prompt_type y pending_cancel). */
  raw: ReturnType<typeof getConversationOrderContext>;
  /** El pedido seleccionado, SOLO si la selección sigue siendo válida. */
  selectedOrder: OrderRow | null;
}

/**
 * Carga el contexto y VALIDA la selección. Una selección deja de valer si:
 *  - caducó (SELECTED_ORDER_TTL_MINUTES, 45 min por defecto): media hora
 *    después, "sí" ya no puede referirse en silencio a aquel pedido;
 *  - el pedido ya no está activo (se confirmó, se canceló, escaló);
 *  - llegó un pedido NUEVO después de seleccionar: el siguiente mensaje del
 *    cliente podría hablar del nuevo, así que se vuelve a preguntar en vez
 *    de asumir que sigue hablando del antiguo.
 */
function loadValidContext(phone: string, active: OrderRow[]): LoadedContext {
  const raw = getConversationOrderContext(phone);
  if (!raw) return { raw: null, selectedOrder: null };

  let selectedOrder: OrderRow | null = null;
  if (raw.selected_order_id !== null && raw.selected_at !== null) {
    const now = Math.floor(Date.now() / 1000);
    const dentroDeTtl = now - raw.selected_at <= selectedOrderTtlMinutes() * 60;
    const sigueActivo = active.find((o) => o.id === raw.selected_order_id) ?? null;
    const llegoUnoNuevo = active.some((o) => o.created_at > (raw.selected_at ?? 0));
    if (dentroDeTtl && sigueActivo && !llegoUnoNuevo) {
      selectedOrder = sigueActivo;
    } else {
      clearSelectedOrderContext(phone);
    }
  }
  return { raw, selectedOrder };
}

/**
 * Ejecuta una petición de cancelación CONFIRMADA. "Ejecutar" aquí es marcar:
 * cancellation_requested_at + needs_call. NUNCA se toca Shopify ni el
 * proveedor desde una conversación de WhatsApp — la cancelación real la
 * decide Pedro viendo el pedido. Como el pedido deja de estar confirmado,
 * tampoco puede entrar en ningún envío al proveedor mientras tanto.
 */
function executeCancellation(phone: string, orders: OrderRow[]): OrderReplyResult {
  for (const o of orders) {
    requestOrderCancellation(o.id);
    logger.info(`[ORDER] #${o.shopify_order_number} -> cancelación solicitada por el cliente (needs_call)`);
    logIntegrationEvent(
      "whatsapp",
      "cancellation_requested",
      "warning",
      "el cliente pidió cancelar por WhatsApp: pedido marcado para revisión, sin tocar Shopify",
      o.shopify_order_number
    );
  }
  clearSelectedOrderContext(phone);
  resetConversationPrompt(phone);
  return {
    handled: true,
    reply: MSG_CANCEL_RECEIVED,
    authorized: orders.some((o) => o.pilot_authorized === 1),
  };
}

/**
 * Punto de entrada: procesa un mensaje entrante de este teléfono.
 * Devuelve handled=false si el teléfono no tiene pedidos activos (y entonces
 * el mensaje sigue su curso normal: IA si está configurada, o nada).
 *
 * MÁQUINA DE ESTADOS REAL desde el 25-08-2026 (bug de producción): el flujo
 * multi-pedido tiene MEMORIA. "1097" selecciona; "todo correcto" después se
 * aplica a ESE pedido. Antes cada mensaje re-resolvía la ambigüedad desde
 * cero y elegir un pedido no servía de nada.
 *
 * La comprensión es flexible (número, producto, frases de cancelación); la
 * ejecución es determinista: sin coincidencia inequívoca no se actúa, y
 * cancelar exige SIEMPRE verbo + número de pedido explícitos.
 */
export function handleOrderReply(phone: string, text: string): OrderReplyResult {
  // Solo pedidos sobre los que PODEMOS actuar: en TEST_MODE, los de la
  // allowlist o los autorizados a mano para el piloto. Un pedido no elegible
  // nunca recibió el mensaje inicial, así que su "respuesta" no es tal.
  const active = getActiveOrdersByPhone(phone).filter((o) => orderActionAllowed(o));
  if (active.length === 0) {
    // El bot ya se apartó (needs_call = manos humanas) y por diseño calla…
    // pero "cancelar" NO puede perderse en ese silencio: se estampa la
    // petición (nada se cancela solo) para que en Acciones pase de "hay que
    // llamarle" (urgencia 4) a "pide cancelar" (urgencia 1), y se le
    // confirma al cliente que su petición quedó registrada.
    if (isCancelIntent(text)) {
      const enManosHumanas = getNeedsCallOrdersByPhone(phone).filter((o) => orderActionAllowed(o));
      if (enManosHumanas.length > 0) return executeCancellation(phone, enManosHumanas);
    }
    const latest = getLatestCustomerOrderByPhone(phone);
    if (latest && orderActionAllowed(latest) && classifyOrderReply(text) === "unknown") {
      return escalateFreeText(phone, [latest], isPossibleCancellationText(text));
    }
    return { handled: false };
  }

  const authorized = (r: OrderReplyResult, order: OrderRow): OrderReplyResult => ({
    ...r,
    authorized: order.pilot_authorized === 1,
  });

  const intent = classifyOrderReply(text);
  const quiereCancelar = isCancelIntent(text);
  const context = loadValidContext(phone, active);

  // Una posible cancelación escrita libremente nunca se guarda como nota ni
  // queda esperando otra confirmación del bot: pasa directamente a HUMAN.
  if (requiresImmediateHumanForCancellation(text)) {
    return escalateFreeText(phone, active, true);
  }

  // --- Caso simple: un único pedido activo ---
  if (active.length === 1) {
    const order = active[0];
    if (quiereCancelar) {
      // Formato explícito (verbo + número) → se registra la petición. Menos
      // que eso ("no lo quiero", "cancelar") → confirmación primero: una
      // frase ambigua jamás cancela.
      if (isExplicitCancelConfirmation(text, order.shopify_order_number)) {
        return executeCancellation(phone, [order]);
      }
      setPendingCancelContext(phone, order.id);
      return authorized({ handled: true, reply: buildCancelConfirmPrompt(order) }, order);
    }
    return authorized(routeToOrder(order, text, intent), order);
  }

  // --- Varios pedidos activos del mismo teléfono ---

  // 1) Menciona un número de pedido concreto.
  const byNumber = matchOrderByNumber(active, text);
  if (byNumber) {
    const order = byNumber.order;
    const rest = byNumber.rest.trim();
    const restIntent = classifyOrderReply(rest);
    resetConversationPrompt(phone);

    // "cancelar 1097": verbo + número = el formato explícito que exigimos.
    if (quiereCancelar) {
      return executeCancellation(phone, [order]);
    }

    const capturando = order.status === "needs_correction" || order.status === "awaiting_delivery_note";

    // EL BUG REAL: "1097" a secas era "no te he entendido". Elegir un pedido
    // por su número es una SELECCIÓN: se recuerda y se pregunta qué hacer.
    if (!capturando && restIntent === "unknown") {
      setSelectedOrderContext(phone, order.id);
      logIntegrationEvent(
        "whatsapp",
        "order_selected",
        "info",
        "el cliente eligió un pedido por su número en una conversación multi-pedido",
        order.shopify_order_number
      );
      return authorized({ handled: true, reply: buildOrderActionMenu(order) }, order);
    }

    // Número + acción ("1097 1") → directo, y queda seleccionado para
    // los mensajes siguientes mientras el pedido siga activo.
    setSelectedOrderContext(phone, order.id);
    const r = authorized(routeToOrder(order, rest, restIntent), order);
    if (restIntent === "confirm") clearSelectedOrderContext(phone);
    return r;
  }

  // 2) Hay un pedido SELECCIONADO válido: los mensajes son sobre él.
  if (context.selectedOrder) {
    const sel = context.selectedOrder;
    if (quiereCancelar) {
      setPendingCancelContext(phone, sel.id);
      return authorized({ handled: true, reply: buildCancelConfirmPrompt(sel) }, sel);
    }
    resetConversationPrompt(phone);
    const r = authorized(routeToOrder(sel, text, intent), sel);
    if (intent === "confirm") clearSelectedOrderContext(phone);
    return r;
  }

  // 3) "Ambos" tras haber preguntado "¿cancelar ambos o solo uno?".
  if (saysBoth(text) && context.raw?.last_prompt_type === "cancel_multi") {
    return executeCancellation(phone, active);
  }

  // 4) Quiere cancelar sin decir cuál: JAMÁS se cancelan todos por una frase.
  if (quiereCancelar) {
    setPendingCancelContext(phone, null);
    const veces = recordConversationPrompt(phone, "cancel_multi");
    if (veces > maxSamePromptRepeats()) {
      // No entramos en bucle tampoco aquí: a revisión humana.
      for (const o of active) markOrderNeedsCall(o.id);
      logIntegrationEvent("whatsapp", "conversation_escalated", "warning",
        "cancelación multi-pedido sin resolver tras varios intentos: a revisión humana");
      resetConversationPrompt(phone);
      return {
        handled: true,
        reply: MSG_ESCALATE_TO_HUMAN,
        authorized: active.some((o) => o.pilot_authorized === 1),
      };
    }
    return {
      handled: true,
      reply: buildCancelMultiPrompt(active),
      authorized: active.some((o) => o.pilot_authorized === 1),
    };
  }

  // 5) "Solo he pedido uno" + pedidos que parecen el MISMO → duplicado
  //    probable. No se obliga al cliente a manejar números internos: se
  //    marca todo para revisión y se le tranquiliza. Nada se cancela solo.
  if (claimsSingleOrder(text)) {
    const grupos = findPossibleDuplicates(active);
    if (grupos.length > 0) {
      for (const grupo of grupos) {
        for (const o of grupo) {
          markOrderPossibleDuplicate(o.id);
          markOrderNeedsCall(o.id);
          logIntegrationEvent(
            "whatsapp",
            "duplicate_suspected",
            "warning",
            "el cliente dice que solo hizo un pedido y hay dos idénticos: marcados para revisión",
            o.shopify_order_number
          );
        }
      }
      clearSelectedOrderContext(phone);
      resetConversationPrompt(phone);
      return {
        handled: true,
        reply: buildDuplicateReviewMessage(grupos[0]),
        authorized: active.some((o) => o.pilot_authorized === 1),
      };
    }
  }

  // 6) Menciona un producto que identifica UN pedido sin ambigüedad
  //    ("el cortauñas" cuando solo un pedido lo lleva). Si los dos venden lo
  //    mismo, esto no resuelve nada y se sigue de largo.
  const byProduct = matchOrderByProduct(active, text);
  if (byProduct) {
    resetConversationPrompt(phone);
    setSelectedOrderContext(phone, byProduct.id);
    logIntegrationEvent(
      "whatsapp",
      "order_selected",
      "info",
      "pedido identificado por el producto mencionado en una conversación multi-pedido",
      byProduct.shopify_order_number
    );
    if (intent !== "unknown") {
      const r = authorized(routeToOrder(byProduct, text, intent), byProduct);
      if (intent === "confirm") clearSelectedOrderContext(phone);
      return r;
    }
    return authorized({ handled: true, reply: buildOrderActionMenu(byProduct) }, byProduct);
  }

  // 7) Ambiguo de verdad: selector — pero NUNCA en bucle. A la tercera vez
  //    consecutiva sin resolver, esto pasa a un humano. Repetir el mismo
  //    mensaje una quinta vez a alguien que ya dijo tres veces que no lo
  //    entiende no es insistencia: es un bucle (pasó de verdad).
  for (const o of active) setOrderCustomerReplied(o.id);
  const veces = recordConversationPrompt(phone, "disambiguation");
  if (veces > maxSamePromptRepeats()) {
    for (const o of active) markOrderNeedsCall(o.id);
    logIntegrationEvent(
      "whatsapp",
      "conversation_escalated",
      "warning",
      `conversación multi-pedido sin resolver tras ${veces - 1} selectores: a revisión humana`
    );
    resetConversationPrompt(phone);
    return {
      handled: true,
      reply: MSG_ESCALATE_TO_HUMAN,
      authorized: active.some((o) => o.pilot_authorized === 1),
    };
  }
  if (veces === 1) {
    logIntegrationEvent("whatsapp", "multiple_orders_detected", "info",
      `respuesta ambigua con ${active.length} pedidos activos: se pide concretar`);
  }
  logger.info(`[ORDER] respuesta ambigua con ${active.length} pedidos activos — pido nº de pedido`);
  return {
    handled: true,
    reply: buildDisambiguationMessage(active),
    authorized: active.some((o) => o.pilot_authorized === 1),
  };
}

// --- Botones de la Cloud API → la MISMA máquina de estados ---

/** Payloads deterministas de los botones. El texto visible es presentación. */
export const BUTTON_PAYLOADS = {
  CONFIRM: "confirm_order",
  CHANGE_ADDRESS: "change_address",
  DELIVERY_NOTE: "delivery_note",
  CANCEL_REQUEST: "cancel_request",
  /** Prefijo de selección en listas multi-pedido: select_order:1097 */
  SELECT_ORDER: "select_order:",
} as const;

/**
 * Traduce el payload de un botón a la ENTRADA EQUIVALENTE de la máquina de
 * texto y la reutiliza entera. Cero lógica nueva de estados: un botón es
 * exactamente lo mismo que escribir la respuesta, pero sin ambigüedad.
 *
 * `cancel_request` es el único con tratamiento propio: pulsar un botón que
 * dice "Quiero cancelar" ya es una acción deliberada, así que con UN pedido
 * inequívoco se registra directamente (la "ejecución" sigue siendo solo
 * marcar + needs_call: Shopify no se toca jamás). Con varios pedidos y sin
 * selección, entra en el flujo seguro de "¿ambos o solo uno?".
 */
export function handleOrderButtonReply(phone: string, payload: string): OrderReplyResult {
  const p = payload.trim();

  if (p.startsWith(BUTTON_PAYLOADS.SELECT_ORDER)) {
    const num = p.slice(BUTTON_PAYLOADS.SELECT_ORDER.length).replace(/[^0-9]/g, "");
    if (!num) return { handled: false };
    return handleOrderReply(phone, num);
  }

  if (p === BUTTON_PAYLOADS.CONFIRM) return handleOrderReply(phone, "1");
  if (p === BUTTON_PAYLOADS.CHANGE_ADDRESS) return handleOrderReply(phone, "2");
  if (p === BUTTON_PAYLOADS.DELIVERY_NOTE) return handleOrderReply(phone, "3");

  if (p === BUTTON_PAYLOADS.CANCEL_REQUEST) {
    const active = getActiveOrdersByPhone(phone).filter((o) => orderActionAllowed(o));
    if (active.length === 0) return { handled: false };
    if (active.length === 1) {
      // Botón deliberado + pedido inequívoco = confirmación suficiente.
      return handleOrderReply(phone, `cancelar ${active[0].shopify_order_number}`);
    }
    const context = loadValidContext(phone, active);
    if (context.selectedOrder) {
      return handleOrderReply(phone, `cancelar ${context.selectedOrder.shopify_order_number}`);
    }
    return handleOrderReply(phone, "cancelar"); // → "¿ambos o solo uno?"
  }

  // Botones del aviso de retraso: llevan SIEMPRE el id exacto del pedido.
  const delayOk = /^delay_ok:(\d+)$/.exec(p);
  if (delayOk) {
    const order = getOrderById(Number(delayOk[1]));
    if (!order || order.phone !== phone) return { handled: false };

    logIntegrationEvent(
      "whatsapp",
      "delay_accepted",
      "info",
      "cliente acepta esperar la reposición",
      order.shopify_order_number
    );

    return {
      handled: true,
      reply: "Gracias por tu comprensión. Te avisaremos en cuanto tu pedido salga de nuestro almacén.",
      authorized: order.pilot_authorized === 1,
    };
  }

  const delayCancel = /^delay_cancel:(\d+)$/.exec(p);
  if (delayCancel) {
    const order = getOrderById(Number(delayCancel[1]));
    if (!order || order.phone !== phone) return { handled: false };

    const changed = requestConfirmedOrderCancellation(order.id);

    logIntegrationEvent(
      "whatsapp",
      "delay_cancellation_requested",
      changed ? "warning" : "info",
      changed
        ? "cliente solicita cancelar tras aviso de retraso; requiere gestión humana"
        : "solicitud de cancelación postventa ya no aplicable",
      order.shopify_order_number
    );

    return {
      handled: true,
      reply: changed
        ? "Hemos registrado tu solicitud de cancelación. Nuestro equipo la revisará antes de realizar cualquier envío."
        : "Tu solicitud ha quedado registrada para revisión.",
      authorized: order.pilot_authorized === 1,
    };
  }

  // Payload desconocido: no se adivina nada. Visible en logs, sin respuesta.
  logger.warn(`[ORDER] payload de botón desconocido: "${p.slice(0, 40)}"`);
  return { handled: false };
}
