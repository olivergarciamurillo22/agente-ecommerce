// ============================================================
// ACTION CENTER — la bandeja de trabajo de Pedro.
//
// Una sola pregunta: "¿qué requiere MI acción ahora mismo?". Cada elemento
// dice qué pasó, qué hacer y desde cuándo — en cristiano, sin jerga. Nada
// de lo que aparece aquí depende de que Pedro "se acuerde de mirar" otra
// pestaña: si requiere acción humana, está aquí; si no está aquí, no
// requiere acción.
//
// SOLO LECTURA sobre la DB + la tabla de resoluciones. Resolver un elemento
// (Pedro pulsó "resuelto" con su nota) NO borra nada: el pedido, sus
// estados y su histórico quedan intactos — solo desaparece de la bandeja.
// ============================================================

import { systemDbHandle, listActionResolutions, type OrderRow } from "../db";

export type ActionType =
  | "CANCEL_REQUEST"
  | "POSSIBLE_DUPLICATE"
  | "NEEDS_CALL"
  | "ADDRESS_CORRECTION"
  | "SUPPLIER_ERROR"
  | "TRACKING_INCIDENT";

/** Orden de urgencia: lo que pierde dinero o molesta clientes, primero. */
const URGENCIA: Record<ActionType, number> = {
  CANCEL_REQUEST: 1, // un cliente esperando que le cancelen ES urgente
  POSSIBLE_DUPLICATE: 2, // enviar dos veces cuesta ~9,37 € + un cliente enfadado
  TRACKING_INCIDENT: 3,
  NEEDS_CALL: 4,
  ADDRESS_CORRECTION: 5,
  SUPPLIER_ERROR: 6,
};

export interface ActionItem {
  type: ActionType;
  orderId: number;
  orderNumber: string;
  /** Nombre de pila + teléfono enmascarado. Nunca datos completos. */
  customer: string;
  /** Qué ha pasado, en una frase. */
  problem: string;
  /** Qué debe hacer Pedro, en imperativo. */
  whatToDo: string;
  /** Epoch: desde cuándo espera. */
  sinceAt: number;
  urgency: number;
}

export interface ActionCenter {
  generatedAt: number;
  items: ActionItem[];
  counts: Record<ActionType, number>;
  total: number;
}

function cliente(o: Pick<OrderRow, "customer_name" | "phone">): string {
  const nombre = (o.customer_name ?? "").trim().split(/\s+/)[0] || "Cliente";
  const tel = o.phone ? `***${o.phone.slice(-4)}` : "sin teléfono";
  return `${nombre} (${tel})`;
}

