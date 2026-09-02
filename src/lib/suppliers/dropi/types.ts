// ⛔ DROPI NO DISPONE DE API PÚBLICA (confirmado con su soporte, 25-08-2026).
// NO implementar writes/API sin evidencia nueva. La vía real es su app de
// Shopify (campo *vendor* del producto). Ver docs/DROPI-API-CONTRACT.md.
// ============================================================
// Tipos del webhook de actualizaciones de Dropi PRO.
//
// Fuente: panel de Dropi, sección "URL para Notificaciones de actualizaciones
// pedido (POST)". Son los ÚNICOS campos confirmados; no se añade ninguno más.
// Ver docs/DROPI-API-CONTRACT.md
// ============================================================

/** Cuerpo del POST que envía Dropi, tal y como lo describe su panel. */
export interface DropiOrderUpdatePayload {
  order_id: number;
  /** ISO 8601 */
  event_date: string;
  status_id: number;
  status_name: string;
  details: string;
  tracking_code: string;
  tracking_url: string | null;
  shopify_order_id: number | null;
  shipping_company: string;
  /** Importe como cadena (no lo usamos: manda nuestro total). */
  total: string;
}

export type DropiValidationIssue =
  | "order_id_invalido"
  | "event_date_invalida"
  | "status_id_invalido"
  | "status_name_vacio"
  | "tracking_code_invalido"
  | "tracking_url_invalida"
  | "shopify_order_id_invalido"
  | "total_invalido"
  | "cuerpo_no_es_objeto";

export interface DropiValidationResult {
  ok: boolean;
  issues: DropiValidationIssue[];
  payload: DropiOrderUpdatePayload | null;
}

function esEnteroValido(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v);
  // Algunas plataformas mandan los enteros como cadena: se acepta si lo es.
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return true;
  return false;
}

function aEntero(v: unknown): number {
  return typeof v === "number" ? v : parseInt(String(v).trim(), 10);
}

/**
 * Valida el cuerpo del webhook contra la estructura confirmada.
 * Estricta a propósito: un payload que no encaje se rechaza con 400 y no
 * produce ningún efecto, en vez de procesarse "a medias".
 */
export function validateDropiPayload(raw: unknown): DropiValidationResult {
  const issues: DropiValidationIssue[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["cuerpo_no_es_objeto"], payload: null };
  }
  const p = raw as Record<string, unknown>;

  if (!esEnteroValido(p.order_id) || aEntero(p.order_id) <= 0) issues.push("order_id_invalido");

  // event_date: debe ser una fecha ISO interpretable.
  const fecha = typeof p.event_date === "string" ? Date.parse(p.event_date) : NaN;
  if (!Number.isFinite(fecha)) issues.push("event_date_invalida");

  if (!esEnteroValido(p.status_id)) issues.push("status_id_invalido");

  if (typeof p.status_name !== "string" || !p.status_name.trim()) issues.push("status_name_vacio");

  // tracking_code puede venir vacío (aún sin guía), pero debe ser cadena.
  if (p.tracking_code !== undefined && p.tracking_code !== null && typeof p.tracking_code !== "string") {
    issues.push("tracking_code_invalido");
  }

  if (p.tracking_url !== undefined && p.tracking_url !== null && typeof p.tracking_url !== "string") {
    issues.push("tracking_url_invalida");
  }

  if (
    p.shopify_order_id !== undefined &&
    p.shopify_order_id !== null &&
    !esEnteroValido(p.shopify_order_id)
  ) {
    issues.push("shopify_order_id_invalido");
  }

  // total: cadena decimal ("34.98" o "34,98"). No se usa para nada crítico,
  // pero si viene, debe ser un número.
  if (p.total !== undefined && p.total !== null) {
    const t = String(p.total).replace(",", ".").trim();
    if (!t || !Number.isFinite(Number(t))) issues.push("total_invalido");
  }

  if (issues.length > 0) return { ok: false, issues, payload: null };

  return {
    ok: true,
    issues: [],
    payload: {
      order_id: aEntero(p.order_id),
      event_date: String(p.event_date),
      status_id: aEntero(p.status_id),
      status_name: String(p.status_name).trim(),
      details: typeof p.details === "string" ? p.details : "",
      tracking_code: typeof p.tracking_code === "string" ? p.tracking_code.trim() : "",
      tracking_url:
        typeof p.tracking_url === "string" && p.tracking_url.trim() ? p.tracking_url.trim() : null,
      shopify_order_id:
        p.shopify_order_id === undefined || p.shopify_order_id === null
          ? null
          : aEntero(p.shopify_order_id),
      shipping_company: typeof p.shipping_company === "string" ? p.shipping_company.trim() : "",
      total: p.total === undefined || p.total === null ? "" : String(p.total),
    },
  };
}
