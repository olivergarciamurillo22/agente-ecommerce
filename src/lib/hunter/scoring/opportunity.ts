// ============================================================
// AI Winner Radar — OPPORTUNITY SCORE, CONFIANZA y ETIQUETAS.
//
// El score final NO es una media: es una media ponderada CON PENALIZACIONES
// duras. Un producto con un 90 de mercado y un margen del 8 % no es un 70:
// es un no. Promediar convertiría un defecto descalificante en un matiz.
//
// `score` y `confidence` viajan separados y nunca se mezclan. Una oportunidad
// de 88 con 42 % de confianza es información útil y honesta; convertirla en
// "62" para "reflejar la incertidumbre" destruye las dos cosas a la vez.
// ============================================================

import { clamp01, clampScore } from "../provenance";
import {
  INSUFFICIENT_DATA,
  type OpportunityBadge,
  type OpportunityEconomics,
  type ProductFeature,
  type ProductSignals,
  type ScoreKey,
  type ScorePart,
  type ScoreValue,
} from "../types";
import {
  HIGH_RISK_THRESHOLD,
  MIN_VIABLE_MARGIN,
  OPPORTUNITY_SCORE_WEIGHTS,
  PENALTIES,
  VERY_SATURATED_THRESHOLD,
} from "./weights";

export interface OpportunityInput {
  market: ScoreValue;
  product: ScoreValue;
  casamable: ScoreValue;
  saturation: ScoreValue;
  momentum: ScoreValue;
  features: ProductFeature[];
  economics: OpportunityEconomics | null;
  supplierAvailable: boolean | null;
  /** Cuántos proveedores distintos aportaron datos. */
  providerCount: number;
  /** Proveedores que fallaron en esta búsqueda (baja la confianza, no el score). */
  failedProviders: number;
  /** Snapshots disponibles: sin histórico no hay momentum fiable. */
  historyDepth: number;
  /** Antigüedad del dato más viejo usado, en horas. */
  dataAgeHours: number | null;
  clusterConfidence: number;
}

export interface OpportunityResult {
  score: ScoreValue;
  badges: OpportunityBadge[];
  penaltiesApplied: AppliedPenalty[];
}

export interface AppliedPenalty {
  key: string;
  label: string;
  factor: number;
}

export function scoreOpportunity(input: OpportunityInput): OpportunityResult {
  const parts: ScorePart[] = [
    { key: "market", label: "Mercado", value: input.market.score, weight: OPPORTUNITY_SCORE_WEIGHTS.market, observed: null },
    { key: "product", label: "Producto", value: input.product.score, weight: OPPORTUNITY_SCORE_WEIGHTS.product, observed: null },
    { key: "casamable", label: "Casamable", value: input.casamable.score, weight: OPPORTUNITY_SCORE_WEIGHTS.casamable, observed: null },
  ];

  const withData = parts.filter((p) => p.value !== null);
  const usedWeight = withData.reduce((s, p) => s + p.weight, 0);
  if (usedWeight <= 0) {
    return {
      score: { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_DATA },
      badges: ["INSUFFICIENT_DATA"],
      penaltiesApplied: [],
    };
  }

  const base = withData.reduce((s, p) => s + (p.value as number) * p.weight, 0) / usedWeight;
  const penalties = collectPenalties(input);
  // Multiplicativas: dos defectos graves no se compensan entre sí, se agravan.
  const factor = penalties.reduce((f, p) => f * (1 - p.factor), 1);

  return {
    score: {
      score: clampScore(base * factor),
      confidence: computeConfidence(input, usedWeight),
      parts,
      unavailableReason: null,
    },
    badges: computeBadges(input),
    penaltiesApplied: penalties,
  };
}

