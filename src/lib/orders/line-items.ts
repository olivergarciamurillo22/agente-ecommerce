// ============================================================
// Líneas del pedido con sus identificadores de Shopify (SKU, product_id,
// variant_id), leídas del `raw_payload` que guardamos al recibir el webhook.
//
// `orders.product_summary` es texto para el WhatsApp; para enrutar a un
// proveedor hacen falta los IDs, nunca el título. Si el pedido no tiene
// payload (pedidos antiguos, o SHOPIFY_KEEP_RAW apagado), se devuelve vacío
// y el router lo manda a revisión humana: no se adivina.
// ============================================================

import type { OrderRow } from "../db";
import type { ShopifyLineItem, ShopifyOrderPayload } from "./normalize";

export interface OrderLineItem {
  title: string;
  quantity: number;
  price: string | null;
  sku: string | null;
  productId: string | null;
  variantId: string | null;
  /**
   * Líneas "de servicio" (seguro de envío, etc.): sin SKU, sin producto y sin
   * variante. No cuentan para decidir el proveedor — Dropea las ignora y
   * Dropi no las conoce — pero se conservan para el importe.
   */
  isService: boolean;
}

function idToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function lineItemsFromPayload(payload: ShopifyOrderPayload | null | undefined): OrderLineItem[] {
  const items = (payload?.line_items ?? []) as ShopifyLineItem[];
  return items
    .filter((li) => li && (li.title ?? "").trim())
    .map((li) => {
      const sku = (li.sku ?? "").trim() || null;
      const productId = idToString(li.product_id);
      const variantId = idToString(li.variant_id);
      return {
        title: (li.title ?? "").trim(),
        quantity: Math.max(1, Number(li.quantity ?? 1) || 1),
        price: li.price ?? null,
        sku,
        productId,
        variantId,
        isService: !sku && !productId && !variantId,
      };
    });
}

/** Líneas del pedido desde su raw_payload. Vacío si no hay payload válido. */
export function orderLineItems(order: Pick<OrderRow, "raw_payload">): OrderLineItem[] {
  if (!order.raw_payload) return [];
  try {
    const payload = JSON.parse(order.raw_payload) as ShopifyOrderPayload;
    return lineItemsFromPayload(payload);
  } catch {
    return [];
  }
}
