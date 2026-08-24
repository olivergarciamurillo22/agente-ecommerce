// ============================================================
// Formateo en español para las variables dinámicas de la llamada.
// Todo determinista y sin dependencias.
// ============================================================

import { madridParts } from "./schedule";

const UNIDADES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
const ESPECIALES: Record<number, string> = {
  10: "diez", 11: "once", 12: "doce", 13: "trece", 14: "catorce", 15: "quince",
  16: "dieciséis", 17: "diecisiete", 18: "dieciocho", 19: "diecinueve",
  20: "veinte", 21: "veintiuno", 22: "veintidós", 23: "veintitrés", 24: "veinticuatro",
  25: "veinticinco", 26: "veintiséis", 27: "veintisiete", 28: "veintiocho", 29: "veintinueve",
};
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** 0–999999 en palabras (cardinal masculino). */
export function numeroACardinal(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  n = Math.floor(n);
  if (n < 10) return UNIDADES[n];
  if (n < 30) return ESPECIALES[n];
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return u === 0 ? DECENAS[d] : `${DECENAS[d]} y ${UNIDADES[u]}`;
  }
  if (n === 100) return "cien";
  if (n < 1000) {
    const c = Math.floor(n / 100);
    const resto = n % 100;
    return resto === 0 ? (c === 1 ? "cien" : CENTENAS[c]) : `${CENTENAS[c]} ${numeroACardinal(resto)}`;
  }
  if (n < 1_000_000) {
    const miles = Math.floor(n / 1000);
    const resto = n % 1000;
    const cabeza = miles === 1 ? "mil" : `${numeroACardinal(miles)} mil`;
    return resto === 0 ? cabeza : `${cabeza} ${numeroACardinal(resto)}`;
  }
  return String(n);
}

/** "29.95 EUR" → "veintinueve euros con noventa y cinco céntimos". */
export function importeEnPalabras(importe: string | number, currency = "EUR"): string {
  const num = typeof importe === "number" ? importe : parseFloat(String(importe).replace(",", "."));
  if (!Number.isFinite(num)) return String(importe);
  const enteros = Math.floor(num);
  const centimos = Math.round((num - enteros) * 100);
  const unidad = currency === "EUR" ? (enteros === 1 ? "euro" : "euros") : currency;
  const cabeza = `${numeroACardinal(enteros)} ${unidad}`;
  if (centimos === 0) return cabeza;
  return `${cabeza} con ${numeroACardinal(centimos)} ${centimos === 1 ? "céntimo" : "céntimos"}`;
}

/** "2x Cortaúñas" → "dos unidades". 1 → "una unidad". */
export function unidadesEnTexto(cantidad: number): string {
  if (cantidad === 1) return "una unidad";
  const palabra = numeroACardinal(cantidad).replace(/^uno$/, "una").replace(/uno$/, "una");
  return `${palabra} unidades`;
}

/** Fecha del pedido RELATIVA al momento real de la llamada (Madrid). */
export function fechaPedidoRelativa(createdAtS: number, now: Date): string {
  const pedido = madridParts(new Date(createdAtS * 1000));
  const hoy = madridParts(now);
  const diasPedido = Date.UTC(pedido.year, pedido.month - 1, pedido.day) / 86400_000;
  const diasHoy = Date.UTC(hoy.year, hoy.month - 1, hoy.day) / 86400_000;
  const diff = Math.round(diasHoy - diasPedido);
  if (diff <= 0) return "hoy";
  if (diff === 1) return "ayer";
  if (diff === 2) return "anteayer";
  return `hace ${numeroACardinal(diff)} días`;
}

/** Momento actual en Madrid, legible para el agente de voz. */
export function currentDatetimeMadrid(now: Date): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}
