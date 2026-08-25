// ============================================================
// VALIDACIÓN DE MAPPINGS — comprobar la FORMA, no llamar a nadie.
//
// Deliberadamente NO consulta la API del proveedor. Validar aquí significa
// "¿tiene sentido esta fila?", no "¿existe este producto en Dropea?". Lo
// segundo exige red, credenciales y un gate, y no puede pasar por accidente
// desde un botón del panel.
//
// Lo que sí detecta son los errores que de verdad ocurren al teclear un
// mapping a mano: pegar el metafield en vez del variant_id, dejar el SKU en
// blanco, o meter un id con espacios.
// ============================================================

export type MappingIssueLevel = "error" | "warning";

export interface MappingIssue {
  field: string;
  level: MappingIssueLevel;
  message: string;
}

export interface MappingCandidate {
  supplier_platform: string;
  shopify_product_id?: string | null;
  shopify_variant_id?: string | null;
  shopify_sku?: string | null;
  shopify_title?: string | null;
  supplier_product_id?: string | null;
  supplier_variant_id?: string | null;
  supplier_unit_price?: number | null;
}

const SOLO_DIGITOS = /^\d+$/;
/** Los metafields de Dropea son hex de 24 caracteres (ObjectId de MongoDB). */
const PARECE_METAFIELD = /^[0-9a-f]{24}$/i;

/**
 * Revisa una fila de mapping. `error` impide guardar; `warning` no, pero se
 * enseña — hay combinaciones raras que a veces son correctas.
 */
export function validateMapping(m: MappingCandidate): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const sku = (m.shopify_sku ?? "").trim();
  const titulo = (m.shopify_title ?? "").trim();
  const variante = (m.supplier_variant_id ?? "").trim();

  if (!m.supplier_platform?.trim()) {
    issues.push({ field: "supplier_platform", level: "error", message: "falta el proveedor" });
  }

  if (!variante) {
    issues.push({
      field: "supplier_variant_id",
      level: "error",
      message: "falta el identificador de variante del proveedor: sin él no se puede enrutar nada",
    });
  } else if (PARECE_METAFIELD.test(variante)) {
    // Error real y documentado: el metafield `dropea.product_id` de Shopify
    // (a3f618c76fb450ce890e7189) NO es el variant_id de Dropea (15896).
    issues.push({
      field: "supplier_variant_id",
      level: "error",
      message:
        "esto parece el metafield `dropea.product_id` de Shopify, que NO es el identificador de variante de Dropea. El de Dropea es un número corto (p. ej. 15896)",
    });
  } else if (!SOLO_DIGITOS.test(variante)) {
    issues.push({
      field: "supplier_variant_id",
      level: "warning",
      message: "el identificador de variante de Dropea suele ser solo números",
    });
  }

  if (!sku && !titulo) {
    issues.push({
      field: "shopify_sku",
      level: "error",
      message: "hace falta al menos el SKU o el título de Shopify para saber a qué producto aplica",
    });
  }
  if (!sku && titulo) {
    issues.push({
      field: "shopify_sku",
      level: "warning",
      message:
        "sin SKU, el emparejado va por título: si alguien renombra el producto en Shopify, este mapping deja de aplicar en silencio",
    });
  }

  for (const [campo, valor] of [
    ["shopify_product_id", m.shopify_product_id],
    ["shopify_variant_id", m.shopify_variant_id],
  ] as const) {
    const v = (valor ?? "").trim();
    if (v && !SOLO_DIGITOS.test(v)) {
      issues.push({ field: campo, level: "warning", message: "los identificadores de Shopify son numéricos" });
    }
  }

  if (m.supplier_unit_price !== null && m.supplier_unit_price !== undefined) {
    if (!Number.isFinite(m.supplier_unit_price) || m.supplier_unit_price < 0) {
      issues.push({ field: "supplier_unit_price", level: "error", message: "el precio no es un número válido" });
    } else if (m.supplier_unit_price === 0) {
      issues.push({ field: "supplier_unit_price", level: "warning", message: "precio 0: ¿es correcto?" });
    }
  }

  return issues;
}

export function mappingIsSavable(issues: MappingIssue[]): boolean {
  return !issues.some((i) => i.level === "error");
}
