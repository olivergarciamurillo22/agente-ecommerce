// ============================================================
// Enrutado de pedidos al proveedor que toca (Dropi PRO / Dropea).
//
// FUENTE DE VERDAD: la tabla `supplier_product_mapping`. Un producto va al
// proveedor al que está mapeado (por variant_id, product_id o SKU de
// Shopify). NUNCA se decide por el título del producto.
//
// Regla de negocio (confirmada 22-08-2026):
//   · la línea tiene mapping activo a Dropea      → dropea
//   · no tiene mapping Dropea pero sí a Dropi     → dropi
//   · líneas de los dos proveedores en un pedido  → manual_review (mixed)
//   · alguna línea de producto sin mapping        → manual_review (unmapped)
//   · sin líneas de producto (solo servicios)     → manual_review (no_items)
//
// Las líneas de servicio (seguro de envío: sin SKU ni IDs) no cuentan.
// ============================================================

import { listSupplierProductMappings, type OrderRow, type SupplierProductMapping } from "../db";
import { orderLineItems, type OrderLineItem } from "../orders/line-items";
import type { SupplierPlatform } from "./types";

export type RoutingCode =
  | "mapped"
  | "mixed_supplier"
  | "unmapped_products"
  | "no_product_lines"
  | "no_line_items";

export interface RoutingResult {
  platform: SupplierPlatform;
  /** Por qué se decidió eso (para el panel y los logs). */
  reason: string;
  /** Código estable para tests y métricas. */
  code: RoutingCode;
  /** Qué proveedor tocó a cada línea de producto (null = sin mapping). */
  lines: Array<{ title: string; sku: string | null; platform: SupplierPlatform | null }>;
}

/** Solo proveedores reales cuentan para enrutar (no "manual"/"unknown"). */
const ROUTABLE: SupplierPlatform[] = ["dropi", "dropea"];

/**
 * Busca la correspondencia de una línea. Prioridad: variant_id (más
 * específico) > product_id > SKU. Devuelve la plataforma o null.
 */
export function matchLineToMapping(
  line: OrderLineItem,
  mappings: SupplierProductMapping[]
): SupplierProductMapping | null {
  const activos = mappings.filter((m) => m.active === 1 && ROUTABLE.includes(m.supplier_platform as SupplierPlatform));
  if (line.variantId) {
    const m = activos.find((x) => x.shopify_variant_id && x.shopify_variant_id === line.variantId);
    if (m) return m;
  }
  if (line.productId) {
    const m = activos.find((x) => x.shopify_product_id && x.shopify_product_id === line.productId);
    if (m) return m;
  }
  if (line.sku) {
    const sku = line.sku.toLowerCase();
    const m = activos.find((x) => x.shopify_sku && x.shopify_sku.toLowerCase() === sku);
    if (m) return m;
  }
  return null;
}

/**
 * ¿A qué proveedor va este pedido? Función pura sobre la fila + mappings.
 */
export function resolveSupplierWith(
  order: Pick<OrderRow, "raw_payload">,
  mappings: SupplierProductMapping[]
): RoutingResult {
  const items = orderLineItems(order);
  if (items.length === 0) {
    return {
      platform: "unknown",
      code: "no_line_items",
      reason: "el pedido no tiene líneas legibles (sin raw_payload): decisión humana",
      lines: [],
    };
  }
  const productos = items.filter((i) => !i.isService);
  if (productos.length === 0) {
    return {
      platform: "unknown",
      code: "no_product_lines",
      reason: "el pedido solo tiene líneas de servicio (sin SKU ni producto): decisión humana",
      lines: [],
    };
  }

  const lines = productos.map((l) => {
    const m = matchLineToMapping(l, mappings);
    return { title: l.title, sku: l.sku, platform: (m?.supplier_platform as SupplierPlatform) ?? null };
  });

  const sinMapping = lines.filter((l) => l.platform === null);
  const plataformas = new Set(lines.map((l) => l.platform).filter((p): p is SupplierPlatform => p !== null));

  if (plataformas.size > 1) {
    return {
      platform: "unknown",
      code: "mixed_supplier",
      reason: `el pedido mezcla productos de ${[...plataformas].join(" y ")}: hay que partirlo a mano`,
      lines,
    };
  }
  if (sinMapping.length > 0) {
    const nombres = sinMapping.map((l) => l.sku ?? l.title).join(", ");
    return {
      platform: "unknown",
      code: "unmapped_products",
      reason: `producto(s) sin correspondencia de proveedor: ${nombres}. Añádelos en supplier_product_mapping`,
      lines,
    };
  }
  const platform = [...plataformas][0];
  return {
    platform,
    code: "mapped",
    reason: `todas las líneas están mapeadas a ${platform} (${lines.map((l) => l.sku ?? l.title).join(", ")})`,
    lines,
  };
}

/** Versión con acceso a la base de datos (la que usa el servicio). */
export function resolveSupplier(order: OrderRow): RoutingResult {
  return resolveSupplierWith(order, listSupplierProductMappings());
}
