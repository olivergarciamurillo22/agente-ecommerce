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

// ============================================================
// CAPA 1 · validación determinista (07-09-2026) — docs/VALIDACION-DIRECCION-IA.md
//
// Sin red, sin coste. Tres comprobaciones:
//  1. Código postal: formato español (5 dígitos, prefijo 01–52).
//  2. Coherencia CP ↔ provincia/ciudad que indicó el cliente.
//  3. Relleno de prueba ("asdasd", "test", "11111", secuencias de teclado…).
//
// FUENTE de la tabla: los dos primeros dígitos del CP español son el código
// de provincia del INE (Instituto Nacional de Estadística, "Relación de
// provincias y sus códigos"; dato público, sin restricción de uso). Es la
// única parte del callejero postal estable y pública: Correos NO publica el
// fichero CP→localidad con licencia abierta, así que la EXISTENCIA exacta de
// un CP concreto queda como "sin_confirmar" — nunca se afirma que un CP
// existe solo porque su prefijo sea válido.
// ============================================================

export const INE_PROVINCE_BY_CP_PREFIX: Readonly<Record<string, string>> = {
  "01": "Álava", "02": "Albacete", "03": "Alicante", "04": "Almería", "05": "Ávila",
  "06": "Badajoz", "07": "Baleares", "08": "Barcelona", "09": "Burgos", "10": "Cáceres",
  "11": "Cádiz", "12": "Castellón", "13": "Ciudad Real", "14": "Córdoba", "15": "A Coruña",
  "16": "Cuenca", "17": "Girona", "18": "Granada", "19": "Guadalajara", "20": "Gipuzkoa",
  "21": "Huelva", "22": "Huesca", "23": "Jaén", "24": "León", "25": "Lleida",
  "26": "La Rioja", "27": "Lugo", "28": "Madrid", "29": "Málaga", "30": "Murcia",
  "31": "Navarra", "32": "Ourense", "33": "Asturias", "34": "Palencia", "35": "Las Palmas",
  "36": "Pontevedra", "37": "Salamanca", "38": "Santa Cruz de Tenerife", "39": "Cantabria", "40": "Segovia",
  "41": "Sevilla", "42": "Soria", "43": "Tarragona", "44": "Teruel", "45": "Toledo",
  "46": "Valencia", "47": "Valladolid", "48": "Bizkaia", "49": "Zamora", "50": "Zaragoza",
  "51": "Ceuta", "52": "Melilla",
};

/** Alias habituales con los que el cliente (o Shopify) escribe la provincia. */
const PROVINCE_ALIASES: Readonly<Record<string, string>> = {
  alava: "01", araba: "01", "araba/alava": "01", albacete: "02", alicante: "03", alacant: "03",
  almeria: "04", avila: "05", badajoz: "06", baleares: "07", "illes balears": "07", "islas baleares": "07", mallorca: "07", ibiza: "07", menorca: "07",
  barcelona: "08", burgos: "09", caceres: "10", cadiz: "11", castellon: "12", castello: "12", "ciudad real": "13", cordoba: "14",
  "a coruna": "15", "la coruna": "15", coruna: "15", cuenca: "16", girona: "17", gerona: "17", granada: "18", guadalajara: "19",
  gipuzkoa: "20", guipuzcoa: "20", huelva: "21", huesca: "22", jaen: "23", leon: "24", lleida: "25", lerida: "25",
  "la rioja": "26", rioja: "26", lugo: "27", madrid: "28", malaga: "29", murcia: "30", "region de murcia": "30", navarra: "31", nafarroa: "31",
  ourense: "32", orense: "32", asturias: "33", "principado de asturias": "33", palencia: "34", "las palmas": "35", "gran canaria": "35",
  pontevedra: "36", salamanca: "37", "santa cruz de tenerife": "38", tenerife: "38", cantabria: "39", segovia: "40", sevilla: "41", soria: "42",
  tarragona: "43", teruel: "44", toledo: "45", valencia: "46", "valencia/valencia": "46", "comunidad valenciana": "46", valladolid: "47",
  bizkaia: "48", vizcaya: "48", zamora: "49", zaragoza: "50", ceuta: "51", melilla: "52",
};

function fold(value: string | null | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9/\s]/g, " ").replace(/\s+/g, " ").trim();
}

export interface PostalCodeCheck {
  /** Código postal tal como llegó (recortado). */
  raw: string;
  formatValid: boolean;
  /** Provincia deducida del prefijo INE, o null si el prefijo no existe. */
  provinceFromCp: string | null;
  /**
   * Coherencia con lo que indicó el cliente:
   *  - "coherente": la provincia/ciudad indicada corresponde al prefijo.
   *  - "incoherente": la provincia/ciudad indicada corresponde a OTRO prefijo.
   *  - "sin_confirmar": no hay provincia/ciudad reconocible con la que comparar.
   */
  coherence: "coherente" | "incoherente" | "sin_confirmar";
  /** Existencia exacta del CP: solo el prefijo es verificable sin el fichero de Correos. */
  existence: "prefijo_valido" | "prefijo_invalido" | "formato_invalido";
}

