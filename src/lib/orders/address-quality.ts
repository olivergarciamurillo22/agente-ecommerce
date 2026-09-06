// Heurística mínima para impedir confirmaciones automáticas con una dirección
// que ni siquiera tiene forma de dirección. No intenta validar que exista.

const MIN_ADDRESS_LENGTH = 6;
const STREET_WORDS = /\b(?:calle|c|avenida|avda|av|plaza|pza|camino|carretera|ctra|urbanizacion|urb|poligono|paseo|ronda|travesia|cuesta|barrio|lugar)\b/i;
const PROPER_NAME = /^\p{Lu}[\p{L}'’-]+\s+\p{Lu}[\p{L}'’-]+$/u;

export type SuspiciousAddressReason = "vacia" | "demasiado_corta" | "sin_numero" | "parece_nombre";

export interface AddressQuality {
  suspicious: boolean;
  reason: SuspiciousAddressReason | null;
}

/**
 * Seis caracteres permiten direcciones cortas reales como "C X 1A". Exigir
 * al menos un dígito cubre el dato de producción que contenía solo un nombre
 * sin convertir esta función en un verificador postal que no podemos sostener.
 */
export function assessOrderAddress(addressLine1: string | null | undefined): AddressQuality {
  const address = (addressLine1 ?? "").trim().replace(/\s+/g, " ");
  if (!address) return { suspicious: true, reason: "vacia" };
  if (address.length < MIN_ADDRESS_LENGTH) return { suspicious: true, reason: "demasiado_corta" };
  if (!/\d/.test(address)) {
    const looksLikeName = PROPER_NAME.test(address) && !STREET_WORDS.test(address);
    return { suspicious: true, reason: looksLikeName ? "parece_nombre" : "sin_numero" };
  }
  return { suspicious: false, reason: null };
}
