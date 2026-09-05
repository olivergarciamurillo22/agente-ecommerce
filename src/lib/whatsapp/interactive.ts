// ============================================================
// MENSAJES INTERACTIVOS DE CASAMABLE — botones y listas.
//
// Cada builder devuelve el mensaje para la Cloud API y una representación
// legible para el panel. En la PRIMERA confirmación esa representación NO es
// un fallback enviable: Cloud usa siempre la plantilla aprobada.
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
import { buildApprovedTemplateMessage } from "./templates";
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
  /**
   * Plantilla EQUIVALENTE para cuando el interactivo no pueda salir por
   * ventana de 24 h. La decisión principal es en el ENCOLADO (el scheduler
   * mira la ventana), pero una fila puede caducar ESPERANDO en la cola
   * (retenida por gates, reintentos): en ese caso el loop de entrega
   * degrada a esta plantilla en vez de fallar terminal — y persiste lo que
   * salió de verdad. Solo para mensajes que tengan plantilla aprobada.
   */
  templateFallback?: Extract<OutboundWhatsAppMessage, { kind: "template" }>;
}

/**
 * Primera confirmación: una única ruta, SIEMPRE la plantilla aprobada. La
 * ventana de 24 h no cambia la identidad del mensaje; solo permitiría texto
 * libre, pero usarlo fue la causa del mensaje antiguo en producción.
 */
export function buildConfirmationOutbound(order: OrderRow, _withinSessionWindow = false): InteractiveSpec {
  return {
    message: confirmationTemplate(order),
    // El panel representa fielmente los datos y los botones de la plantilla.
    // No es un texto alternativo para enviar al cliente.
    fallbackText:
      `Casamable · confirmación del pedido #${order.shopify_order_number}\n` +
      `📦 ${shortProductLine(order)}\n` +
      `💶 Contra reembolso: ${money(order)}\n` +
      `[Botones: Confirmar pedido · Cambiar dirección · Dejar una nota]`,
  };
}

/** La plantilla de confirmación con las MISMAS variables que el interactivo
 *  (una sola fuente de datos: el pedido). Resuelve la clave LÓGICA al
 *  nombre REAL de la WABA vía provider_mappings; si el mapping no está
 *  verificado y APPROVED, lanza TemplateNotReadyError (incidente 132001:
 *  jamás se envía un nombre que Meta no conozca). */
function confirmationTemplate(order: OrderRow): Extract<OutboundWhatsAppMessage, { kind: "template" }> {
  return buildApprovedTemplateMessage("order_confirmation_request", {
    nombre: firstName(order) || "cliente",
    numero_pedido: `#${order.shopify_order_number}`,
    producto: shortProductLine(order),
    importe: money(order),
  });
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
