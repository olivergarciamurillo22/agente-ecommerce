// ============================================================
// AI Winner Radar — CONTRATOS.
//
// LA ENTIDAD PRINCIPAL ES `ProductOpportunity`, NO un anuncio. Un producto
// ganador se manifiesta como 50 anuncios de 8 marcas en 12 tiendas: mirar
// anuncios sueltos es mirar el humo en vez del fuego. Los anuncios existen
// aquí solo como EVIDENCIA de un producto.
//
// Complementa —no sustituye— a `src/lib/product-hunter/`, que sigue siendo
// el pipeline de decisión de Pedro (descubierto → … → ganador). El Radar es
// la capa que ENCUENTRA y PUNTÚA; aquel es donde Pedro DECIDE.
// ============================================================

import type { Measured, MetricProvenance } from "./provenance";

// --- Fuentes ---

import type { StageKey, StageState } from "./stages";
export type { StageKey, StageState } from "./stages";

export type ProviderId =
  | "winninghunter"
  | "meta_ad_library"
  | "tiktok_research"
  | "casamable_internal"
  | "supplier"
  | "fixture";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  winninghunter: "WinningHunter",
  meta_ad_library: "Meta Ad Library",
  tiktok_research: "TikTok Research",
  casamable_internal: "Datos de Casamable",
  supplier: "Proveedores",
  fixture: "Datos de ejemplo",
};

export type ProviderCapability =
  | "META_ADS"
  | "TIKTOK_ADS"
  | "TIKTOK_SHOP"
  | "SHOPIFY_STORES"
  | "TRENDS"
  | "LANDERS"
  | "BRANDS"
  | "SIMILAR_AD_SEARCH"
  | "INTERNAL_METRICS"
  | "SUPPLIER_COST";

export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  "META_ADS",
  "TIKTOK_ADS",
  "TIKTOK_SHOP",
  "SHOPIFY_STORES",
  "TRENDS",
  "LANDERS",
  "BRANDS",
  "SIMILAR_AD_SEARCH",
  "INTERNAL_METRICS",
  "SUPPLIER_COST",
] as const;

/**
 * UNVERIFIED es un estado de primera clase, no un "casi disponible": significa
 * que la capacidad aparece en la documentación pero NADIE la ha ejecutado
 * contra la API real desde este repo. Prometer datos que no se han visto
 * llegar es exactamente el error que este módulo quiere evitar.
 */
export type CapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "UNVERIFIED";

export type ProviderStatus =
  | "CONNECTED"
  | "NOT_CONFIGURED"
  | "NOT_APPROVED"
  | "ERROR"
  | "READY"
  | "PARTIAL";

export interface ProviderHealth {
  id: ProviderId;
  status: ProviderStatus;
  /** Legible para Pedro. NUNCA contiene la clave ni fragmentos de ella. */
  detail: string;
  capabilities: Record<ProviderCapability, CapabilityStatus>;
  /** Créditos que quedan, si el proveedor los expone. */
  creditsRemaining: number | null;
  checkedAt: number;
}

// --- Anuncio normalizado (EVIDENCIA, no la entidad principal) ---

export type AdPlatform = "facebook" | "instagram" | "tiktok" | "other";
export type AdFormat = "video" | "image" | "carousel" | "other";

export interface HunterAd {
  /** Id estable nuestro: `${provider}:${externalId}`. */
  id: string;
  provider: ProviderId;
  externalId: string;
  platform: AdPlatform;
  advertiserName: string | null;
  advertiserExternalId: string | null;
  productNameRaw: string | null;
  adCopy: string | null;
  format: AdFormat | null;
  countries: string[];
  /** epoch s. */
  startedAt: number | null;
  lastSeenAt: number | null;
  active: boolean | null;
  activeDays: number | null;
  landingUrl: string | null;
  previewUrl: string | null;
  imageUrl: string | null;
  creativeExternalIds: string[];
  priceObserved: { amount: number; currency: string } | null;
  /** Huella para deduplicar entre proveedores. */
  fingerprint: string;
  raw: Record<string, unknown> | null;
}

// --- Señales agregadas del producto ---

/**
 * Todo lo que se puede CONTAR sin interpretar. Cada campo sale de agrupar
 * anuncios, nunca de una estimación.
 */
export interface ProductSignals {
  advertiserCount: number;
  activeAds: number;
  totalAds: number;
  creativeCount: number;
  oldestActiveAdDays: number | null;
  newAds7d: number | null;
  newAds14d: number | null;
  newAdvertisers7d: number | null;
  newAdvertisers14d: number | null;
  countryCount: number;
  platformCount: number;
  /** Cuota del anunciante mayor (0..1): concentración del mercado. */
  topAdvertiserShare: number | null;
  /** Creatividades por anunciante: inversión creativa. */
  creativesPerAdvertiser: number | null;
  newCreatives7d: number | null;
}

