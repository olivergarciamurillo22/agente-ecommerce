// ⛔⛔ HECHO CONFIRMADO (videollamada con soporte, 25-08-2026):
// DROPI **NO DISPONE DE API PÚBLICA**. Este fichero es andamiaje construido
// cuando se creía que la documentación llegaría — NO llegará salvo nueva
// evidencia. NO "terminar" esta integración: la vía real de Dropi es su app
// de Shopify (el vínculo se hace con el campo *vendor* del producto, ver
// docs/DROPI-API-CONTRACT.md y CONTEXTO-2026-08-25 §2). Se conserva porque
// el router y los gates lo importan y porque falla cerrado — no porque
// exista un plan de implementarlo.
// ============================================================
// Traducción de nuestro DTO al formato de Dropi PRO — ⛔ PENDIENTE.
//
// Aquí vivirá la correspondencia campo a campo cuando sepamos su esquema.
// Mientras tanto solo existe una versión SANITIZADA para poder enseñar en la
// simulación qué datos se enviarían, sin fingir que es su payload real.
// ============================================================

import type { SupplierOrderInput } from "../types";

/**
 * Vista previa de lo que se enviaría, con los datos sensibles recortados.
 * NO es el payload de Dropi PRO: es nuestro DTO en forma legible, para revisar
 * la simulación sin exponer la dirección completa del cliente.
 */
export function previewDropiPayload(input: SupplierOrderInput): Record<string, unknown> {
  return {
    _aviso: "VISTA PREVIA INTERNA — no es el formato real de Dropi PRO (pendiente del handoff)",
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