export function checkSpanishPostalCode(postalCode: string | null | undefined, province?: string | null, city?: string | null): PostalCodeCheck {
  const raw = (postalCode ?? "").trim();
  // "28 001" es un CP valido tecleado con un espacio de mas, no un error del
  // cliente que merezca una alerta (07-09-2026). Se compacta cualquier espacio
  // interior, incluidos los invisibles que llegan por copiar y pegar, antes de
  // validar. El valor original se conserva en `raw` para el informe.
  const compact = raw.replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, "");
  const formatValid = /^\d{5}$/.test(compact);
  const prefix = formatValid ? compact.slice(0, 2) : null;
  const provinceFromCp = prefix ? (INE_PROVINCE_BY_CP_PREFIX[prefix] ?? null) : null;
  const existence: PostalCodeCheck["existence"] = !formatValid ? "formato_invalido" : provinceFromCp ? "prefijo_valido" : "prefijo_invalido";
  let coherence: PostalCodeCheck["coherence"] = "sin_confirmar";
  if (prefix && provinceFromCp) {
    // Provincia explícita primero; si no la hay, la ciudad solo sirve cuando
    // coincide con un nombre de provincia (capitales). Nunca se adivina.
    const stated = [fold(province), fold(city)].filter(Boolean);
    const expectedPrefixes = stated.map((s) => PROVINCE_ALIASES[s] ?? null).filter((p): p is string => p !== null);
    if (expectedPrefixes.length > 0) coherence = expectedPrefixes.includes(prefix) ? "coherente" : "incoherente";
  }
  return { raw, formatValid, provinceFromCp, coherence, existence };
}

const FILLER_TOKENS = new Set(["test", "prueba", "pruebas", "asd", "asdf", "asdasd", "qwe", "qwerty", "xxx", "xxxx", "aaa", "aaaa", "bbb", "ninguna", "ninguno", "none", "null", "na", "n/a", "sin direccion", "no", "lorem", "ipsum"]);

/**
 * Relleno de prueba: texto que nadie escribiría como dirección real. Se mira
 * aparte de la heurística de "forma de dirección" para poder nombrarlo.
 */
export function isFillerAddress(value: string | null | undefined): boolean {
  const n = fold(value);
  if (!n) return true;
  if (FILLER_TOKENS.has(n)) return true;
  const compact = n.replace(/\s+/g, "");
  if (/^(.)\1{3,}$/.test(compact)) return true; // "aaaa", "1111"
  if (/^\d+$/.test(compact)) return true; // solo números
  if (/^(asd|qwe|zxc|jkl|asdf|qwerty|1234|12345|123456|abc)+\w{0,2}$/.test(compact)) return true;
  if (/(asdasd|qweqwe|loremipsum|blablabla|jajaja)/.test(compact)) return true;
  return false;
}

export type AddressVerdict = "correcta" | "dudosa" | "incorrecta";

export interface AddressLayer1Result {
  layer: 1;
  verdict: AddressVerdict;
  problems: string[];
  postalCode: PostalCodeCheck;
  filler: boolean;
  /** Forma mínima de dirección (heurística previa, `assessShippingAddress`). */
  shape: ShippingAddressAssessment;
  /** La dirección evaluada (propuesta si existe; si no, la original). */
  address: string;
}

/**
 * Capa 1: determinista, sin red. "correcta" aquí significa "sin problema
 * evidente": lo semántico lo decide la capa 2 (IA). Cualquier duda se declara.
 */
export function assessOrderAddressLayer1(order: Pick<OrderRow, "proposed_address" | "address_line1" | "address_line2" | "city" | "province" | "postal_code">): AddressLayer1Result {
  const proposed = (order.proposed_address ?? "").trim();
  const address = proposed || [order.address_line1, order.address_line2].filter(Boolean).join(" ");
  const shape = assessShippingAddress(address);
  const filler = isFillerAddress(address);
  const postalCode = checkSpanishPostalCode(order.postal_code, order.province, order.city);
  const problems: string[] = [];
  let verdict: AddressVerdict = "correcta";

  if (filler) { problems.push("direccion_relleno_de_prueba"); verdict = "incorrecta"; }
  else if (shape.status === "SUSPICIOUS") { problems.push(`direccion_sin_forma:${shape.reason}`); verdict = "incorrecta"; }

  if (postalCode.existence === "formato_invalido") { problems.push("cp_formato_invalido"); verdict = "incorrecta"; }
  else if (postalCode.existence === "prefijo_invalido") { problems.push("cp_prefijo_inexistente"); verdict = "incorrecta"; }
  else if (postalCode.coherence === "incoherente") {
    problems.push(`cp_incoherente_con_provincia:${postalCode.raw}->${postalCode.provinceFromCp}`);
    verdict = "incorrecta";
  } else if (postalCode.coherence === "sin_confirmar") {
    // No es un fallo: no hay provincia reconocible con la que comparar. Queda constancia.
    problems.push("cp_coherencia_sin_confirmar");
  }
  problems.push("cp_existencia_exacta_sin_confirmar");

  return { layer: 1, verdict, problems, postalCode, filler, shape, address };
}