export function emptySignals(): ProductSignals {
  return {
    advertiserCount: 0,
    activeAds: 0,
    totalAds: 0,
    creativeCount: 0,
    oldestActiveAdDays: null,
    newAds7d: null,
    newAds14d: null,
    newAdvertisers7d: null,
    newAdvertisers14d: null,
    countryCount: 0,
    platformCount: 0,
    topAdvertiserShare: null,
    creativesPerAdvertiser: null,
    newCreatives7d: null,
  };
}

// --- Puntuaciones ---

export type ScoreKey =
  | "market"
  | "momentum"
  | "saturation"
  | "creative_investment"
  | "product"
  | "casamable"
  | "opportunity";

/**
 * Score y confianza SIEMPRE viajan juntos y son independientes: un 88 con 42 %
 * de confianza es información honesta; un 88 a secas es falsa precisión.
 */
export interface ScoreValue {
  score: number | null;
  confidence: number;
  /** Qué entró en el cálculo, para poder auditarlo. */
  parts: ScorePart[];
  /** Motivo cuando `score` es null (p. ej. INSUFFICIENT_HISTORY). */
  unavailableReason: string | null;
}

export interface ScorePart {
  key: string;
  label: string;
  value: number | null;
  weight: number;
  observed: string | null;
}

export const INSUFFICIENT_HISTORY = "INSUFFICIENT_HISTORY";
export const INSUFFICIENT_DATA = "INSUFFICIENT_DATA";

// --- Features del producto que infiere la IA ---

export type ProductFeatureKey =
  | "problemClarity"
  | "demoability"
  | "impulseBuy"
  | "wowFactor"
  | "evergreen"
  | "fragilityRisk"
  | "sizingRisk"
  | "regulatoryRisk"
  | "complexity"
  | "returnRisk"
  | "differentiationPotential";

export const PRODUCT_FEATURE_KEYS: readonly ProductFeatureKey[] = [
  "problemClarity",
  "demoability",
  "impulseBuy",
  "wowFactor",
  "evergreen",
  "fragilityRisk",
  "sizingRisk",
  "regulatoryRisk",
  "complexity",
  "returnRisk",
  "differentiationPotential",
] as const;

export const PRODUCT_FEATURE_LABEL: Record<ProductFeatureKey, string> = {
  problemClarity: "Claridad del problema",
  demoability: "Se demuestra en vídeo",
  impulseBuy: "Compra por impulso",
  wowFactor: "Factor sorpresa",
  evergreen: "Vende todo el año",
  fragilityRisk: "Riesgo de rotura",
  sizingRisk: "Riesgo de tallas",
  regulatoryRisk: "Riesgo regulatorio",
  complexity: "Complejidad operativa",
  returnRisk: "Riesgo de devolución",
  differentiationPotential: "Potencial de diferenciación",
};

/** Las que RESTAN: puntuar alto aquí es malo. */
export const PRODUCT_RISK_FEATURES: readonly ProductFeatureKey[] = [
  "fragilityRisk",
  "sizingRisk",
  "regulatoryRisk",
  "complexity",
  "returnRisk",
] as const;

export interface ProductFeature {
  key: ProductFeatureKey;
  value: number | null;
  confidence: number;
  rationale: string | null;
}

// --- Economía ---

export interface OpportunityEconomics {
  salePrice: Measured<number>;
  supplierCost: Measured<number>;
  realCPA: Measured<number>;
  expectedShippingCost: Measured<number>;
  expectedProfit: Measured<number>;
  margin: Measured<number>;
  roi: Measured<number>;
  breakEvenCPA: Measured<number>;
  /** Qué supuestos se usaron: sin esto los números no son auditables. */
  assumptions: EconomicAssumption[];
}

export interface EconomicAssumption {
  key: string;
  label: string;
  value: number;
  provenance: MetricProvenance;
  source: string | null;
}

// --- Oportunidad (LA entidad) ---

export type OpportunityStatus = "new" | "saved" | "watching" | "testing" | "discarded" | "winner" | "loser";

export type OpportunityBadge =
  | "RISING"
  | "EARLY"
  | "SATURATED"
  | "EVERGREEN"
  | "HIGH_COD_FIT"
  | "HIGH_RETURN_RISK"
  | "INSUFFICIENT_DATA";

