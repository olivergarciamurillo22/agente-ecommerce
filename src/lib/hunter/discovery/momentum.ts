import type { Momentum, MomentumTrace } from "./types";

// ============================================================
// MOMENTUM AUDITABLE (07-09-2026) — docs/HUNTER-DISCOVERY-AUDITORIA.md
//
// Decision de Pedro: el momentum deja de ser una etiqueta y pasa a ser una
// traza. La regla no cambia; lo que cambia es que ahora viaja con sus numeros
// y con la FECHA contra la que se compara, que es justo lo que decide si el
// veredicto vale algo.
// ============================================================

/** Anuncios activos minimos para poder hablar de momentum fuerte. */
export const MOMENTUM_MIN_ACTIVE = 5;
/** Crecimiento minimo respecto a la medida anterior. */
export const MOMENTUM_MIN_DELTA = 2;
/** A partir de aqui, la comparacion es tan vieja que se avisa. */
export const MOMENTUM_STALE_DAYS = 21;

export const MOMENTUM_RULE = `fuerte = al menos ${MOMENTUM_MIN_ACTIVE} anuncios activos Y al menos +${MOMENTUM_MIN_DELTA} respecto a la medida anterior`;

function dias(desde: number | null, hasta: number): number | null {
  if (desde === null) return null;
  return Math.max(0, Math.round(((hasta - desde) / 86400) * 10) / 10);
}

export function computeMomentum(input: {
  activeAds: number;
  previousActiveAds: number | null;
  previousCapturedAt: number | null;
  now: number;
}): MomentumTrace {
  const { activeAds, previousActiveAds, previousCapturedAt, now } = input;
  const delta = previousActiveAds === null ? null : activeAds - previousActiveAds;
  const daysSincePrevious = dias(previousCapturedAt, now);
  const base = { activeAds, previousActiveAds, delta, previousCapturedAt, daysSincePrevious, rule: MOMENTUM_RULE };

  if (activeAds === 0) {
    return { ...base, status: "sin_datos", reason: "ningun anuncio activo ahora mismo: no hay nada que medir" };
  }
  if (previousActiveAds === null) {
    return {
      ...base,
      status: "sin_historico",
      reason: `${activeAds} anuncios activos; es la primera vez que vemos a este anunciante, asi que no hay con que comparar`,
    };
  }
  const cuando =
    daysSincePrevious === null
      ? "en la medida anterior"
      : daysSincePrevious < 1
        ? "respecto a hace unas horas"
        : `en ${daysSincePrevious} dia(s)`;
  const signo = (delta ?? 0) > 0 ? `+${delta}` : String(delta);
  const viejo = daysSincePrevious !== null && daysSincePrevious >= MOMENTUM_STALE_DAYS
    ? ` (ojo: la medida anterior es de hace ${daysSincePrevious} dias, el veredicto envejece)`
    : "";
  const status: Momentum = activeAds >= MOMENTUM_MIN_ACTIVE && (delta ?? 0) >= MOMENTUM_MIN_DELTA ? "fuerte" : "debil";
  return {
    ...base,
    status,
    reason: `${activeAds} anuncios activos, ${signo} ${cuando} (antes ${previousActiveAds})${viejo}`,
  };
}
