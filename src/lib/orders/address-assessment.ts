import type { OrderRow } from "../db";

export type ShippingAddressAssessment =
  | { status: "VALID"; reason: null; normalized: string }
  | {
      status: "SUSPICIOUS";
      reason: "empty" | "too_short" | "no_address_signal" | "no_locator";
      normalized: string;
    };

const ROUTE_WORDS = new Set([
  "calle", "c", "avenida", "avda", "av", "camino", "plaza", "paseo",
  "carretera", "ctra", "ronda", "travesia", "urbanizacion", "urb",
  "poligono", "barrio", "lugar", "partida", "rambla", "glorieta",
  "cuesta", "callejon", "via",
]);

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ/\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detector deliberadamente mínimo: no intenta validar una dirección postal.
 * Solo bloquea basura evidente antes de confirmar un COD. Acepta abreviaturas,
 * formatos raros y localizadores habituales (s/n, km, nave, bloque, portal).
 */
export function assessShippingAddress(value: string | null | undefined): ShippingAddressAssessment {
  const normalized = normalizeAddress(value);
  if (!normalized) return { status: "SUSPICIOUS", reason: "empty", normalized };
  if (normalized.length < 6) return { status: "SUSPICIOUS", reason: "too_short", normalized };

  const words = normalized.replace(/[./-]/g, " ").split(/\s+/).filter(Boolean);
  const hasDigit = /\d/.test(normalized);
  const hasRouteWord = words.some((word) => ROUTE_WORDS.has(word));
  const hasSpecialLocator = /\bs\s*\/\s*n\b|\bsn\b/.test(normalized);
  const hasDeliveryLocator = /\b(km|nave|bloque|portal)\b/.test(normalized);

  // Un número en una frase de al menos dos palabras es una señal mínima y
  // prudente ("Mayor 5"). Sin número exigimos una señal direccional real.
  if (!hasRouteWord && !hasDeliveryLocator && !(hasDigit && words.length >= 2)) {
    return { status: "SUSPICIOUS", reason: "no_address_signal", normalized };
  }
  if (!hasDigit && !hasSpecialLocator) {
    return { status: "SUSPICIOUS", reason: "no_locator", normalized };
  }
  return { status: "VALID", reason: null, normalized };
}

/** Dirección que el cliente está confirmando: propuesta si existe; original si no. */
export function assessOrderShippingAddress(order: Pick<OrderRow, "proposed_address" | "address_line1" | "address_line2">): ShippingAddressAssessment {
  const proposed = (order.proposed_address ?? "").trim();
  const value = proposed || [order.address_line1, order.address_line2].filter(Boolean).join(" ");
  return assessShippingAddress(value);
}