export const BADGE_LABEL: Record<OpportunityBadge, string> = {
  RISING: "En alza",
  EARLY: "Temprano",
  SATURATED: "Saturado",
  EVERGREEN: "Todo el año",
  HIGH_COD_FIT: "Encaja con COD",
  HIGH_RETURN_RISK: "Riesgo de devolución",
  INSUFFICIENT_DATA: "Datos insuficientes",
};

export interface ProductOpportunity {
  id: string;
  canonicalName: string;
  category: string | null;
  description: string | null;
  heroImageUrl: string | null;
  observedPriceMin: number | null;
  observedPriceMax: number | null;
  supplierCostMin: number | null;
  supplierCostMax: number | null;
  currency: string;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  status: OpportunityStatus;
  /** 0..1 — cuánto nos fiamos de que este cluster sea UN producto. */
  sourceConfidence: number;
  clusterConfidence: number;
  signals: ProductSignals;
  scores: Record<ScoreKey, ScoreValue>;
  features: ProductFeature[];
  economics: OpportunityEconomics | null;
  badges: OpportunityBadge[];
  /** Ids de `HunterAd` que sostienen esta oportunidad. */
  adIds: string[];
  providers: ProviderId[];
  summary: OpportunitySummary | null;

  // ── Presentación (migración 20) ──────────────────────────────
  /** Proveedor que aportó la mayoría de la evidencia. */
  primaryProvider: ProviderId | null;
  /** Hasta 6 imágenes o previsualizaciones para la ficha. Puede venir vacío. */
  images: string[];
  /** Dominio de la landing más repetida. Solo el host, nunca la URL completa con parámetros. */
  landingDomain: string | null;
  /** Enlace directo a la Biblioteca de Anuncios, si se puede construir. */
  adLibraryUrl: string | null;
  /** Qué haría el sistema con esto. Es una RECOMENDACIÓN, no una orden. */
  recommendation: Recommendation | null;
}

/**
 * El veredicto que se enseña en grande. Se calcula con reglas explícitas
 * (`decideRecommendation`) y no con IA: Pedro tiene que poder preguntar «¿por
 * qué DESCARTAR?» y recibir una razón, no un encogimiento de hombros.
 */
export type Recommendation = "TESTEAR" | "VIGILAR" | "DESCARTAR";

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  TESTEAR: "Testear",
  VIGILAR: "Vigilar",
  DESCARTAR: "Descartar",
};

/**
 * La explicación se sirve TROCEADA por origen a propósito. Mezclar "14
 * anunciantes" (hecho) con "alta inversión creativa" (interpretación) en un
 * mismo párrafo es como se toman las malas decisiones.
 */
export interface OpportunitySummary {
  observed: string[];
  inferred: string[];
  estimated: string[];
  risks: string[];
  generatedAt: number;
  /** true si lo redactó un LLM; false si es la versión determinista. */
  aiGenerated: boolean;
}

// --- Búsqueda ---

export type FilterKind = "SOURCE_FILTER" | "POST_FILTER" | "AI_FILTER" | "FINANCIAL_FILTER";

export interface HunterFilters {
  country: string;
  platforms: AdPlatform[];
  categories: string[];
  keywords: string[];
  excludeKeywords: string[];
  priceMin: number | null;
  priceMax: number | null;
  supplierCostMax: number | null;
  minMargin: number | null;
  minExpectedProfit: number | null;
  minDaysActive: number | null;
  maxDaysActive: number | null;
  minAdvertisers: number | null;
  maxAdvertisers: number | null;
  minActiveAds: number | null;
  minCreativeCount: number | null;
  momentumMin: number | null;
  saturationMax: number | null;
  codFit: boolean | null;
  evergreen: boolean | null;
  seasonality: string | null;
  fragile: boolean | null;
  requiresSizing: boolean | null;
  electronics: boolean | null;
  regulatoryRisk: boolean | null;
  problemClarity: number | null;
  demoability: number | null;
  impulseBuy: number | null;
  shippingComplexity: number | null;
}

export type SearchRunState = "queued" | "running" | "partial" | "complete" | "failed";

export interface SearchRunProgress {
  sourcesQueried: number;
  sourcesTotal: number;
  sourcesFailed: string[];
  adsAnalyzed: number;
  productsDetected: number;
  candidatesDiscarded: number;
  opportunities: number;
}

/**
 * Hasta dónde llegó la búsqueda. `partial` NO es un fallo: es un resultado
 * con menos cobertura, y hay que poder decirlo sin tirar lo que sí se obtuvo.
 */
export type SearchCoverage = "full" | "partial" | "none" | "unknown";

