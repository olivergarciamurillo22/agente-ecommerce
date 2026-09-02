// ============================================================
// Variables dinámicas de la llamada + validación previa OBLIGATORIA.
//
// Minimización: se envían EXACTAMENTE estas claves, nunca el payload
// completo del pedido. Si falta un dato obligatorio, NO SE LLAMA: el
// intento pasa a revisión con la lista exacta de lo que falta.
// ============================================================

import type { OrderRow } from "../db";
import { orderLineItems } from "../orders/line-items";
import {
  currentDatetimeMadrid,
  fechaPedidoRelativa,
  importeEnPalabras,
  unidadesEnTexto,
} from "./spanish";

export interface CallPayloadResult {
  ok: boolean;
  /** Campos obligatorios ausentes (vacío si ok). */
  missing: string[];
  variables: RetellCallVariables | null;
  /** E.164 con '+', o null si el teléfono no es utilizable. */
  toNumber: string | null;
}

// ============================================================
// PREFLIGHT DE SEGURIDAD (incidente real 02-09): Lucía dijo
// "¿Hablo con [password 1]?" — un valor con pinta de PLACEHOLDER llegó
// hasta la voz. Ningún valor que parezca plantilla, campo sin resolver o
// residuo de autorrelleno puede viajar a Retell: CALL BLOCKED, motivo
// unsafe_dynamic_variable, revisión humana.
// ============================================================

/**
 * CONTRATO ÚNICO de variables dinámicas (§4 hardening 03-09): las 11 claves
 * EXACTAS que consume el prompt. Única fuente de verdad — el validador del
 * prompt y el doctor la importan de aquí; nadie construye este diccionario
 * a mano en otro sitio.
 */
export const RETELL_CALL_VARIABLE_KEYS = [
  "nombre_cliente",
  "producto",
  "unidades",
  "importe_total",
  "direccion",
  "localidad",
  "codigo_postal",
  "telefono",
  "fecha_pedido",
  "numero_pedido",
  "current_datetime",
] as const;
export type RetellCallVariableKey = (typeof RETELL_CALL_VARIABLE_KEYS)[number];
export type RetellCallVariables = Record<RetellCallVariableKey, string>;

const NOMBRES_DE_CAMPO = new Set<string>(RETELL_CALL_VARIABLE_KEYS);

/** Valores que son "relleno", no datos: si llegan, el DATO está roto. */
const VALORES_PLACEHOLDER = /^(n\/?a|tbd|todo|xxx+|\?+|-+|_+|\.+|pendiente|sin datos|desconocido|unknown|test|prueba|placeholder|sample|ejemplo|lorem ipsum)$/i;

