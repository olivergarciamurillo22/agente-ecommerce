// ============================================================
// Plantillas de los mensajes de confirmación — voz de Pedro / Casamable™.
//
// Texto plano con "1"/"2"/"3": los botones interactivos de Baileys no son
// estables y esto funciona en cualquier WhatsApp. Nada pasa por IA y el tono
// es de atención al cliente normal: nunca mencionar bot/IA/automatización.
// Los productos salen SIEMPRE de los line_items reales del pedido.
// ============================================================

import type { OrderRow } from "../db";
import { shortProductLine } from "./multi-order";
import { formatAddressForMessage } from "./normalize";

/** Nombre comercial en los mensajes (configurable por si cambia la marca). */
function shopName(): string {
  return process.env.SHOP_NAME?.trim() || "Casamable™";
}

/**
 * Primer nombre del cliente, presentable. En los formularios COD la gente
 * escribe su nombre como sea ("oliver", "PEDRO"): si viene todo en minúsculas
 * o todo en mayúsculas lo capitalizamos; si ya trae mezcla, se respeta tal cual
 * (para no romper apellidos tipo "McCarthy" o "de la Fuente").
 */
function firstName(order: OrderRow): string {
  const raw = (order.customer_name ?? "").trim().split(/\s+/)[0] || "";
  if (!raw) return "";
  const uniforme = raw === raw.toLowerCase() || raw === raw.toUpperCase();
  if (!uniforme) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Importe en formato local: "39,97 €" (nunca "39.97 EUR").
 * La moneda sale del pedido de Shopify; si Intl no la reconoce, degradamos a
 * "importe MONEDA" antes que romper el envío.
 */
export function formatMoney(amount: string | number, currency: string): string {
  const value = typeof amount === "number" ? amount : parseFloat(String(amount).replace(",", "."));
  const code = (currency || "EUR").trim().toUpperCase();
  if (!Number.isFinite(value)) return `${amount} ${code}`.trim();
  try {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency: code }).format(value);
  } catch {
    return `${value.toFixed(2).replace(".", ",")} ${code}`;
  }
}

function money(order: OrderRow): string {
  return formatMoney(order.total_price, order.currency);
}

/** Los productos, una línea por artículo, cada una con su 📦. */
function itemsBlock(order: OrderRow): string {
  const items = order.product_summary || "Tu pedido";
  return items
    .split("\n")
    .map((l) => `📦 ${l}`)
    .join("\n");
}

/**
 * Primera confirmación para el proveedor Baileys, que no admite plantillas de
 * Meta. Es un builder activo y fiel al contrato actual; Cloud API no lo usa
 * como fallback bajo ninguna circunstancia.
 */
export function buildConfirmationMessage(order: OrderRow): string {
  const nombre = firstName(order);
  const total = money(order);
  return (
    `Hola${nombre ? ` ${nombre}` : ""} 👋 Somos ${shopName()}.\n\n` +
    `Confirma tu pedido #${order.shopify_order_number}:\n\n` +
    `${itemsBlock(order)}\n` +
    `💶 Contra reembolso: ${total}. Pagarás al repartidor al recibirlo.\n` +
    `📍 ${formatAddressForMessage(order)}\n\n` +
    `1 - Todo correcto\n` +
    `2 - Quiero cambiar la dirección\n` +
    `3 - Quiero dejar una nota al repartidor`
  );
}

/** Recordatorio si no ha contestado nada. */
export function buildReminderMessage(order: OrderRow): string {
  const nombre = firstName(order);
  return (
    `Hola${nombre ? ` ${nombre}` : ""}, solo nos falta confirmar tu pedido de ${shopName()}.\n\n` +
    `Responde:\n\n` +
    `1 - Todo correcto\n` +
    `2 - Quiero cambiar la dirección\n` +
    `3 - Quiero dejar una nota al repartidor`
  );
}

export const MSG_CONFIRMED =
  "Perfecto, tu pedido ha quedado confirmado ✅\n\nMuchas gracias. Lo prepararemos para su envío.";

export const MSG_ASK_ADDRESS =
  "Perfecto. Escríbeme la dirección completa incluyendo:\n\n" +
  "- calle\n" +
  "- número\n" +
  "- bloque, si existe\n" +
  "- piso y puerta\n" +
  "- código postal\n" +
  "- localidad";

export const MSG_ADDRESS_SAVED =
  "¡Gracias! Hemos anotado la nueva dirección y la revisaremos antes de preparar el envío ✅";

export const MSG_ASK_NOTE = "Perfecto. Escríbeme la nota que quieres dejarle al repartidor.";

