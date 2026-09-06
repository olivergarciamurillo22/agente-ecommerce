// ============================================================
// AI Winner Radar — DE DÓNDE SALE CADA NÚMERO.
//
// La regla que gobierna el módulo entero: un número sin origen es un número
// que no se puede defender. En este negocio una decisión equivocada cuesta
// dinero real (un rehusado ~9,37 €), así que "14 anunciantes" y "beneficio
// esperado 12,10 €" NO son la misma clase de dato y no se pintan igual.
//
//   OBSERVED          lo dice la fuente tal cual (nº de anuncios activos)
//   PROVIDER_ESTIMATE lo ESTIMA un tercero (ventas de un competidor). Jamás
//                     se presenta como hecho: la UI dice "estimado por…".
//   INTERNAL_REAL     dato nuestro, medido en pedidos de Casamable
//   AI_INFERENCE      lo dedujo un modelo a partir de texto público
//   CALCULATED        lo calculamos nosotros con fórmula determinista
//
// `null` significa NO SABEMOS. Nunca 0, nunca un valor plausible inventado.
// ============================================================

export type MetricProvenance =
  | "OBSERVED"
  | "PROVIDER_ESTIMATE"
  | "INTERNAL_REAL"
  | "AI_INFERENCE"
  | "CALCULATED";

export const PROVENANCE_LABEL: Record<MetricProvenance, string> = {
  OBSERVED: "Observado",
  PROVIDER_ESTIMATE: "Estimado por proveedor externo",
  INTERNAL_REAL: "Dato real de Casamable",
  AI_INFERENCE: "Inferido por IA",
  CALCULATED: "Calculado",
};

/** Las que NO son hechos. La UI debe marcarlas visualmente. */
export const NON_FACTUAL_PROVENANCE: readonly MetricProvenance[] = [
  "PROVIDER_ESTIMATE",
  "AI_INFERENCE",
];

export function isFactual(p: MetricProvenance): boolean {
  return !NON_FACTUAL_PROVENANCE.includes(p);
}

/**
 * Un valor con su origen. `value: null` = no disponible, y entonces la
 * confianza es irrelevante (no se puede confiar en lo que no hay).
 */
export interface Measured<T> {
  value: T | null;
  provenance: MetricProvenance;
  /** 0..1. Cuánto nos fiamos de ESTE valor concreto. */
  confidence: number;
  /** De qué proveedor salió, para poder rastrearlo. */
  source: string | null;
  /** Cuándo se observó (epoch s). Un dato de hace un mes no vale igual. */
  observedAt: number | null;
}

export function measured<T>(
  value: T | null,
  provenance: MetricProvenance,
  opts: { confidence?: number; source?: string | null; observedAt?: number | null } = {}
): Measured<T> {
  return {
    value,
    provenance,
    confidence: value === null ? 0 : clamp01(opts.confidence ?? defaultConfidence(provenance)),
    source: opts.source ?? null,
    observedAt: opts.observedAt ?? null,
  };
}

/** Ausencia explícita. Existe para que escribir "no lo sé" sea tan fácil como mentir. */
export function unknownMetric<T>(provenance: MetricProvenance = "OBSERVED", source: string | null = null): Measured<T> {
  return { value: null, provenance, confidence: 0, source, observedAt: null };
}

/**
 * Cuánto se fía uno POR DEFECTO de cada clase de dato. Lo observado no es
 * infalible (una fuente puede ir retrasada) y lo inferido por IA no es
 * basura, pero el orden importa y es deliberado.
 */
function defaultConfidence(p: MetricProvenance): number {
  switch (p) {
    case "INTERNAL_REAL":
      return 0.95;
    case "OBSERVED":
      return 0.85;
    case "CALCULATED":
      return 0.8;
    case "PROVIDER_ESTIMATE":
      return 0.45;
    case "AI_INFERENCE":
      return 0.4;
  }
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}