/** ¿Este VALOR tiene pinta de plantilla/placeholder y no de dato real? */
export function unsafeVariableReason(key: string, value: string): string | null {
  if (typeof value !== "string") return `no es texto (${value === null ? "null" : typeof value})`;
  const v = value.trim();
  if (!v) return `está vacío`;
  if (/[\[\]{}<>]/.test(v)) return `contiene símbolos de plantilla ([ ] { } < >)`;
  if (/\$\{|%\{|\{\{|\}\}/.test(v)) return `contiene sintaxis de plantilla`;
  if (/\[object /i.test(v)) return `es un objeto serializado ([object …])`;
  if (VALORES_PLACEHOLDER.test(v)) return `es un valor de relleno ("${v}")`;
  if (/password/i.test(v)) return `contiene "password" (residuo de autorrelleno)`;
  if (/^variable/i.test(v) || /\bvariable\b/i.test(v)) return `contiene "variable"`;
  if (/^(undefined|null|none|nan)$/i.test(v)) return `es "${v}" (campo sin resolver)`;
  if (/no disponible/i.test(v)) return `es un placeholder ("No disponible")`;
  if (NOMBRES_DE_CAMPO.has(v.toLowerCase())) return `es el NOMBRE del campo, no su valor`;
  return null;
}

/**
 * Validación COMPLETA del diccionario antes de llamar: claves exactas (ni
 * más ni menos), sin vacíos, sin placeholders. Devuelve la lista de
 * problemas; vacía = se puede llamar. Es lo que consumen el scheduler, el
 * botón manual, el CLI del piloto y el doctor.
 */
export function validateRetellCallVariables(variables: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const k of RETELL_CALL_VARIABLE_KEYS) {
    if (!(k in variables)) issues.push(`missing_variable:${k}`);
  }
  for (const k of Object.keys(variables)) {
    if (!NOMBRES_DE_CAMPO.has(k)) issues.push(`unexpected_variable:${k}`);
  }
  for (const [k, v] of Object.entries(variables)) {
    const motivo = unsafeVariableReason(k, v as string);
    if (motivo) issues.push(`unsafe_dynamic_variable:${k} (${motivo})`);
  }
  return issues;
}

/** Todas las variables con valor sospechoso (vacío = seguras). */
export function unsafeVariableIssues(variables: Record<string, string>): string[] {
  const issues: string[] = [];
  for (const [k, v] of Object.entries(variables)) {
    const motivo = unsafeVariableReason(k, v);
    if (motivo) issues.push(`unsafe_dynamic_variable:${k} (${motivo})`);
  }
  return issues;
}

/** E.164: el teléfono ya viene normalizado a dígitos internacionales. */
export function toE164(phoneDigits: string): string | null {
  const d = (phoneDigits ?? "").replace(/[^\d]/g, "");
  // 8–15 dígitos (ITU E.164). España: 34 + 9 dígitos = 11.
  if (d.length < 8 || d.length > 15) return null;
  return `+${d}`;
}

export function buildCallPayload(order: OrderRow, now: Date): CallPayloadResult {
  const missing: string[] = [];
  const nombre = (order.customer_name ?? "").trim();
  const producto = (order.product_summary ?? "").trim();
  const importe = (order.total_price ?? "").trim();
  const direccion = (order.address_line1 ?? "").trim();
  const localidad = (order.city ?? "").trim();
  const cp = (order.postal_code ?? "").trim();
  const telefono = toE164(order.phone);
  const esEspana = /^(es|españa|espana|spain)$/i.test((order.country ?? "").trim());

  if (!nombre) missing.push("nombre_cliente");
  // El prompt lee el CP dígito a dígito: sin CP (o con uno imposible) la
  // frase sale rota. En España son 5 dígitos, con cero inicial (Almería: 04…).
  if (!cp) missing.push("codigo_postal");
  else if (esEspana && !/^\d{5}$/.test(cp)) missing.push(`codigo_postal (formato: "${cp}")`);
  if (!producto) missing.push("producto");
  // Un importe 0/negativo no es un pedido COD cobrable: no se llama a un
  // cliente para "recordarle que pague cero euros". Revisión humana.
  if (!importe || !Number.isFinite(parseFloat(importe))) missing.push("importe_total");
  else if (parseFloat(importe) <= 0) missing.push(`importe_total (${importe}: no es cobrable)`);
  if (!direccion) missing.push("direccion");
  if (!localidad || localidad === "-") missing.push("localidad");
  if (!telefono) missing.push("telefono");

  if (missing.length > 0) return { ok: false, missing, variables: null, toNumber: null };

  const items = orderLineItems(order).filter((i) => !i.isService);
  const unidades = items.reduce((acc, i) => acc + i.quantity, 0) || 1;

  const variables: RetellCallVariables = {
    nombre_cliente: nombre,
    producto,
    unidades: unidadesEnTexto(unidades),
    importe_total: importeEnPalabras(importe, order.currency || "EUR"),
    direccion,
    localidad,
    codigo_postal: cp,
    telefono: telefono!,
    fecha_pedido: fechaPedidoRelativa(order.created_at, now),
    numero_pedido: order.shopify_order_number,
    current_datetime: currentDatetimeMadrid(now),
  };

  // PREFLIGHT: un valor con pinta de placeholder BLOQUEA la llamada entera.
  // Nunca se "limpia" el valor y se llama igual: si nombre_cliente es
  // "[password 1]", el problema está en el DATO y lo revisa un humano.
  const sospechosos = validateRetellCallVariables(variables);
  if (sospechosos.length > 0) {
    return { ok: false, missing: sospechosos, variables: null, toNumber: null };
  }

  return { ok: true, missing: [], toNumber: telefono, variables };
}