export function getActionCenter(nowSec = Math.floor(Date.now() / 1000)): ActionCenter {
  const db = systemDbHandle();
  const items: ActionItem[] = [];
  const resueltas = new Set(listActionResolutions().map((r) => `${r.order_id}:${r.action_type}`));
  const noResuelto = (id: number, t: ActionType) => !resueltas.has(`${id}:${t}`);

  const filas = db
    .prepare(
      `SELECT id, shopify_order_number, customer_name, phone, status, total_price, currency,
              possible_duplicate, cancellation_requested_at, needs_call_at, proposed_address,
              supplier_sync_status, supplier_last_error, supplier_status_normalized,
              COALESCE(ordered_at, created_at) AS since_base, updated_at
       FROM orders
       WHERE status NOT IN ('ignored_old')`
    )
    .all() as Array<
    Pick<OrderRow, "id" | "shopify_order_number" | "customer_name" | "phone" | "status" | "total_price" | "currency" | "possible_duplicate" | "cancellation_requested_at" | "needs_call_at" | "proposed_address" | "supplier_sync_status" | "supplier_last_error" | "supplier_status_normalized" | "updated_at"> & { since_base: number }
  >;

  for (const o of filas) {
    const base = { orderId: o.id, orderNumber: o.shopify_order_number, customer: cliente(o) };

    if (o.cancellation_requested_at && noResuelto(o.id, "CANCEL_REQUEST")) {
      items.push({
        ...base,
        type: "CANCEL_REQUEST",
        problem: "El cliente pidió cancelar por WhatsApp y lo confirmó.",
        whatToDo: "Decidir la cancelación: anular en Shopify si procede y avisar al cliente. Después, marcar resuelto.",
        sinceAt: o.cancellation_requested_at,
        urgency: URGENCIA.CANCEL_REQUEST,
      });
    }
    if (o.possible_duplicate === 1 && noResuelto(o.id, "POSSIBLE_DUPLICATE")) {
      items.push({
        ...base,
        type: "POSSIBLE_DUPLICATE",
        problem: `Parece el mismo pedido repetido (mismo producto, importe y dirección; ${o.total_price} ${o.currency}).`,
        whatToDo: "Comparar los dos pedidos, dejar UNO vivo y cancelar el otro en Shopify. Que no salgan los dos.",
        sinceAt: o.since_base,
        urgency: URGENCIA.POSSIBLE_DUPLICATE,
      });
    }
    if (o.status === "needs_call" && !o.cancellation_requested_at && noResuelto(o.id, "NEEDS_CALL")) {
      items.push({
        ...base,
        type: "NEEDS_CALL",
        problem: "No respondió al WhatsApp (o la conversación necesitó un humano).",
        whatToDo: "Llamarle (o dejar que el agente de llamadas lo haga cuando esté encendido) y confirmar o anular.",
        sinceAt: o.needs_call_at ?? o.since_base,
        urgency: URGENCIA.NEEDS_CALL,
      });
    }
    if (o.status === "needs_correction" && o.proposed_address && noResuelto(o.id, "ADDRESS_CORRECTION")) {
      items.push({
        ...base,
        type: "ADDRESS_CORRECTION",
        problem: "El cliente mandó una dirección nueva que espera revisión.",
        whatToDo: "Revisar la dirección propuesta en la ficha del pedido y aplicarla en Shopify si es válida.",
        sinceAt: o.updated_at,
        urgency: URGENCIA.ADDRESS_CORRECTION,
      });
    }
    if (
      ["manual_review", "blocked_address", "failed"].includes(o.supplier_sync_status) &&
      o.status === "confirmed" &&
      noResuelto(o.id, "SUPPLIER_ERROR")
    ) {
      items.push({
        ...base,
        type: "SUPPLIER_ERROR",
        problem: `El pedido está confirmado pero no puede ir al proveedor: ${o.supplier_last_error ?? o.supplier_sync_status}.`,
        whatToDo:
          o.supplier_sync_status === "blocked_address"
            ? "Corregir la localidad/dirección del pedido y volverá a intentarse."
            : "Revisar el motivo (mapping de producto, pedido mixto…) y meterlo a mano si hace falta.",
        sinceAt: o.updated_at,
        urgency: URGENCIA.SUPPLIER_ERROR,
      });
    }
    if (o.supplier_status_normalized === "incident" && noResuelto(o.id, "TRACKING_INCIDENT")) {
      items.push({
        ...base,
        type: "TRACKING_INCIDENT",
        problem: "El proveedor reporta una incidencia en el envío.",
        whatToDo: "Mirar el estado en el panel del proveedor y contactar al cliente si procede. El bot NO le escribe solo en incidencias.",
        sinceAt: o.updated_at,
        urgency: URGENCIA.TRACKING_INCIDENT,
      });
    }
  }

  items.sort((a, b) => a.urgency - b.urgency || a.sinceAt - b.sinceAt);

  const counts = { CANCEL_REQUEST: 0, POSSIBLE_DUPLICATE: 0, NEEDS_CALL: 0, ADDRESS_CORRECTION: 0, SUPPLIER_ERROR: 0, TRACKING_INCIDENT: 0 } as Record<ActionType, number>;
  for (const i of items) counts[i.type]++;
  return { generatedAt: nowSec, items, counts, total: items.length };
}
