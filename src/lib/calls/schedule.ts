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
import { madridParts, madridDate, type ZonedParts as MadridParts } from "../time";

export const CALL_WINDOWS: Array<{ startH: number; startM: number; endH: number; endM: number }> = [
  { startH: 9, startM: 0, endH: 13, endM: 0 },
  { startH: 17, startM: 0, endH: 20, endM: 0 },
];

// Las utilidades de huso viven en `src/lib/time.ts` (política única de la
// aplicación). Aquí se reexportan para no romper a quien ya las importaba de
// este módulo, pero la implementación es una sola.
export { madridParts, madridDate } from "../time";
export type { ZonedParts as MadridParts } from "../time";

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

/**
 * El primer día CALLABLE (no domingo, no festivo) ESTRICTAMENTE posterior al
 * día de Madrid que contiene `from` — avanza al menos un día siempre, a
 * diferencia de `nextCallSlot` que puede devolver el mismo día. Solo
 * devuelve la fecha del día: quien llama decide con qué franja combinarlo
 * (ver `windowStart`). Usado por la cadencia de reintentos (E7), que ancla
 * los contactos 3/4/5 a días de calendario, no a un delta de minutos.
 */
export function nextCallableDayAfter(
  from: Date,
  isHoliday: HolidayCalendar = defaultHolidayCalendar
): { year: number; month: number; day: number } {
  const p = madridParts(from);
  let cursor = madridDate(p.year, p.month, p.day, 0, 5);
  for (let i = 0; i < 60; i++) {
    const c = madridParts(cursor);
    const next = new Date(Date.UTC(c.year, c.month - 1, c.day + 1));
    cursor = madridDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 5);
    const q = madridParts(cursor);
    if (isCallableDay(q, isHoliday)) return { year: q.year, month: q.month, day: q.day };
  }
  throw new Error("nextCallableDayAfter: sin día legal en 60 días (¿calendario roto?)");
}

/** Instante de inicio de una franja concreta, en un día de calendario ya decidido. */
export function windowStart(
  day: { year: number; month: number; day: number },
  window: "morning" | "afternoon"
): Date {
  const w = window === "morning" ? CALL_WINDOWS[0] : CALL_WINDOWS[1];
  return madridDate(day.year, day.month, day.day, w.startH, w.startM);
}
