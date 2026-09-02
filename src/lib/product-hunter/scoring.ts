// ============================================================
// Cazador de productos — HELPERS PUROS.
//
// Sin entorno, sin red, sin React: solo funciones deterministas sobre los
// contratos de `types.ts`. Aquí NO se calcula ningún Winner Score (eso es
// del backend); aquí se normalizan datos parciales sin inventar nada y se
// hacen cuentas transparentes con los supuestos que Pedro escribe a mano.
// ============================================================

import {
  COMPARE_MAX,
  COMPARE_MIN,
  PRODUCT_RESEARCH_STATUSES,
  WINNER_SIGNAL_KEYS,
  WINNER_SIGNAL_LABEL,
  type AdLibraryResult,
  type CandidateDecision,
  type CandidateEconomics,
  type CandidateNote,
  type CreativeFormat,
  type DataStatus,
  type ProductResearchStatus,
  type SaturationLevel,
  type ScoreConfidence,
  type WinnerScoreBreakdown,
  type WinnerScoreSignal,
  type WinnerSignalKey,
  type WinningProductCandidate,
} from "./types";

export const UNAVAILABLE_LABEL = "No disponible";
export const SCORE_PENDING_LABEL = "Puntuación pendiente del análisis";

// --- Honestidad de datos: claves que JAMÁS pueden aparecer en un payload ---

/**
 * Raíces de métricas que la Ad Library no expone. Si un backend (o un mock)
 * las cuela, `findForbiddenMetricKeys` las detecta y los tests fallan.
 */
export const FORBIDDEN_METRIC_KEYS: readonly string[] = [
  "sales",
  "sale",
  "roas",
  "spend",
  "spent",
  "profit",
  "profits",
  "revenue",
  "revenues",
  "conversion",
  "conversions",
  "purchase",
  "purchases",
  "sold",
];

/** "estimatedSales" → ["estimated","sales"]; "units_sold" → ["units","sold"]. */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Recorre cualquier valor JSON y devuelve las rutas de claves prohibidas.
 * Compara por TOKEN (no por subcadena): "suspendedAt" no dispara "spend",
 * pero "estimatedSales" o "conversionsCount" sí disparan.
 */
export function findForbiddenMetricKeys(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...findForbiddenMetricKeys(v, `${path}[${i}]`)));
    return found;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const tokens = keyTokens(k);
      if (tokens.some((t) => FORBIDDEN_METRIC_KEYS.includes(t))) found.push(`${path}.${k}`);
      found.push(...findForbiddenMetricKeys(v, `${path}.${k}`));
    }
  }
  return found;
}

// --- Economía: cuentas transparentes sobre supuestos manuales ---

