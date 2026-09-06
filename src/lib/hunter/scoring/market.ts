// ============================================================
// AI Winner Radar — MARKET / MOMENTUM / SATURATION / CREATIVE INVESTMENT.
//
// Funciones PURAS: sin entorno, sin red, sin fecha implícita. Todo lo que
// necesitan entra por parámetro, para que un test pueda fijar el escenario
// exacto y el resultado sea el mismo dentro de diez meses.
//
// Norma de honestidad: si falta el dato, el score es `null` con motivo —
// nunca 0. Un 0 se lee como "malísimo" y "no lo sé" no es "malísimo".
// ============================================================

import { clamp01, clampScore } from "../provenance";
import {
  INSUFFICIENT_DATA,
  INSUFFICIENT_HISTORY,
  type ProductSignals,
  type ScorePart,
  type ScoreValue,
} from "../types";
import {
  MARKET_REFERENCE,
  MARKET_WEIGHTS,
  SATURATION_REFERENCE,
  SATURATION_WEIGHTS,
} from "./weights";

/** Rampa lineal saturada: 0 en 0, 100 al llegar a `full`. */
function ramp(value: number | null, full: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (full <= 0) return null;
  return clampScore((Math.min(value, full) / full) * 100);
}

/**
 * Rampa logarítmica: crece deprisa al principio y se aplana. Se usa donde
 * pasar de 1 a 5 importa muchísimo más que pasar de 40 a 45 (anunciantes,
 * creatividades). Con `ramp` lineal, un gigante con 200 anuncios aplastaría
 * a todos los demás en la comparación.
 */
function logRamp(value: number | null, full: number): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (full <= 0) return null;
  return clampScore((Math.log1p(value) / Math.log1p(full)) * 100);
}

function part(key: string, label: string, value: number | null, weight: number, observed: string | null): ScorePart {
  return { key, label, value, weight, observed };
}

/**
 * Combina partes ponderadas IGNORANDO las que no tienen dato y renormalizando
 * los pesos. Así, que falte una señal baja la CONFIANZA pero no hunde el
 * score: no saber si algo es bueno no lo convierte en malo (§69).
 */
function combine(parts: ScorePart[]): { score: number | null; coverage: number } {
  const withData = parts.filter((p) => p.value !== null);
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const usedWeight = withData.reduce((s, p) => s + p.weight, 0);
  if (usedWeight <= 0 || totalWeight <= 0) return { score: null, coverage: 0 };
  const weighted = withData.reduce((s, p) => s + (p.value as number) * p.weight, 0);
  return { score: clampScore(weighted / usedWeight), coverage: usedWeight / totalWeight };
}

// ------------------------------------------------------------
// MARKET SCORE — ¿hay mercado demostrado para esto?
// ------------------------------------------------------------

export function scoreMarket(signals: ProductSignals): ScoreValue {
  const parts: ScorePart[] = [
    part(
      "adLongevity",
      "Antigüedad del anuncio más veterano",
      ramp(signals.oldestActiveAdDays, MARKET_REFERENCE.longevityFullDays),
      MARKET_WEIGHTS.adLongevity,
      signals.oldestActiveAdDays === null ? null : `${signals.oldestActiveAdDays} días activo`
    ),
    part(
      "activeAdDensity",
      "Anuncios activos",
      logRamp(signals.activeAds, MARKET_REFERENCE.activeAdsFull),
      MARKET_WEIGHTS.activeAdDensity,
      `${signals.activeAds} activos`
    ),
    part(
      "advertiserDiversity",
      "Anunciantes distintos",
      logRamp(signals.advertiserCount, MARKET_REFERENCE.advertisersFull),
      MARKET_WEIGHTS.advertiserDiversity,
      `${signals.advertiserCount} anunciantes`
    ),
    part(
      "creativeInvestment",
      "Inversión creativa",
      logRamp(signals.creativesPerAdvertiser, MARKET_REFERENCE.creativesPerAdvertiserFull),
      MARKET_WEIGHTS.creativeInvestment,
      signals.creativesPerAdvertiser === null ? null : `${signals.creativesPerAdvertiser.toFixed(1)} creatividades/anunciante`
    ),
    part(
      "creativeVelocity",
      "Creatividades nuevas (7 d)",
      logRamp(signals.newCreatives7d, 12),
      MARKET_WEIGHTS.creativeVelocity,
      signals.newCreatives7d === null ? null : `${signals.newCreatives7d} nuevas en 7 d`
    ),
    part(
      "advertiserVelocity",
      "Anunciantes nuevos (7 d)",
      logRamp(signals.newAdvertisers7d, 5),
      MARKET_WEIGHTS.advertiserVelocity,
      signals.newAdvertisers7d === null ? null : `${signals.newAdvertisers7d} nuevos en 7 d`
    ),
    part(
      "crossPlatform",
      "Presencia multiplataforma",
      crossPlatformScore(signals),
      MARKET_WEIGHTS.crossPlatform,
      `${signals.platformCount} plataformas · ${signals.countryCount} países`
    ),
  ];

  const { score, coverage } = combine(parts);
  if (score === null) {
    return { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_DATA };
  }
  // La confianza sale de cuánta señal real hubo, no de lo alto que salió.
  const volumeFactor = clamp01((signals.totalAds + signals.advertiserCount * 2) / 20);
  return { score, confidence: clamp01(coverage * 0.7 + volumeFactor * 0.3), parts, unavailableReason: null };
}