export interface SearchRun {
  id: string;
  /** Título legible: «Mascotas · España». Se genera al planificar. */
  title: string | null;
  prompt: string | null;
  filters: HunterFilters;
  queries: string[];
  state: SearchRunState;
  progress: SearchRunProgress;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Llamadas y créditos gastados: el coste tiene que verse. */
  providerCalls: number;
  creditsSpent: number | null;
  fixtureMode: boolean;

  // ── Experiencia de proceso (migración 20) ────────────────────
  stages: StageState[];
  /** Etapa activa ahora mismo. */
  stage: StageKey | null;
  /** Microcopy de lo que está pasando: «1.284 anuncios revisados». */
  currentMessage: string | null;
  /** Duración estimada en segundos al arrancar. */
  estimateSeconds: number | null;
  estimatedFinishAt: number | null;
  /** Duración REAL, en ms. Alimenta la estimación de las siguientes. */
  durationMs: number | null;
  /** Qué proveedor mandó en esta búsqueda. */
  providerMode: string | null;
  coverage: SearchCoverage;
  /** El plan tal y como se ejecutó: frase, chips y estrategia. */
  plan: SearchPlanSnapshot | null;
  report: RadarReport | null;
}

/** Copia del plan guardada con la búsqueda: sin ella no se puede reproducir. */
export interface SearchPlanSnapshot {
  sentence: string;
  strategy: string[];
  aiUsed: boolean;
}

/**
 * El informe ejecutivo (§17). Se guarda con la búsqueda para que abrirla dos
 * semanas después enseñe lo mismo que el día que se lanzó.
 */
export interface RadarReport {
  headline: string;
  /** «Analizamos 1.284 anuncios y detectamos 38 productos.» */
  summary: string[];
  topPickIds: string[];
  watchIds: string[];
  risks: string[];
  marketNotes: string[];
  /** §18 — lo que haría hoy, en orden. Sale de los datos, no de una plantilla. */
  todayActions: TodayAction[];
  generatedAt: number;
  aiGenerated: boolean;
}

export interface TodayAction {
  /** Producto al que se refiere, si aplica. */
  productId: string | null;
  productName: string | null;
  verb: "TESTEAR" | "VIGILAR" | "BUSCAR_PROVEEDOR" | "EVITAR" | "AMPLIAR_BUSQUEDA";
  text: string;
  /** Por qué. Sin esto es un horóscopo. */
  because: string;
}

export interface DecisionReasonOption {
  key: string;
  label: string;
}

export const DISCARD_REASONS: readonly DecisionReasonOption[] = [
  { key: "too_saturated", label: "Demasiado saturado" },
  { key: "bad_margin", label: "Margen insuficiente" },
  { key: "bad_supplier", label: "Proveedor malo o sin stock" },
  { key: "weak_creative", label: "Creatividad floja" },
  { key: "fragile", label: "Frágil" },
  { key: "regulated", label: "Regulado" },
  { key: "other", label: "Otro" },
] as const;

export interface TestPlan {
  opportunityId: string;
  recommendedPrice: number | null;
  targetCPA: number | null;
  breakEvenCPA: number | null;
  recommendedDailyBudget: number | null;
  testDurationDays: number | null;
  creativeAngles: string[];
  landingHypothesis: string | null;
  generatedAt: number;
  /** Por qué esos números, para que no parezcan magia. */
  rationale: string[];
}

// Candidatos locales del flujo predictivo/discovery de v4.3. Conviven con
// ProductOpportunity: éste agrega evidencia del Radar; ProductCandidate es
// una ficha que Pedro decide, puntúa y puede convertir en landing.
export type CandidateState = "nuevo" | "descartado" | "en_prueba" | "ganador";
export type Verdict = "descartar" | "dudoso" | "probar" | "prioritario";

export interface CandidateFacts {
  sourceUrl: string;
  sourceDomain: string;
  fetchedAt: number | null;
  name: string | null;
  category: string | null;
  unitCostEur: number | null;
  salePriceEur?: number | null;
  sourceCurrency: string | null;
  sourceCost: number | null;
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  variants: string[] | null;
  specs: Record<string, string> | null;
  claims: string[] | null;
}

export interface ScoreReason { factor: string; points: number; detail: string }
export interface CandidateScore {
  shippingTier: "hasta_1kg" | "hasta_4kg";
  shippingEur: number;
  proposedPriceEur: number;
  unitMarginEur: number;
  maxCpaEur: number;
  breakEvenDeliveryPct: number;
  score: number;
  verdict: Verdict;
  reasons: ScoreReason[];
}

export interface ProductCandidate extends CandidateFacts {
  id: number;
  state: CandidateState;
  manualNote: string | null;
  scoring: CandidateScore | null;
  reasons: ScoreReason[];
  createdAt: number;
  updatedAt: number;
}
