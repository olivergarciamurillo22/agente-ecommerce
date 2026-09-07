// ============================================================
// Identidad del build en ejecución (07-09-2026).
//
// Por qué existe: el 06-09 nadie pudo decir con certeza qué commit corría en
// el NAS. Los docs decían 67f05c7 (02-09), el runbook del 05-09 preparaba
// fdad99e, y ni la imagen ni el health lo exponían. A partir de ahora la
// imagen lleva el SHA con el que se construyó (Dockerfile ARG GIT_SHA →
// ENV CASAMABLE_BUILD_SHA) y /api/health(/live) lo devuelve.
//
// FAIL-CLOSED: si no se pasó el SHA al construir, el valor es literalmente
// "sin_confirmar". Nunca se inventa un commit plausible.
// ============================================================

export const BUILD_SHA_UNKNOWN = "sin_confirmar";

export interface BuildInfo {
  /** SHA de git con el que se construyó la imagen, o "sin_confirmar". */
  sha: string;
  /** true solo si el SHA vino de fuera (build arg); false = desconocido. */
  confirmed: boolean;
}

export function buildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const raw = (env.CASAMABLE_BUILD_SHA ?? "").trim();
  const sha = /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : BUILD_SHA_UNKNOWN;
  return { sha, confirmed: sha !== BUILD_SHA_UNKNOWN };
}
