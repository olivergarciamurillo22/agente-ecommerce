// ============================================================
// Traducción de nuestro DTO al formato de Dropea — ⛔ PENDIENTE.
//
// Aquí vivirá la correspondencia campo a campo cuando sepamos su esquema.
// Mientras tanto solo existe una versión SANITIZADA para poder enseñar en la
// simulación qué datos se enviarían, sin fingir que es su payload real.
// ============================================================

import type { SupplierOrderInput } from "../types";

/**
 * Vista previa de lo que se enviaría, con los datos sensibles recortados.
 * NO es el payload de Dropea: es nuestro DTO en forma legible, para revisar
 * la simulación sin exponer la dirección completa del cliente.
 */
export function previewDropeaPayload(input: SupplierOrderInput): Record<string, unknown> {
  return {
    _aviso: "VISTA PREVIA INTERNA — no es el formato real de Dropea (pendiente del handoff)",
    referencia: input.shopifyOrderId,
    pedido: input.orderNumber,
    cliente: input.customerName,
    telefono: `***${input.phone.slice(-4)}`,
    destino: `${input.finalAddress.postalCode} ${input.finalAddress.city}`,
    articulos: input.items.map((i) => ({ titulo: i.title, cantidad: i.quantity, sku: i.sku })),
    contraReembolso: `${input.codAmount} ${input.currency}`,
    notaReparto: input.deliveryNote,
  };
}
