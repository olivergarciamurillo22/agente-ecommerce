// ============================================================
// Validación y resolución de la dirección que se enviaría al proveedor.
//
// Motivo real: en los pedidos de Casamable, Releasit manda a menudo
// `shippingAddress.city = "-"` (relleno vacío del formulario). Una dirección
// así no sirve para que un transportista entregue, así que NINGÚN pedido con
// ese problema puede sincronizarse automáticamente: va a revisión humana.
// ============================================================

import type { OrderRow } from "../db";
import type { FinalAddressSource, SupplierAddress } from "./types";

/** Motivos por los que una dirección NO sirve para enviar. */
export type AddressIssue =
  | "missing_address"
  | "invalid_city"
  | "missing_postal_code"
  | "missing_phone";

export interface AddressValidation {
  valid: boolean;
  issues: AddressIssue[];
}

/** Relleno inútil de formulario: "-", ".", "n/a", "sin"… no es un dato. */
function esRelleno(v: string): boolean {
  const t = v.trim();
  if (!t) return true;
  if (/^[-—.·,_/\\\s]+$/.test(t)) return true;
  return /^(n\/?a|na|sin|ninguno|none|null|undefined|x+)$/i.test(t);
}

function limpio(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  return esRelleno(t) ? "" : t;
}

/** Longitud mínima para considerar una localidad utilizable. */
const CITY_MIN_LEN = 3;

/**
 * ¿Se puede enviar a esta dirección? Devuelve TODOS los problemas, no solo
 * el primero, para que Pedro los arregle de una vez.
 */
export function validateSupplierAddress(input: {
  address_line1: string | null;
  city: string | null;
  postal_code: string | null;
  phone?: string | null;
}): AddressValidation {
  const issues: AddressIssue[] = [];

  if (!limpio(input.address_line1)) issues.push("missing_address");

  // El caso que motivó todo esto: city "-", vacía o demasiado corta.
  const city = limpio(input.city);
  if (!city || city.length < CITY_MIN_LEN) issues.push("invalid_city");

  // CP español: 5 dígitos. Aceptamos otros formatos, pero no vacío/relleno.
  const cp = limpio(input.postal_code);
  if (!cp || !/\d{4,}/.test(cp)) issues.push("missing_postal_code");

  if (input.phone !== undefined && !limpio(input.phone)) issues.push("missing_phone");

  return { valid: issues.length === 0, issues };
}

/** Texto legible de un problema, para el panel y los logs. */
export function describeAddressIssue(issue: AddressIssue): string {
  switch (issue) {
    case "missing_address":
      return "falta la calle";
    case "invalid_city":
      return "localidad vacía o inválida (p. ej. \"-\")";
    case "missing_postal_code":
      return "falta el código postal";
    case "missing_phone":
      return "falta el teléfono";
  }
}

export interface ResolvedAddress {
  address: SupplierAddress | null;
  source: FinalAddressSource | null;
  validation: AddressValidation;
  /** Motivo por el que hace falta una decisión humana (si aplica). */
  needsReview: string | null;
}

/**
 * Decide QUÉ dirección se usaría con el proveedor.
 *
 * Reglas (ante la duda, revisión humana — nunca adivinar):
 *  - Sin dirección propuesta          → la original.
 *  - Con propuesta y `final_address_source` decidido → esa.
 *  - Con propuesta y SIN decidir      → revisión humana. La corrección que
 *    escribió el cliente es texto libre: no se manda a un transportista
 *    porque exista, alguien tiene que aprobarla.
 */
export function resolveFinalAddress(order: OrderRow): ResolvedAddress {
  const original: SupplierAddress = {
    line1: limpio(order.address_line1),
    line2: limpio(order.address_line2) || null,
    city: limpio(order.city),
    province: limpio(order.province) || null,
    postalCode: limpio(order.postal_code),
    country: limpio(order.country) || null,
  };

  const tienePropuesta = Boolean(limpio(order.proposed_address));
  const decidido = order.final_address_source as FinalAddressSource | null;

  if (tienePropuesta && decidido !== "original" && decidido !== "proposed") {
    return {
      address: null,
      source: null,
      validation: { valid: false, issues: [] },
      needsReview:
        "el cliente propuso otra dirección y todavía nadie ha decidido cuál usar",
    };
  }

  if (tienePropuesta && decidido === "proposed") {
    // La dirección corregida llega como texto libre en un WhatsApp: no se
    // puede trocear con fiabilidad en calle/CP/localidad. Hasta que exista
    // una edición estructurada, exige revisión humana.
    return {
      address: null,
      source: "proposed",
      validation: { valid: false, issues: [] },
      needsReview:
        "la dirección corregida es texto libre: hay que pasarla a campos estructurados antes de enviarla",
    };
  }

  return {
    address: original,
    source: "original",
    validation: validateSupplierAddress({
      address_line1: order.address_line1,
      city: order.city,
      postal_code: order.postal_code,
      phone: order.phone,
    }),
    needsReview: null,
  };
}
