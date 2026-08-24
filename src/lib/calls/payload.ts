// ============================================================
// Variables dinámicas de la llamada + validación previa OBLIGATORIA.
//
// Minimización: se envían EXACTAMENTE estas claves, nunca el payload
// completo del pedido. Si falta un dato obligatorio, NO SE LLAMA: el
// intento pasa a revisión con la lista exacta de lo que falta.
// ============================================================

import type { OrderRow } from "../db";
import { orderLineItems } from "../orders/line-items";
import {
  currentDatetimeMadrid,
  fechaPedidoRelativa,
  importeEnPalabras,
  unidadesEnTexto,
} from "./spanish";

export interface CallPayloadResult {
  ok: boolean;
  /** Campos obligatorios ausentes (vacío si ok). */
  missing: string[];
  variables: Record<string, string> | null;
  /** E.164 con '+', o null si el teléfono no es utilizable. */
  toNumber: string | null;
}

/** E.164: el teléfono ya viene normalizado a dígitos internacionales. */
export function toE164(phoneDigits: string): string | null {
  const d = (phoneDigits ?? "").replace(/[^\d]/g, "");
  // 8–15 dígitos (ITU E.164). España: 34 + 9 dígitos = 11.
  if (d.length < 8 || d.length > 15) return null;
  return `+${d}`;
}

export function buildCallPayload(order: OrderRow, now: Date): CallPayloadResult {
  const missing: string[] = [];
  const nombre = (order.customer_name ?? "").trim();
  const producto = (order.product_summary ?? "").trim();
  const importe = (order.total_price ?? "").trim();
  const direccion = (order.address_line1 ?? "").trim();
  const localidad = (order.city ?? "").trim();
  const telefono = toE164(order.phone);

  if (!nombre) missing.push("nombre_cliente");
  if (!producto) missing.push("producto");
  if (!importe || !Number.isFinite(parseFloat(importe))) missing.push("importe_total");
  if (!direccion) missing.push("direccion");
  if (!localidad || localidad === "-") missing.push("localidad");
  if (!telefono) missing.push("telefono");

  if (missing.length > 0) return { ok: false, missing, variables: null, toNumber: null };

  const items = orderLineItems(order).filter((i) => !i.isService);
  const unidades = items.reduce((acc, i) => acc + i.quantity, 0) || 1;

  return {
    ok: true,
    missing: [],
    toNumber: telefono,
    variables: {
      nombre_cliente: nombre,
      producto,
      unidades: unidadesEnTexto(unidades),
      importe_total: importeEnPalabras(importe, order.currency || "EUR"),
      direccion,
      localidad,
      codigo_postal: (order.postal_code ?? "").trim(),
      telefono: telefono!,
      fecha_pedido: fechaPedidoRelativa(order.created_at, now),
      numero_pedido: order.shopify_order_number,
      current_datetime: currentDatetimeMadrid(now),
    },
  };
}
