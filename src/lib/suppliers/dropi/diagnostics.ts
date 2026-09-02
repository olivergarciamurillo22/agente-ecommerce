// ⛔ DROPI NO DISPONE DE API PÚBLICA (confirmado con su soporte, 25-08-2026).
// NO implementar writes/API sin evidencia nueva. La vía real es su app de
// Shopify (campo *vendor* del producto). Ver docs/DROPI-API-CONTRACT.md.
// ============================================================
// DIAGNÓSTICO DROPI — solo lectura, cero reparación automática.
//
// La causa real de que ningún pedido sincronizara desde el 23-08 fue el
// campo **vendor** del producto en Shopify: decía `Casamable` y la app de
// Dropi exige `Dropi PRO` para reconocer el producto como suyo. Se tardó
// una videollamada con soporte en encontrarlo porque NADA lo enseñaba.
//
// Esto lo enseña. Dos diagnósticos:
//   1. Vendor de productos (contra la Admin API de Shopify, GET, read-only).
//   2. Por qué un pedido llega con sku=null (contra el raw_payload LOCAL).
//
// NUNCA modifica Shopify. Si un vendor está mal, lo dice y lo arregla un
// humano desde el panel de Dropi (opción "Importar productos") — que es
// como se arregló el real.
// ============================================================

import type { OrderRow } from "../../db";

/** Vendor que la app de Dropi exige para reconocer un producto como suyo. */
export function dropiExpectedVendor(): string {
  return (process.env.DROPI_EXPECTED_VENDOR ?? "").trim() || "Dropi PRO";
}

export interface ProductVendorDiagnosis {
  productId: string;
  title: string;
  vendorActual: string;
  vendorEsperado: string;
  vendorOk: boolean;
  /** Variantes sin SKU: la otra pata del problema. */
  variantsSinSku: number;
  variantsTotal: number;
}

/** Forma mínima del producto que devuelve la Admin API (GraphQL o REST). */
export interface ShopifyProductLike {
  id: string | number;
  title?: string | null;
  vendor?: string | null;
  variants?: Array<{ sku?: string | null }> | null;
}

/** Diagnóstico PURO de un producto: sin red, sin DB. */
export function diagnoseProductVendor(p: ShopifyProductLike): ProductVendorDiagnosis {
  const esperado = dropiExpectedVendor();
  const actual = (p.vendor ?? "").trim();
  const variants = p.variants ?? [];
  return {
    productId: String(p.id),
    title: (p.title ?? "").trim() || "(sin título)",
    vendorActual: actual || "(vacío)",
    vendorEsperado: esperado,
    vendorOk: actual === esperado,
    variantsSinSku: variants.filter((v) => !(v.sku ?? "").trim()).length,
    variantsTotal: variants.length,
  };
}

// --- SKU null: cuál de los cuatro casos es ---

export type SkuNullCause =
  /** La línea del payload NI SIQUIERA trae el campo `sku`. */
  | "sku_field_absent"
  /** El campo viene pero vacío: la VARIANTE en Shopify no tiene SKU puesto. */
  | "variant_sku_empty"
  /** El campo trae valor: el problema no está en Shopify — sería nuestro parser. */
  | "sku_present_parser_dropped"
  /** Línea de servicio (Seguro de Envío): no tener SKU es lo esperado. */
  | "service_line_expected"
  /** Sin payload guardado: no se puede diagnosticar. */
  | "no_payload";

export interface SkuLineDiagnosis {
  title: string;
  cause: SkuNullCause;
  detail: string;
}

/**
 * ¿Por qué este pedido tiene líneas sin SKU? Se mira el payload CRUDO, no
 * nuestro parseo — la pregunta es dónde se pierde, y el crudo es el origen.
 *
 * Nota del parser: lineItemsFromPayload hace `(sku ?? "").trim() || null`,
 * así que "" y ausente acaban IGUAL en nuestra tabla — este diagnóstico es
 * la única forma de distinguirlos.
 */
export function diagnoseSkuNull(order: Pick<OrderRow, "raw_payload">): SkuLineDiagnosis[] {
  if (!order.raw_payload) {
    return [{ title: "(pedido sin payload)", cause: "no_payload", detail: "raw_payload vacío o ya reducido por retención" }];
  }
  let payload: { line_items?: Array<Record<string, unknown>> };
  try {
    payload = JSON.parse(order.raw_payload) as typeof payload;
  } catch {
    return [{ title: "(payload ilegible)", cause: "no_payload", detail: "raw_payload no es JSON válido" }];
  }
  const out: SkuLineDiagnosis[] = [];
  for (const li of payload.line_items ?? []) {
    const title = String(li.title ?? "(sin título)");
    const esServicio = !li.product_id && !li.variant_id && !(typeof li.sku === "string" && li.sku.trim());
    if (esServicio) {
      out.push({ title, cause: "service_line_expected", detail: "línea de servicio (sin producto): no lleva SKU y es normal" });
      continue;
    }
    if (!("sku" in li)) {
      out.push({ title, cause: "sku_field_absent", detail: "el payload de Shopify NO trae el campo sku en esta línea" });
    } else if (typeof li.sku !== "string" || !li.sku.trim()) {
      out.push({
        title,
        cause: "variant_sku_empty",
        detail: "el campo sku viene VACÍO: la variante en Shopify no tiene SKU configurado — se arregla en la ficha del producto",
      });
    } else {
      out.push({
        title,
        cause: "sku_present_parser_dropped",
        detail: `el payload SÍ trae sku="${li.sku.trim()}": si en la tabla está a null, el fallo es del parser NUESTRO`,
      });
    }
  }
  return out;
}
