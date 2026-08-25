// ============================================================
// LÓGICA MULTI-PEDIDO — duplicados y desambiguación por producto.
//
// Nace del caso real del 25-08-2026: un cliente con DOS pedidos idénticos
// (mismo limpiador, mismo importe) dijo cuatro veces, de cuatro formas
// distintas, "solo he pedido uno" — y el bot le repitió cuatro veces el
// mismo selector de números. Este módulo pone nombre a las dos cosas que el
// flujo no sabía hacer: reconocer un duplicado probable y entender "el
// limpiador" como referencia a un pedido.
//
// Todo determinista. La comprensión es flexible (normalización, patrones);
// la EJECUCIÓN nunca adivina: sin coincidencia inequívoca no se selecciona
// nada, y un duplicado JAMÁS se cancela solo — se marca para Pedro.
// ============================================================

import type { OrderRow } from "../db";
import { orderLineItems } from "./line-items";

/** minúsculas, sin tildes, sin signos — la misma normalización del flujo. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Duplicados ---

function windowHours(): number {
  const v = parseInt(process.env.DUPLICATE_ORDER_WINDOW_HOURS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 48;
}

/** Clave de "mismo pedido a efectos prácticos": producto + importe + dirección. */
function duplicateKey(o: OrderRow): string {
  const productos = normalizeText(o.product_summary ?? "");
  const importe = (o.total_price ?? "").trim();
  const direccion = normalizeText(
    [o.address_line1, o.postal_code, o.city].map((x) => x ?? "").join(" ")
  );
  return `${productos}|${importe}|${direccion}`;
}

/**
 * ¿Estos pedidos del MISMO teléfono parecen el mismo pedido repetido?
 *
 * Criterio prudente: mismo producto + mismo importe + misma dirección
 * normalizada + creados dentro de la ventana (DUPLICATE_ORDER_WINDOW_HOURS,
 * 48 h por defecto). Devuelve los grupos de ≥2. El doble clic en el
 * formulario de Releasit produce exactamente esto.
 */
export function findPossibleDuplicates(orders: OrderRow[]): OrderRow[][] {
  const grupos = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const k = duplicateKey(o);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(o);
  }
  const ventana = windowHours() * 3600;
  const out: OrderRow[][] = [];
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    const fechas = g.map((o) => o.created_at);
    if (Math.max(...fechas) - Math.min(...fechas) <= ventana) out.push(g);
  }
  return out;
}

/**
 * ¿El cliente está diciendo que solo hizo UN pedido?
 * Frases del caso real: "yo solo he pedido el limpiador", "si los dos son
 * iguales solo quiero uno", "solo he pedido uno".
 */
export function claimsSingleOrder(text: string): boolean {
  const n = normalizeText(text);
  return (
    /\bsolo (he pedido|pedi|hice|compre|encargue|quiero) un/.test(n) ||
    /\bsolo (he pedido|pedi|hice|compre|encargue|quiero) (el|la|uno)\b/.test(n) ||
    /\blos dos son iguales\b/.test(n) ||
    /\b(esta|estan) duplicad/.test(n) ||
    /\bpedido duplicado\b/.test(n) ||
    /\bme (ha|han) (salido|cobrado|llegado) dos\b/.test(n)
  );
}

// --- Cancelación ---

/**
 * ¿El cliente quiere cancelar? Solo DETECTA la intención: la ejecución exige
 * siempre una confirmación explícita aparte ("CANCELAR 1097").
 */
export function isCancelIntent(text: string): boolean {
  const n = normalizeText(text);
  return (
    /\b(cancelar|cancela|cancelalo|cancelala|anular|anula|anulalo|anulala)\b/.test(n) ||
    /\bno lo quiero\b/.test(n) ||
    /\bno quiero (el pedido|ninguno|ningun pedido|ninguna)\b/.test(n)
  );
}

/**
 * ¿Es la confirmación EXPLÍCITA de cancelar el pedido `orderNumber`?
 * Formato exigido: un verbo de cancelar + el número ("CANCELAR 1097",
 * "anular el 1097"). Sin el número, no.
 */
export function isExplicitCancelConfirmation(text: string, orderNumber: string): boolean {
  const n = normalizeText(text);
  if (!/\b(cancelar|cancela|cancelalo|anular|anula|anulalo)\b/.test(n)) return false;
  return new RegExp(`(?:^|[^0-9])${orderNumber}(?:[^0-9]|$)`).test(n);
}

/** Tras "¿ambos o solo uno?": ¿ha dicho que los dos? */
export function saysBoth(text: string): boolean {
  const n = normalizeText(text);
  return n === "ambos" || n === "los dos" || n === "todos" || /\b(cancelar?|anular?) (ambos|los dos|todos)\b/.test(n);
}

// --- Desambiguación por producto ---

/** Palabras de un pedido con señal (≥4 letras, sin genéricos). */
const PALABRAS_SIN_SEÑAL = new Set([
  "para", "con", "las", "los", "del", "una", "uno", "pack", "unidades", "envio", "seguro",
]);

function productWords(o: OrderRow): Set<string> {
  const items = orderLineItems(o).filter((i) => !i.isService);
  const fuente = items.length
    ? items.map((i) => i.title).join(" ")
    : (o.product_summary ?? "").replace(/^\d+x\s*/gm, "");
  const out = new Set<string>();
  for (const w of normalizeText(fuente).split(" ")) {
    if (w.length >= 4 && !PALABRAS_SIN_SEÑAL.has(w)) out.add(w);
  }
  return out;
}

/**
 * "el limpiador" → ¿a qué pedido se refiere?
 *
 * Solo responde si EXACTAMENTE UN pedido contiene alguna palabra de producto
 * mencionada en el texto. Si los dos venden lo mismo (el caso real: dos
 * limpiadores), la palabra casa con ambos y esto devuelve null — ahí la
 * ambigüedad no la resuelve el producto, la resuelve el flujo de duplicados.
 */
export function matchOrderByProduct(orders: OrderRow[], text: string): OrderRow | null {
  const palabras = new Set(normalizeText(text).split(" ").filter((w) => w.length >= 4));
  if (palabras.size === 0) return null;
  const candidatos = orders.filter((o) => {
    const propias = productWords(o);
    for (const w of palabras) if (propias.has(w)) return true;
    return false;
  });
  return candidatos.length === 1 ? candidatos[0] : null;
}

// --- Presentación ---

/** Línea corta de producto para selectores: "Limpiador Ultrasónico" o "2 artículos". */
export function shortProductLine(o: OrderRow): string {
  const lineas = (o.product_summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lineas.length === 0) return "tu pedido";
  const primera = lineas[0].replace(/^1x\s*/, "");
  const corta = primera.length > 42 ? `${primera.slice(0, 39)}…` : primera;
  return lineas.length > 1 ? `${corta} +${lineas.length - 1} más` : corta;
}