export interface CandidateMarginResult {
  /** precio − coste − transporte, en euros. `null` si falta alguno. */
  grossMargin: number | null;
  /** entrega × margen bruto − (1 − entrega) × coste de devolución. */
  profitPerOrder: number | null;
  /** Explicación en castellano de qué se ha calculado o qué falta. */
  note: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Margen determinista a partir de los supuestos de Pedro. Nunca inventa:
 * si falta un dato, devuelve `null` en lo que dependa de él y lo dice en `note`.
 *
 * @param deliveryRateAssumption Tasa de entrega COD supuesta (0–1). Default 0,7.
 */
export function computeCandidateMargin(
  e: CandidateEconomics,
  deliveryRateAssumption = 0.7
): CandidateMarginResult {
  const missing: string[] = [];
  if (!isFiniteNumber(e.salePriceEstimate)) missing.push("precio de venta");
  if (!isFiniteNumber(e.costEstimate)) missing.push("coste");
  if (!isFiniteNumber(e.shippingCost)) missing.push("transporte");

  if (missing.length > 0) {
    return {
      grossMargin: null,
      profitPerOrder: null,
      note: `Falta ${missing.join(", ")} para calcular el margen.`,
    };
  }

  const price = e.salePriceEstimate as number;
  const cost = e.costEstimate as number;
  const shipping = e.shippingCost as number;
  const grossMargin = round2(price - cost - shipping);

  if (!isFiniteNumber(deliveryRateAssumption) || deliveryRateAssumption <= 0 || deliveryRateAssumption > 1) {
    return {
      grossMargin,
      profitPerOrder: null,
      note: "Margen bruto = precio − coste − transporte. La tasa de entrega debe estar entre 0 y 1 para estimar el beneficio por pedido.",
    };
  }

  if (!isFiniteNumber(e.returnCost)) {
    return {
      grossMargin,
      profitPerOrder: null,
      note: "Margen bruto = precio − coste − transporte. Falta el coste de devolución para estimar el beneficio por pedido.",
    };
  }

  const d = deliveryRateAssumption;
  const profitPerOrder = round2(d * grossMargin - (1 - d) * (e.returnCost as number));
  const pct = Math.round(d * 100);
  return {
    grossMargin,
    profitPerOrder,
    note: `Margen bruto = precio − coste − transporte. Beneficio por pedido = ${pct} % × margen bruto − ${100 - pct} % × coste de devolución (supuesto de entrega editable, no dato real).`,
  };
}

// --- Winner Score: solo presentación, nunca cálculo ---

export interface ScoreLabel {
  text: string;
  pending: boolean;
  confidence: ScoreConfidence | null;
}

/** Texto para el total: número o "Puntuación pendiente del análisis". */
export function scoreLabel(score: WinnerScoreBreakdown | null | undefined): ScoreLabel {
  if (!score || !isFiniteNumber(score.total)) {
    return { text: SCORE_PENDING_LABEL, pending: true, confidence: score?.confidence ?? null };
  }
  return { text: String(Math.round(score.total)), pending: false, confidence: score.confidence };
}

/** Valor de una señal para pintar: "sin dato" cuando es null. */
export function signalValueLabel(value: number | null): string {
  return isFiniteNumber(value) ? String(Math.round(value)) : "sin dato";
}

/** Valor de la señal `key` (0–100) o null si no existe / no se midió. */
export function signalValue(score: WinnerScoreBreakdown | null | undefined, key: WinnerSignalKey): number | null {
  const s = score?.signals.find((x) => x.key === key);
  return s && isFiniteNumber(s.value) ? s.value : null;
}

// --- Comparador ---

export class ProductHunterInputError extends Error {
  readonly code: "BAD_INPUT" | "NOT_FOUND";
  constructor(message: string, code: "BAD_INPUT" | "NOT_FOUND" = "BAD_INPUT") {
    super(message);
    this.name = "ProductHunterInputError";
    this.code = code;
  }
}

/** Entre 2 y 4 ids únicos y no vacíos; lanza `ProductHunterInputError` si no. */
export function assertCompareIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) throw new ProductHunterInputError("Se esperaba una lista de ids para comparar.");
  const clean = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))];
  if (clean.length < COMPARE_MIN) {
    throw new ProductHunterInputError(`Selecciona al menos ${COMPARE_MIN} productos para comparar.`);
  }
  if (clean.length > COMPARE_MAX) {
    throw new ProductHunterInputError(`Como máximo se comparan ${COMPARE_MAX} productos a la vez.`);
  }
  return clean;
}

export type BestDirection = "max" | "min";

/**
 * Índices con el mejor valor de una fila (empates incluidos). Ignora nulls y
 * devuelve [] si hay menos de dos valores medibles — no hay "mejor" con uno.
 */
export function bestIndexes(values: Array<number | null>, direction: BestDirection): number[] {
  const measurable = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => isFiniteNumber(x.v));
  if (measurable.length < 2) return [];
  const best = measurable.reduce((acc, x) => (direction === "max" ? Math.max(acc, x.v) : Math.min(acc, x.v)), measurable[0].v);
  return measurable.filter((x) => x.v === best).map((x) => x.i);
}

// --- Normalización de datos parciales (sin inventar) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asNonNegativeNumber(v: unknown): number | null {
  const n = asNumber(v);
  return n !== null && n >= 0 ? n : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const CREATIVE_FORMATS: readonly CreativeFormat[] = ["video", "image", "carousel"];
const DATA_STATUSES: readonly DataStatus[] = ["complete", "partial", "unknown"];
const CONFIDENCES: readonly ScoreConfidence[] = ["low", "medium", "high"];
const SATURATIONS: readonly SaturationLevel[] = ["low", "medium", "high"];

function normalizeSignal(raw: unknown): WinnerScoreSignal | null {
  if (!isRecord(raw)) return null;
  const key = asEnum(raw.key, WINNER_SIGNAL_KEYS);
  if (!key) return null;
  const value = asNumber(raw.value);
  return {
    key,
    label: asString(raw.label) ?? WINNER_SIGNAL_LABEL[key],
    value,
    weight: asNumber(raw.weight),
    observed: asString(raw.observed),
    missing: typeof raw.missing === "boolean" ? raw.missing : value === null,
  };
}

export function normalizeWinnerScore(raw: unknown): WinnerScoreBreakdown | null {
  if (!isRecord(raw)) return null;
  const signals = Array.isArray(raw.signals)
    ? raw.signals.map(normalizeSignal).filter((s): s is WinnerScoreSignal => s !== null)
    : [];
  return {
    total: asNumber(raw.total),
    confidence: asEnum(raw.confidence, CONFIDENCES),
    analyzedAt: asString(raw.analyzedAt),
    reason: asString(raw.reason),
    signals,
  };
}

