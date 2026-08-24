// ============================================================
// Franjas horarias legales de llamada, en Europe/Madrid REAL (via Intl, con
// DST automático — nada de offsets fijos).
//
//   Lunes–sábado: 09:00–13:00 y 17:00–20:00.
//   Nunca: domingo ni festivo (calendario inyectable, ver calendar.ts).
//
// Todo recibe el "ahora" como parámetro: los tests no dependen del reloj.
// ============================================================

import { defaultHolidayCalendar, type HolidayCalendar } from "./calendar";

export const CALL_WINDOWS: Array<{ startH: number; startM: number; endH: number; endM: number }> = [
  { startH: 9, startM: 0, endH: 13, endM: 0 },
  { startH: 17, startM: 0, endH: 20, endM: 0 },
];

export interface MadridParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0=domingo … 6=sábado */
  weekday: number;
  ymd: string;
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Madrid",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hour12: false,
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function madridParts(date: Date): MadridParts {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  return {
    year,
    month,
    day,
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Date (UTC) correspondiente a las hh:mm de Madrid de un día concreto.
 * Dos pasadas sobre el offset real: correcto también los días de cambio
 * horario (el offset se calcula para el instante candidato, no para "hoy").
 */
export function madridDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = madridParts(new Date(guess));
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    const diff = want - got;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

function isCallableDay(p: MadridParts, isHoliday: HolidayCalendar): boolean {
  if (p.weekday === 0) return false; // domingo
  return !isHoliday(p.ymd);
}

/** ¿Este instante cae dentro de una franja legal de llamada? */
export function insideCallWindow(now: Date, isHoliday: HolidayCalendar = defaultHolidayCalendar): boolean {
  const p = madridParts(now);
  if (!isCallableDay(p, isHoliday)) return false;
  const mins = p.hour * 60 + p.minute;
  return CALL_WINDOWS.some(
    (w) => mins >= w.startH * 60 + w.startM && mins < w.endH * 60 + w.endM
  );
}

/**
 * El primer instante ≥ `from` dentro de una franja legal. Si `from` ya está
 * dentro, devuelve `from` tal cual.
 */
export function nextCallSlot(from: Date, isHoliday: HolidayCalendar = defaultHolidayCalendar): Date {
  if (insideCallWindow(from, isHoliday)) return from;

  // Busca día a día (tope 60 días: si no hay hueco en 2 meses, algo está
  // muy mal y preferimos un error ruidoso a un bucle infinito).
  let cursor = from;
  for (let i = 0; i < 60; i++) {
    const p = madridParts(cursor);
    if (isCallableDay(p, isHoliday)) {
      const mins = p.hour * 60 + p.minute;
      for (const w of CALL_WINDOWS) {
        const start = w.startH * 60 + w.startM;
        if (mins < start) return madridDate(p.year, p.month, p.day, w.startH, w.startM);
        if (mins < w.endH * 60 + w.endM) return cursor; // dentro (solo pasa en la primera vuelta)
      }
    }
    // Siguiente día CIVIL a las 00:05 de Madrid. Ojo: sumar 24 h no vale --
    // el día del cambio horario de octubre dura 25 h y quedaría el mismo día
    // (bucle infinito). Se avanza por calendario, no por horas.
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    cursor = madridDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 5);
  }
  throw new Error("nextCallSlot: sin franja legal en 60 días (¿calendario roto?)");
}