function crossPlatformScore(s: ProductSignals): number | null {
  if (s.platformCount <= 0 && s.countryCount <= 0) return null;
  const plat = Math.min(s.platformCount, 3) / 3;
  const geo = Math.min(s.countryCount, 4) / 4;
  return clampScore((plat * 0.6 + geo * 0.4) * 100);
}

// ------------------------------------------------------------
// MOMENTUM — ¿está ACELERANDO? (no: ¿es grande?)
// ------------------------------------------------------------

export interface MomentumInput {
  now: ProductSignals;
  /** Foto de hace ~7 días. `null` = todavía no tenemos histórico. */
  ago7d: ProductSignals | null;
}

/**
 * Crecimiento acotado entre dos medidas.
 *
 * El problema real que resuelve: pasar de 0 a 7 anuncios es una división por
 * cero, y de 1 a 3 es "+200 %" mientras que de 40 a 90 es "+125 %" — cuando
 * el segundo caso es muchísimo más significativo. Por eso:
 *   · un SUELO en el denominador impide que lo pequeño explote,
 *   · log1p comprime, de modo que crecer desde una base grande cuenta,
 *   · y el resultado está acotado a 0..100 pase lo que pase.
 */
/**
 * Crecimiento que se considera "explosivo" y marca el 100: triplicarse en la
 * ventana. Subirlo hace el score más exigente; bajarlo lo satura antes.
 */
export const GROWTH_REFERENCE = 3;