export const MSG_NOTE_SAVED =
  "Perfecto, he guardado la nota para el repartidor.\n\n" +
  "¿Confirmas que el pedido y la dirección están correctos?\n\n" +
  "Responde:\n\n" +
  "1 - Todo correcto\n" +
  "2 - Quiero cambiar la dirección";

export const MSG_CLARIFY =
  "Perdona, no te he entendido bien 🙂\n\n" +
  "Responde 1 si está todo correcto, 2 si quieres cambiar la dirección o 3 si quieres dejar una nota al repartidor.";

export const MSG_WILL_CALL =
  "Sin problema, te llamamos nosotros para confirmarlo por teléfono 👍";

/**
 * Varios pedidos activos del mismo teléfono: pedimos el número de pedido.
 *
 * Copy reescrito tras el caso real del 25-08-2026: el selector antiguo solo
 * enseñaba números e importes iguales ("#1097 (29,99 €)" dos veces) — el
 * cliente no podía distinguirlos ni entender por qué había dos. Ahora cada
 * línea lleva el producto, y se le abre la puerta a decir "solo hice uno"
 * en vez de obligarle a manejar números internos.
 */
export function buildDisambiguationMessage(orders: OrderRow[]): string {
  const lista = orders
    .slice(0, 5)
    .map((o) => `#${o.shopify_order_number} · ${shortProductLine(o)} · ${money(o)}`)
    .join("\n");
  const ejemplo = orders[0]?.shopify_order_number ?? "1001";
  return (
    `Veo que tienes ${orders.length === 2 ? "dos" : String(orders.length)} pedidos pendientes:\n\n${lista}\n\n` +
    `Dime el número del que quieres gestionar (por ejemplo "${ejemplo}").\n` +
    `Si solo hiciste uno, dímelo y lo revisamos.`
  );
}

/** El cliente eligió un pedido: menú de acciones SOBRE ese pedido. */
export function buildOrderActionMenu(order: OrderRow): string {
  return (
    `Perfecto, el pedido #${order.shopify_order_number} · ${shortProductLine(order)} · ${money(order)}.\n\n` +
    `¿Qué quieres hacer con él?\n` +
    `1 — Confirmarlo\n` +
    `2 — Cambiar la dirección\n` +
    `3 — Dejar una nota al repartidor\n\n` +
    `Si quieres cancelarlo, escribe CANCELAR ${order.shopify_order_number}.`
  );
}

/** Anti-bucle: el mismo selector ya salió 2 veces sin resolverse. */
export const MSG_ESCALATE_TO_HUMAN =
  "Creo que te estoy liando con los números 🙏\n\n" +
  "Dejo tus pedidos anotados para revisarlos nosotros y te contactamos para confirmar cuál quieres. " +
  "No tienes que hacer nada más.";

/** Posible duplicado detectado y el cliente dice que solo hizo un pedido. */
export function buildDuplicateReviewMessage(orders: OrderRow[]): string {
  const nums = orders.map((o) => `#${o.shopify_order_number}`).join(" y ");
  return (
    `Tienes razón: veo dos pedidos iguales (${nums}) y parece que se ha generado un duplicado.\n\n` +
    `Lo dejo marcado para que lo revisemos y no recibas el pedido dos veces. ` +
    `Te confirmamos en cuanto esté resuelto — no tienes que hacer nada más 👍`
  );
}

/** Cancelación: se exige confirmación explícita, jamás por frase ambigua. */
export function buildCancelConfirmPrompt(order: OrderRow): string {
  return (
    `¿Quieres cancelar el pedido #${order.shopify_order_number} · ${shortProductLine(order)} · ${money(order)}?\n\n` +
    `Para confirmarlo, responde: CANCELAR ${order.shopify_order_number}\n` +
    `Si prefieres quedártelo, responde 1 y lo confirmamos.`
  );
}

/** Cancelación con varios pedidos: ¿ambos o solo uno? */
export function buildCancelMultiPrompt(orders: OrderRow[]): string {
  const nums = orders.map((o) => `#${o.shopify_order_number}`).join(" y ");
  const ejemplo = orders[0]?.shopify_order_number ?? "1001";
  return (
    `Veo que tienes los pedidos ${nums}. ¿Quieres cancelar ambos o solo uno?\n\n` +
    `— Para cancelar uno: CANCELAR ${ejemplo}\n` +
    `— Para cancelar todos: responde AMBOS`
  );
}

/** La petición de cancelar quedó registrada (no se toca nada automáticamente). */
export const MSG_CANCEL_RECEIVED =
  "Anotado ✅ Dejamos tu pedido marcado para cancelar y te contactamos para confirmarlo. " +
  "Mientras tanto no se te enviará nada.";
