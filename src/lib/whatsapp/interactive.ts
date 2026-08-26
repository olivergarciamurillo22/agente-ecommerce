// ============================================================
// MENSAJES INTERACTIVOS DE CASAMABLE — botones y listas.
//
// Cada builder devuelve DOS cosas: el mensaje interactivo (para la Cloud
// API) y su texto de FALLBACK (lo que enseña el panel, y lo que sale tal
// cual si el proveedor activo es Baileys — el flujo 1/2/3 de siempre).
//
// Límites duros de Meta que condicionan el diseño:
//   · máximo 3 reply buttons, título ≤20 caracteres
//   · listas: ≤10 filas, título ≤24, descripción ≤72
// Por eso "cancelar" NO es un cuarto botón (no cabe): va en el pie del
// mensaje como instrucción de texto, y el parser de texto lo entiende.
// ============================================================

import type { OrderRow } from "../db";
import { BUTTON_PAYLOADS } from "../orders/confirmation";
import { shortProductLine } from "../orders/multi-order";
import { buildTemplateMessage } from "./templates";
import type { OutboundWhatsAppMessage } from "./provider";

/** Exportado: lo reutiliza buildConfirmationOutbound (y cualquier plantilla futura). */
export function money(o: OrderRow): string {
  const n = parseFloat(o.total_price);
  const importe = Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : o.total_price;
  return `${importe} ${o.currency === "EUR" ? "€" : o.currency}`;
}

/** Exportado: lo reutiliza buildConfirmationOutbound (y cualquier plantilla futura). */
export function firstName(o: OrderRow): string {
  return (o.customer_name ?? "").trim().split(/\s+/)[0] || "";
}

export interface InteractiveSpec {
  message: OutboundWhatsAppMessage;
  /** Texto equivalente para Baileys y para el panel de Chats. */
  fallbackText: string;
}

/** Confirmación de pedido con botones (el mensaje inicial del flujo COD). */
export function buildConfirmationInteractive(order: OrderRow): InteractiveSpec {
  const nombre = firstName(order);
  const body =
    `Hola${nombre ? ` ${nombre}` : ""} 👋\n\n` +
    `Tenemos tu pedido de Casamable™:\n\n` +
    `📦 ${shortProductLine(order)}\n` +
    `💰 ${money(order)}\n\n` +
    `¿Está todo correcto?`;
  return {
    message: {
      kind: "interactive_buttons",
      body,
      buttons: [
        { id: BUTTON_PAYLOADS.CONFIRM, title: "✅ Confirmar pedido" },
        { id: BUTTON_PAYLOADS.CHANGE_ADDRESS, title: "📍 Cambiar dirección" },
        { id: BUTTON_PAYLOADS.DELIVERY_NOTE, title: "📝 Dejar nota" },
      ],
      footer: `Para cancelar, escribe CANCELAR ${order.shopify_order_number}`,
    },
    fallbackText:
      `${body}\n\n` +
      `1 — Confirmar\n2 — Cambiar la dirección\n3 — Dejar nota al repartidor`,
  };
}

/**
 * Confirmación inicial, decidiendo INTERACTIVO vs PLANTILLA según la
 * ventana de 24 h (BUG1: fuera de ventana, un interactivo/texto libre no
 * es una opción — Meta lo rechaza siempre con outside_24h_window).
 *
 * Mapeo mensaje → plantilla (pedido en BUG1, punto 2): de momento una sola
 * entrada, porque es la única plantilla aprobada hoy
 * (config/whatsapp-templates.json). El recordatorio, el aviso de
 * seguimiento, etc. se añaden aquí cuando sus plantillas estén aprobadas
 * en Meta — no antes, para no fallar por un nombre que la WABA no conoce.
 */
export function buildConfirmationOutbound(order: OrderRow, withinSessionWindow: boolean): InteractiveSpec {
  if (withinSessionWindow) return buildConfirmationInteractive(order);
  return {
    message: buildTemplateMessage("order_confirmation_request", [
      firstName(order) || "cliente",
      shortProductLine(order),
      money(order),
    ]),
    // Mismo texto que el interactivo: es lo que enseña el panel y lo que
    // sale tal cual si algún día se hace rollback a Baileys con esto en cola.
    fallbackText: buildConfirmationInteractive(order).fallbackText,
  };
}

/** Selector multi-pedido como LISTA (en vez de pedir números por texto). */
export function buildOrderSelectionList(orders: OrderRow[]): InteractiveSpec {
  const filas = orders.slice(0, 10).map((o) => ({
    id: `${BUTTON_PAYLOADS.SELECT_ORDER}${o.shopify_order_number}`,
    // ≤24 caracteres: número + importe. El producto va en la descripción.
    title: `#${o.shopify_order_number} · ${money(o)}`.slice(0, 24),
    description: shortProductLine(o).slice(0, 72),
  }));
  const body =
    `Veo que tienes ${orders.length === 2 ? "dos" : String(orders.length)} pedidos pendientes.\n` +
    `Elige el que quieres gestionar.\n\n` +
    `Si solo hiciste uno, dímelo y lo revisamos.`;
  return {
    message: {
      kind: "interactive_list",
      body,
      buttonLabel: "Ver mis pedidos",
      rows: filas,
    },
    fallbackText:
      body +
      "\n\n" +
      orders.map((o) => `#${o.shopify_order_number} · ${shortProductLine(o)} · ${money(o)}`).join("\n"),
  };
}

/** Menú de acciones tras seleccionar un pedido, con botones. */
export function buildOrderActionsInteractive(order: OrderRow): InteractiveSpec {
  const body =
    `Perfecto, el pedido #${order.shopify_order_number} · ${shortProductLine(order)} · ${money(order)}.\n\n` +
    `¿Qué quieres hacer con él?`;
  return {
    message: {
      kind: "interactive_buttons",
      body,
      buttons: [
        { id: BUTTON_PAYLOADS.CONFIRM, title: "✅ Confirmarlo" },
        { id: BUTTON_PAYLOADS.CHANGE_ADDRESS, title: "📍 Cambiar dirección" },
        { id: BUTTON_PAYLOADS.DELIVERY_NOTE, title: "📝 Dejar nota" },
      ],
      footer: `Para cancelar, escribe CANCELAR ${order.shopify_order_number}`,
    },
    fallbackText:
      `${body}\n1 — Confirmarlo\n2 — Cambiar la dirección\n3 — Dejar una nota al repartidor\n\n` +
      `Si quieres cancelarlo, escribe CANCELAR ${order.shopify_order_number}.`,
  };
}
