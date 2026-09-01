// ============================================================
// Hora de corte de Beeping (documentada):
//   lunes            → 14:00 Madrid
//   martes a viernes → 15:30 Madrid
// Un pedido liberado DESPUÉS del corte sale el siguiente día laborable.
// Sábado y domingo no hay preparación.
//
// Esto es un INDICADOR para Pedro, no una promesa al cliente: ningún
// mensaje automático debe comprometer fechas basándose en esto.
// ============================================================

import { madridParts } from "../time";

export interface BeepingCutoffInfo {
  /** true si liberar AHORA entra en la preparación de hoy. */
  shipsToday: boolean;
  /** Minutos que quedan hasta el corte de hoy (solo si shipsToday). */
  minutesLeft: number | null;
  /** Etiqueta del próximo día de salida ("hoy", "mañana", "el lunes"). */
  nextDispatchLabel: string;
  /** Mensaje ya montado para pintar tal cual en el panel. */
  message: string;
}

/** Corte del día de la semana (1=lunes … 7=domingo), en minutos desde medianoche. */
function cutoffMinutes(weekday: number): number | null {
  if (weekday === 1) return 14 * 60;
  if (weekday >= 2 && weekday <= 5) return 15 * 60 + 30;
  return null; // fin de semana
}

/** Día de la semana 1-7 (lunes=1) en Madrid para un instante dado. */
function madridWeekday(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short" });
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(fmt.format(date));
  return idx + 1;
}

export function beepingCutoff(now: Date = new Date()): BeepingCutoffInfo {
  const parts = madridParts(now);
  const weekday = madridWeekday(now);
  const nowMin = parts.hour * 60 + parts.minute;
  const corte = cutoffMinutes(weekday);

  if (corte !== null && nowMin < corte) {
    const quedan = corte - nowMin;
    return {
      shipsToday: true,
      minutesLeft: quedan,
      nextDispatchLabel: "hoy",
      message:
        quedan <= 60
          ? `Sale hoy · quedan ${quedan} min para el corte`
          : `Sale hoy · corte a las ${Math.floor(corte / 60)}:${String(corte % 60).padStart(2, "0")}`,
    };
  }

  // Fuera de corte: siguiente día laborable con corte.
  let siguiente = weekday;
  let saltos = 0;
  do {
    siguiente = (siguiente % 7) + 1;
    saltos++;
  } while (cutoffMinutes(siguiente) === null && saltos < 7);

  const etiqueta = saltos === 1 ? "mañana" : siguiente === 1 ? "el lunes" : `en ${saltos} días`;
  return {
    shipsToday: false,
    minutesLeft: null,
    nextDispatchLabel: etiqueta,
    message: `Fuera de corte · preparación ${etiqueta}`,
  };
}