export function boundedGrowth(now: number | null, before: number | null, floor = 3): number | null {
  if (now === null || before === null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  const base = Math.max(before, floor);
  const delta = now - before;
  if (delta <= 0) {
    // Decrecer también informa: 0 es "se está apagando", 50 es "plano".
    const drop = clamp01(Math.abs(delta) / base);
    return clampScore(50 * (1 - drop));
  }
  const ratio = delta / base;
  // La referencia es TRIPLICARSE (+300 %), no duplicarse. Con +100 % como
  // techo, 7→18 y 40→90 daban los dos 100 y el score dejaba de distinguir
  // justo entre los productos calientes, que es donde hace falta. Con esta
  // referencia quedan 84 y 79: siguen siendo altos y ya no empatan.
  const normalized = Math.log1p(ratio) / Math.log1p(GROWTH_REFERENCE);
  return clampScore(50 + normalized * 50);
}

export function scoreMomentum(input: MomentumInput): ScoreValue {
  const { now, ago7d } = input;
  if (!ago7d) {
    // Sin histórico NO se inventa momentum. Es el error más tentador del
    // módulo: con una sola foto cualquier producto parece que "sube".
    return {
      score: null,
      confidence: 0,
      parts: [],
      unavailableReason: INSUFFICIENT_HISTORY,
    };
  }
  const parts: ScorePart[] = [
    part("ads", "Anuncios activos", boundedGrowth(now.activeAds, ago7d.activeAds), 0.4,
      `${ago7d.activeAds} → ${now.activeAds}`),
    part("advertisers", "Anunciantes", boundedGrowth(now.advertiserCount, ago7d.advertiserCount, 2), 0.35,
      `${ago7d.advertiserCount} → ${now.advertiserCount}`),
    part("creatives", "Creatividades", boundedGrowth(now.creativeCount, ago7d.creativeCount), 0.25,
      `${ago7d.creativeCount} → ${now.creativeCount}`),
  ];
  const { score, coverage } = combine(parts);
  if (score === null) return { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_HISTORY };
  return { score, confidence: clamp01(coverage * 0.8), parts, unavailableReason: null };
}

// ------------------------------------------------------------
// SATURATION — 0 = vacío, 100 = lleno. Aquí MÁS es PEOR.
// ------------------------------------------------------------

export function scoreSaturation(signals: ProductSignals): ScoreValue {
  const dup = creativeDuplication(signals);
  const parts: ScorePart[] = [
    part("advertiserCount", "Anunciantes compitiendo",
      logRamp(signals.advertiserCount, SATURATION_REFERENCE.advertisersSaturated),
      SATURATION_WEIGHTS.advertiserCount, `${signals.advertiserCount} anunciantes`),
    part("adCount", "Anuncios totales",
      logRamp(signals.totalAds, SATURATION_REFERENCE.adsSaturated),
      SATURATION_WEIGHTS.adCount, `${signals.totalAds} anuncios`),
    part("countrySpread", "Países cubiertos",
      ramp(signals.countryCount, SATURATION_REFERENCE.countriesSaturated),
      SATURATION_WEIGHTS.countrySpread, `${signals.countryCount} países`),
    part("creativeDuplication", "Creatividades repetidas", dup,
      SATURATION_WEIGHTS.creativeDuplication,
      dup === null ? null : "pocas creatividades por anuncio = se copian entre sí"),
    part("ageDistribution", "Mercado maduro",
      ramp(signals.oldestActiveAdDays, 180),
      SATURATION_WEIGHTS.ageDistribution,
      signals.oldestActiveAdDays === null ? null : `el más veterano lleva ${signals.oldestActiveAdDays} días`),
    part("marketConcentration", "Reparto entre competidores",
      concentrationSaturation(signals.topAdvertiserShare),
      SATURATION_WEIGHTS.marketConcentration,
      signals.topAdvertiserShare === null ? null : `el mayor tiene el ${Math.round(signals.topAdvertiserShare * 100)} %`),
  ];
  const { score, coverage } = combine(parts);
  if (score === null) return { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_DATA };
  return { score, confidence: clamp01(coverage * 0.85), parts, unavailableReason: null };
}

/** Muchos anuncios con pocas creatividades distintas = todos copiando lo mismo. */
function creativeDuplication(s: ProductSignals): number | null {
  if (s.totalAds <= 0 || s.creativeCount <= 0) return null;
  const ratio = s.creativeCount / s.totalAds; // 1 = cada anuncio es distinto
  return clampScore((1 - clamp01(ratio)) * 100);
}

/**
 * Concentración invertida: que un solo anunciante tenga el 90 % significa que
 * el mercado NO está repartido y aún hay hueco. Repartido entre muchos = lleno.
 */
function concentrationSaturation(topShare: number | null): number | null {
  if (topShare === null) return null;
  return clampScore((1 - clamp01(topShare)) * 100);
}

// ------------------------------------------------------------
// CREATIVE INVESTMENT — la señal más difícil de fingir.
// ------------------------------------------------------------

export type CreativeInvestmentLevel = "HIGH" | "MED" | "LOW";

export function scoreCreativeInvestment(signals: ProductSignals): ScoreValue {
  const parts: ScorePart[] = [
    part("creativesPerAdvertiser", "Creatividades por anunciante",
      logRamp(signals.creativesPerAdvertiser, MARKET_REFERENCE.creativesPerAdvertiserFull), 0.45,
      signals.creativesPerAdvertiser === null ? null : signals.creativesPerAdvertiser.toFixed(1)),
    part("newCreatives7d", "Creatividades nuevas (7 d)",
      logRamp(signals.newCreatives7d, 12), 0.3,
      signals.newCreatives7d === null ? null : `${signals.newCreatives7d}`),
    part("activeLongevity", "Constancia en el tiempo",
      ramp(signals.oldestActiveAdDays, MARKET_REFERENCE.longevityFullDays), 0.25,
      signals.oldestActiveAdDays === null ? null : `${signals.oldestActiveAdDays} días`),
  ];
  const { score, coverage } = combine(parts);
  if (score === null) return { score: null, confidence: 0, parts, unavailableReason: INSUFFICIENT_DATA };
  return { score, confidence: clamp01(coverage * 0.75), parts, unavailableReason: null };
}

export function creativeInvestmentLevel(score: number | null): CreativeInvestmentLevel | null {
  if (score === null) return null;
  if (score >= 66) return "HIGH";
  if (score >= 33) return "MED";
  return "LOW";
}
