// ============================================================
// Calendario de festivos para el scheduler de llamadas.
//
// SIN listas hardcodeadas que caduquen: los festivos NACIONALES de España se
// CALCULAN para cualquier año (8 fechas fijas + Viernes Santo, derivado del
// algoritmo de computus para la Pascua). Además se pueden añadir fechas por
// configuración persistida (settings `call_holidays_extra`, csv YYYY-MM-DD)
// sin tocar código — para autonómicos/locales si el negocio lo decide.
//
// Sin red: todo es determinista y testeable con cualquier año.
// ============================================================

import { getSetting } from "../db";

/** Domingo de Pascua (calendario gregoriano) — algoritmo de Butcher. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Festivos nacionales de España (no sustituibles) para un año, YYYY-MM-DD. */
export function spanishNationalHolidays(year: number): string[] {
  const fijos = [
    `${year}-01-01`, // Año Nuevo
    `${year}-01-06`, // Epifanía
    `${year}-05-01`, // Día del Trabajo
    `${year}-08-15`, // Asunción
    `${year}-10-12`, // Fiesta Nacional
    `${year}-11-01`, // Todos los Santos
    `${year}-12-06`, // Constitución
    `${year}-12-08`, // Inmaculada
    `${year}-12-25`, // Navidad
  ];
  const pascua = easterSunday(year);
  // Viernes Santo = Pascua - 2 días.
  const viernesSanto = new Date(Date.UTC(year, pascua.month - 1, pascua.day - 2));
  fijos.push(
    `${viernesSanto.getUTCFullYear()}-${pad(viernesSanto.getUTCMonth() + 1)}-${pad(viernesSanto.getUTCDate())}`
  );
  return fijos.sort();
}

/** Proveedor de calendario inyectable (para tests y overrides). */
export type HolidayCalendar = (dateYmd: string) => boolean;

/** Fechas extra desde configuración persistida (csv YYYY-MM-DD). */
export function extraHolidaysFromSettings(): Set<string> {
  const raw = getSetting("call_holidays_extra") ?? "";
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  );
}

/** Calendario por defecto: nacionales calculados + extras configurados. */
export const defaultHolidayCalendar: HolidayCalendar = (ymd) => {
  const year = parseInt(ymd.slice(0, 4), 10);
  if (!Number.isFinite(year)) return false;
  if (spanishNationalHolidays(year).includes(ymd)) return true;
  return extraHolidaysFromSettings().has(ymd);
};
