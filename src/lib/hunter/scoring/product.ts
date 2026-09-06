// ============================================================
// AI Winner Radar — PRODUCT SCORE y CASAMABLE SCORE.
//
// PRODUCT SCORE: ¿es un buen producto para vender por vídeo? Sale de features
// que infiere la IA sobre texto PÚBLICO (copy de anuncios, landing). Cada
// feature lleva su confianza, y las de riesgo RESTAN.
//
// CASAMABLE SCORE: ¿nos conviene a NOSOTROS? Es el que más pesa. Combina la
// economía real (motor de la Calculadora COD) con nuestro histórico de
// entregas y rehúses. Un producto que arrasa fuera pero deja 3 € en COD
// español no es una oportunidad nuestra.
// ============================================================

import { clamp01, clampScore } from "../provenance";
import {
  INSUFFICIENT_DATA,
  PRODUCT_FEATURE_LABEL,
  PRODUCT_RISK_FEATURES,
  type OpportunityEconomics,
  type ProductFeature,
  type ProductFeatureKey,
  type ScorePart,
  type ScoreValue,
} from "../types";
import { MIN_VIABLE_MARGIN } from "./weights";

/**
 * Pesos del Product Score. Las de riesgo entran con peso NEGATIVO conceptual
 * (se invierte su valor antes de ponderar), por eso aparecen aquí en positivo.
 */
const FEATURE_WEIGHTS: Record<ProductFeatureKey, number> = {
  problemClarity: 0.18,
  demoability: 0.16,
  impulseBuy: 0.12,
  wowFactor: 0.1,
  evergreen: 0.08,
  differentiationPotential: 0.08,
  fragilityRisk: 0.09,
  returnRisk: 0.09,
  regulatoryRisk: 0.05,
  sizingRisk: 0.03,
  complexity: 0.02,
};

export function scoreProduct(features: ProductFeature[]): ScoreValue {
  const parts: ScorePart[] = [];
  let weighted = 0;
  let usedWeight = 0;
  let totalWeight = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const key of Object.keys(FEATURE_WEIGHTS) as ProductFeatureKey[]) {
    const weight = FEATURE_WEIGHTS[key];
    totalWeight += weight;
    const f = features.find((x) => x.key === key);
    const isRisk = PRODUCT_RISK_FEATURES.includes(key);
    const raw = f?.value ?? null;
    // Un riesgo alto debe BAJAR la nota: se invierte antes de ponderar.
    const contribution = raw === null ? null : isRisk ? 100 - raw : raw;
    parts.push({
      key,
      label: PRODUCT_FEATURE_LABEL[key],
      value: contribution,
      weight,
      observed: f?.rationale ?? null,
    });
    if (contribution !== null) {
      weighted += contribution * weight;
      usedWeight += weight;
      confidenceSum += f?.confidence ?? 0;
      confidenceCount += 1;
    }
  }

  if (usedWeight <= 0) {
    return { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_DATA };
  }
  const coverage = usedWeight / totalWeight;
  const avgFeatureConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
  return {
    score: clampScore(weighted / usedWeight),
    // Doble descuento a propósito: importa cuántas features tenemos Y cuánto
    // se fía la IA de cada una. Muchas features inseguras no son una certeza.
    confidence: clamp01(coverage * 0.5 + avgFeatureConfidence * 0.5),
    parts,
    unavailableReason: null,
  };
}

// ------------------------------------------------------------
// CASAMABLE SCORE
// ------------------------------------------------------------

export interface CasamableFitInput {
  economics: OpportunityEconomics | null;
  /** Nuestro histórico en la categoría. `null` = no tenemos datos aún. */
  historicalDeliveryRate: number | null;
  historicalRefusalRate: number | null;
  historicalCancellationRate: number | null;
  /** ¿El proveedor lo tiene? `null` = no comprobado (≠ no disponible). */
  supplierAvailable: boolean | null;
  supplierLeadTimeDays: number | null;
  /** 0-100 inferido: ¿aguanta el circuito COD? */
  codSuitability: number | null;
  /** 0-100: cuanto MÁS alto, más complicado de enviar (resta). */
  shippingComplexity: number | null;
}

export function scoreCasamable(input: CasamableFitInput): ScoreValue {
  const parts: ScorePart[] = [];
  const e = input.economics;

  const margin = e?.margin.value ?? null;
  parts.push({
    key: "margin",
    label: "Margen esperado",
    // El margen se mapea contra el mínimo viable: el 25 % es el aprobado
    // raspado (50 pts) y el 50 % ya es sobresaliente.
    value: margin === null ? null : clampScore((margin / (MIN_VIABLE_MARGIN * 2)) * 100),
    weight: 0.3,
    observed: margin === null ? null : `${Math.round(margin * 100)} % sobre precio`,
  });

  const profit = e?.expectedProfit.value ?? null;
  parts.push({
    key: "profit",
    label: "Beneficio por pedido",
    // 22 € es el beneficio de referencia del negocio hoy: ese es el 100.
    value: profit === null ? null : clampScore((profit / 22) * 100),
    weight: 0.22,
    observed: profit === null ? null : `${profit.toFixed(2)} €`,
  });

  parts.push({
    key: "delivery",
    label: "Entrega histórica en la categoría",
    value: input.historicalDeliveryRate === null ? null : clampScore(input.historicalDeliveryRate * 100),
    weight: 0.16,
    observed: input.historicalDeliveryRate === null ? null : `${Math.round(input.historicalDeliveryRate * 100)} % entregado`,
  });

  parts.push({
    key: "refusal",
    label: "Rehúses históricos",
    value: input.historicalRefusalRate === null ? null : clampScore((1 - input.historicalRefusalRate) * 100),
    weight: 0.1,
    observed: input.historicalRefusalRate === null ? null : `${Math.round(input.historicalRefusalRate * 100)} % rehusado`,
  });

  parts.push({
    key: "supplier",
    label: "Disponibilidad de proveedor",
    value: input.supplierAvailable === null ? null : input.supplierAvailable ? 100 : 0,
    weight: 0.12,
    observed: input.supplierAvailable === null ? "sin comprobar" : input.supplierAvailable ? "disponible" : "sin stock",
  });

  parts.push({
    key: "codFit",
    label: "Encaje con el circuito COD",
    value: input.codSuitability,
    weight: 0.06,
    observed: null,
  });

  parts.push({
    key: "shipping",
    label: "Sencillez de envío",
    value: input.shippingComplexity === null ? null : clampScore(100 - input.shippingComplexity),
    weight: 0.04,
    observed: null,
  });

  const withData = parts.filter((p) => p.value !== null);
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const usedWeight = withData.reduce((s, p) => s + p.weight, 0);
  if (usedWeight <= 0) {
    return { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_DATA };
  }
  const score = clampScore(withData.reduce((s, p) => s + (p.value as number) * p.weight, 0) / usedWeight);
  // La economía manda: si no hay economía, la confianza se hunde aunque haya
  // otras señales. Decir "encaja con Casamable" sin saber si deja dinero es
  // exactamente el tipo de afirmación que no queremos.
  const economicsConfidence = e ? Math.min(e.expectedProfit.confidence, e.supplierCost.confidence) : 0;
  const coverage = usedWeight / totalWeight;
  return {
    score,
    confidence: clamp01(coverage * 0.4 + economicsConfidence * 0.6),
    parts,
    unavailableReason: null,
  };
}
