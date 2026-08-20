// ============================================================
// Plantillas de los mensajes de confirmación — voz de Pedro / Casamable™.
//
// Texto plano con "1"/"2"/"3": los botones interactivos de Baileys no son
// estables y esto funciona en cualquier WhatsApp. Nada pasa por IA y el tono
// es de atención al cliente normal: nunca mencionar bot/IA/automatización.
// Los productos salen SIEMPRE de los line_items reales del pedido.
// ============================================================

import type { OrderRow } from "../db";
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

/** Mensaje inicial: el guion telefónico de Pedro, adaptado a WhatsApp. */
export function buildConfirmationMessage(order: OrderRow): string {
  const nombre = firstName(order);
  const total = money(order);
  return (
    `Hola${nombre ? ` ${nombre}` : ""}, buenas.\n\n` +
    `Soy Pedro, de atención al cliente de ${shopName()}.\n\n` +
    `Estoy gestionando tu pedido:\n\n` +
    `${itemsBlock(order)}\n` +
    `💰 Total: ${total}\n\n` +
    `La dirección que tenemos es:\n\n` +
    `📍 ${formatAddressForMessage(order)}\n\n` +
    `¿Está todo correcto?\n\n` +
    `Si quieres, también puedes dejar alguna nota para el repartidor.\n\n` +
    `Recuerda tener preparados ${total} en efectivo para pagar al repartidor.\n\n` +
    `Respóndeme:\n\n` +
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

/** Varios pedidos activos del mismo teléfono: pedimos el número de pedido. */
export function buildDisambiguationMessage(orders: OrderRow[]): string {
  const lista = orders
    .slice(0, 5)
    .map((o) => `- Pedido #${o.shopify_order_number} (${money(o)})`)
    .join("\n");
  const ejemplo = orders[0]?.shopify_order_number ?? "1001";
  return (
    `Tienes varios pedidos pendientes de confirmar:\n\n${lista}\n\n` +
    `Dime a cuál te refieres escribiendo el número de pedido y tu respuesta.\n` +
    `Por ejemplo: "${ejemplo} 1" para confirmarlo, "${ejemplo} 2" para cambiar su dirección o "${ejemplo} 3" para dejar una nota al repartidor.`
  );
}
