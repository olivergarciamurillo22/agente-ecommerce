// ============================================================
// POLÍTICA DE TIEMPO — una sola, explícita, para toda la aplicación.
//
//   Persistencia .......... UTC (epoch segundos). SIEMPRE.
//   Presentación .......... Europe/Madrid
//   "hoy" ................. Europe/Madrid
//   Franjas de negocio .... Europe/Madrid
//
// ── POR QUÉ ESTE MÓDULO ────────────────────────────────────────
// Antes cada sitio resolvía el huso a su manera y TODAS dependían en
// silencio del `TZ` del proceso:
//
//   · `date(created_at,'unixepoch','localtime')` en SQLite → usa el TZ del
//     proceso. Hoy es correcto porque el compose pone TZ=Europe/Madrid, pero
//     nada lo garantiza: el host del NAS está en Europe/Brussels, y basta
//     ejecutar un script sin esa variable para que "hoy" sea otro día.
//   · `new Date().setHours(0,0,0,0)` → medianoche del huso del proceso.
//   · `getMonth()/getDate()` → fecha del huso del proceso.
//
// El fallo es silencioso y sesga las métricas justo en la franja que más
// importa: los pedidos de la noche. A las 23:30 UTC en verano ya es el día
// siguiente en Madrid — un pedido de esa hora cuenta en el día equivocado.
//
// Aquí el huso es un DATO EXPLÍCITO, no una variable de entorno con suerte.
// Los helpers usan `Intl` con `timeZone: "Europe/Madrid"`, que resuelve el
// horario de verano de verdad en vez de sumar un offset fijo.
// ============================================================

/** El huso de negocio. Constante: Casamable vende en España. */
export const BUSINESS_TIMEZONE = "Europe/Madrid";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0=domingo … 6=sábado */
  weekday: number;
  /** "YYYY-MM-DD" en el huso de negocio. */
  ymd: string;
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIMEZONE,
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

/** Descompone un instante en sus partes SEGÚN MADRID, sea cual sea el TZ del proceso. */
export function madridParts(date: Date): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Instante (UTC) que corresponde a las hh:mm de Madrid de un día concreto.
 *
 * Converge sobre el offset REAL en vez de sumar uno fijo, así que acierta
 * también los dos domingos del año en que cambia la hora — donde un offset
 * fijo se equivoca en 60 minutos justo en la franja de envío.
 */
export function madridDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date {
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

/** "YYYY-MM-DD" del día de negocio al que pertenece este instante. */
export function businessDay(atMs: number = Date.now()): string {
  return madridParts(new Date(atMs)).ymd;
}

/**
 * Epoch (segundos) de la medianoche de Madrid del día al que pertenece
 * `atMs`. Es el "hoy" de todas las métricas.
 */
export function startOfBusinessDay(atMs: number = Date.now()): number {
  const p = madridParts(new Date(atMs));
  return Math.floor(madridDate(p.year, p.month, p.day, 0, 0).getTime() / 1000);
}

/** Epoch (segundos) del final del día de negocio (medianoche siguiente). */
export function endOfBusinessDay(atMs: number = Date.now()): number {
  return startOfBusinessDay(atMs) + startOfBusinessDayLength(atMs);
}

/**
 * Duración real del día de negocio en segundos. Casi siempre 86400, pero
 * los días de cambio horario son de 23 h o 25 h — y una ventana "hoy"
 * calculada con 86400 fijo se comería o dejaría fuera una hora de pedidos.
 */
function startOfBusinessDayLength(atMs: number): number {
  const inicio = startOfBusinessDay(atMs);
  const siguiente = startOfBusinessDay((inicio + 36 * 3600) * 1000);
  return siguiente - inicio;
}

/**
 * Ventana [desde, hasta) de los últimos `n` días de negocio, alineada a
 * medianoche de Madrid. `hasta` es exclusivo y va al final del día actual.
 */
export function lastBusinessDays(n: number, atMs: number = Date.now()): { from: number; to: number } {
  const inicioHoy = startOfBusinessDay(atMs);
  let cursor = inicioHoy;
  for (let i = 1; i < Math.max(1, n); i++) {
    // Retroceder 12 h desde la medianoche y realinear: cae siempre a mediodía
    // del día anterior, así que baja EXACTAMENTE un día natural — y el margen
    // de 12 h absorbe de sobra el salto de 1 h de los cambios de hora.
    cursor = startOfBusinessDay((cursor - 12 * 3600) * 1000);
  }
  return { from: cursor, to: endOfBusinessDay(atMs) };
}

/** Fecha y hora legibles para el panel, siempre en el huso de negocio. */
export function formatBusinessDateTime(epochSeconds: number): string {
  const p = madridParts(new Date(epochSeconds * 1000));
  const dd = String(p.day).padStart(2, "0");
  const mm = String(p.month).padStart(2, "0");
  const hh = String(p.hour).padStart(2, "0");
  const mi = String(p.minute).padStart(2, "0");
  return `${dd}/${mm}/${p.year} ${hh}:${mi}`;
}

/**
 * ¿Está el PROCESO en el huso de negocio?
 *
 * Importa porque tres consultas de SQLite agrupan con `'localtime'`, y ese
 * modificador resuelve con el huso del proceso — SQLite **no** entiende husos
 * nombrados (`date(...,'Europe/Madrid')` devuelve NULL en 3.53, comprobado).
 * O sea: esas consultas solo son correctas si TZ=Europe/Madrid.
 *
 * El compose lo pone, pero el host del NAS está en Europe/Brussels y basta
 * ejecutar un script sin esa variable para que "hoy" sea otro día. Esto
 * convierte un fallo silencioso —contar pedidos en el día equivocado— en un
 * aviso visible.
 */
export function processTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "(desconocido)";
  } catch {
    return "(desconocido)";
  }
}

export function processTimezoneMatchesBusiness(): boolean {
  const tz = processTimezone();
  if (tz === BUSINESS_TIMEZONE) return true;
  // Bruselas comparte husos y cambios de hora con Madrid: no es correcto de
  // derecho, pero no produce ningún día distinto. Se acepta avisando.
  return tz === "Europe/Brussels" || tz === "Europe/Paris" || tz === "CET";
}

export interface TimezoneCheck {
  ok: boolean;
  processTimezone: string;
  businessTimezone: string;
  message: string;
}

export function checkTimezone(): TimezoneCheck {
  const tz = processTimezone();
  const ok = tz === BUSINESS_TIMEZONE;
  const equivalente = processTimezoneMatchesBusiness();
  return {
    ok,
    processTimezone: tz,
    businessTimezone: BUSINESS_TIMEZONE,
    message: ok
      ? `huso del proceso correcto (${tz})`
      : equivalente
        ? `el proceso está en ${tz}: mismos husos y cambios de hora que ${BUSINESS_TIMEZONE}, no cambia ningún día, pero conviene fijar TZ=${BUSINESS_TIMEZONE}`
        : `⚠️ el proceso está en ${tz}, no en ${BUSINESS_TIMEZONE}: las agrupaciones "por día" de SQLite contarán en el día EQUIVOCADO. Fija TZ=${BUSINESS_TIMEZONE} en el .env`,
  };
}