function collectPenalties(input: OpportunityInput): AppliedPenalty[] {
  const out: AppliedPenalty[] = [];
  const feat = (k: string) => input.features.find((f) => f.key === k)?.value ?? null;

  const regulatory = feat("regulatoryRisk");
  if (regulatory !== null && regulatory >= HIGH_RISK_THRESHOLD) {
    out.push({ key: "regulatoryRisk", label: "Riesgo regulatorio alto", factor: PENALTIES.regulatoryRisk });
  }
  const margin = input.economics?.margin.value ?? null;
  if (margin !== null && margin < MIN_VIABLE_MARGIN) {
    out.push({ key: "marginBelowThreshold", label: `Margen por debajo del ${Math.round(MIN_VIABLE_MARGIN * 100)} %`, factor: PENALTIES.marginBelowThreshold });
  }
  // Solo penaliza el "NO disponible" comprobado. `null` es "no lo hemos
  // mirado": castigar la ignorancia enterraría productos que nadie ha
  // verificado todavía, que son justo los interesantes.
  if (input.supplierAvailable === false) {
    out.push({ key: "supplierUnavailable", label: "Proveedor sin stock", factor: PENALTIES.supplierUnavailable });
  }
  const sat = input.saturation.score;
  if (sat !== null && sat >= VERY_SATURATED_THRESHOLD) {
    out.push({ key: "verySaturated", label: "Saturación muy alta", factor: PENALTIES.verySaturated });
  }
  const fragility = feat("fragilityRisk");
  if (fragility !== null && fragility >= HIGH_RISK_THRESHOLD) {
    out.push({ key: "highFragility", label: "Producto frágil", factor: PENALTIES.highFragility });
  }
  return out;
}

/**
 * La confianza mide CUÁNTO SABEMOS, nunca lo buena que es la oportunidad.
 * Sus cinco ingredientes son deliberados: cobertura de scores, número de
 * fuentes que coinciden, profundidad de histórico, frescura del dato y
 * solidez del cluster (si no estamos seguros de que sea UN producto, nada
 * de lo demás importa).
 */
export function computeConfidence(input: OpportunityInput, usedWeight: number): number {
  const coverage = clamp01(usedWeight); // los pesos suman 1
  const sources = clamp01(input.providerCount / 3);
  const history = clamp01(input.historyDepth / 4);
  const freshness =
    input.dataAgeHours === null ? 0.5 : clamp01(1 - input.dataAgeHours / (24 * 14));
  const cluster = clamp01(input.clusterConfidence);

  const raw =
    coverage * 0.3 + sources * 0.2 + history * 0.15 + freshness * 0.15 + cluster * 0.2;

  // Que una fuente se caiga baja la CONFIANZA, no el score (§69).
  const failurePenalty = input.failedProviders > 0 ? 1 - Math.min(0.3, input.failedProviders * 0.15) : 1;
  return clamp01(raw * failurePenalty);
}

function computeBadges(input: OpportunityInput): OpportunityBadge[] {
  const badges: OpportunityBadge[] = [];
  const sat = input.saturation.score;
  const mom = input.momentum.score;
  const feat = (k: string) => input.features.find((f) => f.key === k)?.value ?? null;

  if (mom !== null && mom >= 70) badges.push("RISING");
  if (sat !== null && sat <= 30 && (mom === null || mom >= 45)) badges.push("EARLY");
  if (sat !== null && sat >= VERY_SATURATED_THRESHOLD) badges.push("SATURATED");
  const evergreen = feat("evergreen");
  if (evergreen !== null && evergreen >= 70) badges.push("EVERGREEN");
  const casamable = input.casamable.score;
  if (casamable !== null && casamable >= 75) badges.push("HIGH_COD_FIT");
  const returnRisk = feat("returnRisk");
  if (returnRisk !== null && returnRisk >= HIGH_RISK_THRESHOLD) badges.push("HIGH_RETURN_RISK");
  if (input.providerCount <= 1 || input.historyDepth === 0) badges.push("INSUFFICIENT_DATA");
  return badges;
}

/** Todas las claves de score, para recorrerlas sin olvidar ninguna. */
export const SCORE_KEYS: readonly ScoreKey[] = [
  "market",
  "momentum",
  "saturation",
  "creative_investment",
  "product",
  "casamable",
  "opportunity",
] as const;

export function emptyScore(reason: string = INSUFFICIENT_DATA): ScoreValue {
  return { score: null, confidence: 0, parts: [], unavailableReason: reason };
}

export function emptyScoreMap(): Record<ScoreKey, ScoreValue> {
  return {
    market: emptyScore(),
    momentum: emptyScore(),
    saturation: emptyScore(),
    creative_investment: emptyScore(),
    product: emptyScore(),
    casamable: emptyScore(),
    opportunity: emptyScore(),
  };
}

/** Reexport para que los consumidores no tengan que conocer la estructura. */
export type { ProductSignals };