/**
 * Convierte cualquier objeto en un `AdLibraryResult` con TODAS las claves
 * presentes (las ausentes → null / []). Solo copia claves conocidas: una
 * métrica prohibida que venga del backend no sobrevive a este paso.
 * Devuelve null si no hay `id`.
 */
export function normalizeAdLibraryResult(raw: unknown): AdLibraryResult | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const price = isRecord(raw.detectedPrice) ? raw.detectedPrice : null;
  const amount = price ? asNumber(price.amount) : null;
  const currency = price ? asString(price.currency) : null;
  return {
    id,
    productName: asString(raw.productName),
    advertiser: asString(raw.advertiser),
    countries: asStringArray(raw.countries).map((c) => c.toUpperCase()),
    format: asEnum(raw.format, CREATIVE_FORMATS),
    cta: asString(raw.cta),
    startedAt: asString(raw.startedAt),
    activeDays: asNonNegativeNumber(raw.activeDays),
    variations: asNonNegativeNumber(raw.variations),
    landingUrl: asString(raw.landingUrl),
    detectedPrice: amount !== null && currency ? { amount, currency } : null,
    previewUrl: asString(raw.previewUrl),
    adCopy: asString(raw.adCopy),
    dataStatus: asEnum(raw.dataStatus, DATA_STATUSES) ?? "unknown",
    winnerScore: normalizeWinnerScore(raw.winnerScore),
  };
}

export function normalizeEconomics(raw: unknown): CandidateEconomics | null {
  if (!isRecord(raw)) return null;
  return {
    costEstimate: asNonNegativeNumber(raw.costEstimate),
    salePriceEstimate: asNonNegativeNumber(raw.salePriceEstimate),
    shippingCost: asNonNegativeNumber(raw.shippingCost),
    returnCost: asNonNegativeNumber(raw.returnCost),
  };
}

function normalizeNotes(raw: unknown): CandidateNote[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidateNote[] = [];
  for (const n of raw) {
    if (!isRecord(n)) continue;
    const at = asString(n.at);
    const text = asString(n.text);
    if (at && text) out.push({ at, text });
  }
  return out;
}

function normalizeDecisions(raw: unknown): CandidateDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidateDecision[] = [];
  for (const d of raw) {
    if (!isRecord(d)) continue;
    const at = asString(d.at);
    const to = asEnum(d.to, PRODUCT_RESEARCH_STATUSES);
    if (!at || !to) continue;
    out.push({ at, from: asEnum(d.from, PRODUCT_RESEARCH_STATUSES), to, note: asString(d.note) });
  }
  return out;
}

/** Igual que `normalizeAdLibraryResult` pero para el candidato completo. */
export function normalizeCandidate(raw: unknown): WinningProductCandidate | null {
  const base = normalizeAdLibraryResult(raw);
  if (!base || !isRecord(raw)) return null;
  return {
    ...base,
    status: asEnum(raw.status, PRODUCT_RESEARCH_STATUSES) ?? "discovered",
    economics: normalizeEconomics(raw.economics),
    notes: normalizeNotes(raw.notes),
    decisions: normalizeDecisions(raw.decisions),
    savedAt: asString(raw.savedAt),
    risks: asStringArray(raw.risks),
    saturation: asEnum(raw.saturation, SATURATIONS),
  };
}

/** Un resultado de búsqueda todavía sin guardar, en forma de candidato. */
export function toCandidateShape(result: AdLibraryResult): WinningProductCandidate {
  return {
    ...result,
    status: "discovered",
    economics: null,
    notes: [],
    decisions: [],
    savedAt: null,
    risks: [],
    saturation: null,
  };
}

/** Proyección estricta a `AdLibraryResult` (descarta lo que sea de candidato). */
export function toAdLibraryResult(c: AdLibraryResult): AdLibraryResult {
  return {
    id: c.id,
    productName: c.productName,
    advertiser: c.advertiser,
    countries: [...c.countries],
    format: c.format,
    cta: c.cta,
    startedAt: c.startedAt,
    activeDays: c.activeDays,
    variations: c.variations,
    landingUrl: c.landingUrl,
    detectedPrice: c.detectedPrice ? { ...c.detectedPrice } : null,
    previewUrl: c.previewUrl,
    adCopy: c.adCopy,
    dataStatus: c.dataStatus,
    winnerScore: c.winnerScore
      ? { ...c.winnerScore, signals: c.winnerScore.signals.map((s) => ({ ...s })) }
      : null,
  };
}

export function isProductResearchStatus(v: unknown): v is ProductResearchStatus {
  return typeof v === "string" && (PRODUCT_RESEARCH_STATUSES as readonly string[]).includes(v);
}

/** Dominio de la landing ("tienda.example") o null si no hay URL válida. */
export function landingDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
