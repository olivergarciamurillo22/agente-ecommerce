// ============================================================
// Cazador de productos — CONTRATOS.
//
// Tipos compartidos entre el adaptador (servidor), la ruta API y la UI.
// Es el contrato que el backend de Pedro (scraping/scoring de la Meta Ad
// Library) debe cumplir. Ver `adapter.ts` para los endpoints.
//
// HONESTIDAD DE DATOS — regla dura de este módulo:
//   La Meta Ad Library NO expone ventas, ROAS, gasto, beneficio, ingresos,
//   conversiones ni unidades. Ninguno de esos campos existe en estos tipos
//   y ningún adaptador puede inventarlos. Todo dato que la fuente no
//   proporcione viaja como `null` y la UI lo pinta como "No disponible":
//   nunca 0, nunca una estimación disfrazada de dato.
// ============================================================

// --- Estado del pipeline de investigación ---

export type ProductResearchStatus =
  | "discovered"
  | "saved"
  | "researching"
  | "validate_supplier"
  | "prepare_creative"
  | "ready_to_test"
  | "testing"
  | "winner"
  | "discarded";

/** Orden canónico del pipeline (de izquierda a derecha en el tablero). */
export const PRODUCT_RESEARCH_STATUSES: readonly ProductResearchStatus[] = [
  "discovered",
  "saved",
  "researching",
  "validate_supplier",
  "prepare_creative",
  "ready_to_test",
  "testing",
  "winner",
  "discarded",
] as const;

export const PRODUCT_RESEARCH_STATUS_LABEL: Record<ProductResearchStatus, string> = {
  discovered: "Descubierto",
  saved: "Guardado",
  researching: "Investigando",
  validate_supplier: "Validar proveedor",
  prepare_creative: "Preparar creatividad",
  ready_to_test: "Listo para probar",
  testing: "En prueba",
  winner: "Ganador",
  discarded: "Descartado",
};

// --- Parámetros de búsqueda en la Ad Library ---

export type AdPlatformFilter = "facebook" | "instagram" | "all";
export type CreativeFormat = "video" | "image" | "carousel";
export type CreativeFormatFilter = CreativeFormat | "all";
export type AdLibrarySort = "relevance" | "newest" | "longest_active" | "most_variations";

export const AD_LIBRARY_SORT_LABEL: Record<AdLibrarySort, string> = {
  relevance: "Relevancia",
  newest: "Más recientes",
  longest_active: "Más tiempo activos",
  most_variations: "Más variaciones",
};

export const CREATIVE_FORMAT_LABEL: Record<CreativeFormat, string> = {
  video: "Vídeo",
  image: "Imagen",
  carousel: "Carrusel",
};

/** Países ofrecidos en la UI (código ISO-3166-1 alpha-2). */
export const COUNTRY_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "ES", label: "España" },
  { code: "PT", label: "Portugal" },
  { code: "FR", label: "Francia" },
  { code: "IT", label: "Italia" },
  { code: "DE", label: "Alemania" },
];

export interface AdLibrarySearchParams {
  /** ISO alpha-2. Obligatorio: la Ad Library se consulta por país. */
  country: string;
  category?: string;
  keywords: string;
  platform?: AdPlatformFilter;
  creativeFormat?: CreativeFormatFilter;
  activeOnly?: boolean;
  /** Fecha ISO (YYYY-MM-DD): solo anuncios que empezaron después. */
  startedAfter?: string;
  minActiveDays?: number;
  sort?: AdLibrarySort;
  page?: number;
  pageSize?: number;
  /** Campos avanzados que el backend pueda aceptar sin cambiar el contrato. */
  advanced?: Record<string, unknown>;
}

// --- Winner Score (lo calcula el backend; la UI solo lo pinta) ---

export type WinnerSignalKey =
  | "ad_age"
  | "active_continuity"
  | "creative_variations"
  | "advertiser_similar_ads"
  | "multi_country"
  | "landing_quality"
  | "offer_clarity"
  | "price_potential"
  | "saturation"
  | "cod_fit"
  | "margin_potential";

export const WINNER_SIGNAL_KEYS: readonly WinnerSignalKey[] = [
  "ad_age",
  "active_continuity",
  "creative_variations",
  "advertiser_similar_ads",
  "multi_country",
  "landing_quality",
  "offer_clarity",
  "price_potential",
  "saturation",
  "cod_fit",
  "margin_potential",
] as const;

export const WINNER_SIGNAL_LABEL: Record<WinnerSignalKey, string> = {
  ad_age: "Antigüedad del anuncio",
  active_continuity: "Continuidad activa",
  creative_variations: "Variaciones creativas",
  advertiser_similar_ads: "Anuncios similares del anunciante",
  multi_country: "Presencia multi-país",
  landing_quality: "Calidad de la landing",
  offer_clarity: "Claridad de la oferta",
  price_potential: "Potencial de precio",
  saturation: "Saturación (menos es mejor)",
  cod_fit: "Encaje COD",
  margin_potential: "Potencial de margen",
};

export type ScoreConfidence = "low" | "medium" | "high";

export const SCORE_CONFIDENCE_LABEL: Record<ScoreConfidence, string> = {
  low: "Confianza baja",
  medium: "Confianza media",
  high: "Confianza alta",
};

export interface WinnerScoreSignal {
  key: WinnerSignalKey;
  label: string;
  /** 0–100 cuando la señal se ha podido medir; `null` = sin dato. */
  value: number | null;
  /** Peso relativo en el total (lo decide el backend). */
  weight: number | null;
  /** Qué se observó, en texto ("activo 74 días", "12 variaciones"…). */
  observed: string | null;
  missing: boolean;
}

export interface WinnerScoreBreakdown {
  /** 0–100. `null` = el análisis aún no ha producido un total. */
  total: number | null;
  confidence: ScoreConfidence | null;
  analyzedAt: string | null;
  reason: string | null;
  signals: WinnerScoreSignal[];
}

// --- Resultado de la Ad Library ---

export type DataStatus = "complete" | "partial" | "unknown";

export const DATA_STATUS_LABEL: Record<DataStatus, string> = {
  complete: "Dato completo",
  partial: "Dato parcial",
  unknown: "Sin verificar",
};

export interface DetectedPrice {
  amount: number;
  currency: string;
}

export interface AdLibraryResult {
  id: string;
  productName: string | null;
  advertiser: string | null;
  countries: string[];
  format: CreativeFormat | null;
  cta: string | null;
  /** ISO 8601 (fecha o fecha-hora) del inicio del anuncio en la fuente. */
  startedAt: string | null;
  activeDays: number | null;
  variations: number | null;
  landingUrl: string | null;
  detectedPrice: DetectedPrice | null;
  previewUrl: string | null;
  adCopy: string | null;
  dataStatus: DataStatus;
  winnerScore: WinnerScoreBreakdown | null;
}

export interface AdLibrarySearchPage {
  results: AdLibraryResult[];
  page: number;
  pageSize: number;
  /** `null` cuando la fuente no sabe cuántos hay en total. */
  total: number | null;
  hasMore: boolean;
}

// --- Candidato en el pipeline ---

export type SaturationLevel = "low" | "medium" | "high";

export const SATURATION_LABEL: Record<SaturationLevel, string> = {
  low: "Saturación baja",
  medium: "Saturación media",
  high: "Saturación alta",
};

/**
 * Supuestos económicos que introduce Pedro a mano. Son ESTIMACIONES suyas,
 * no datos de la Ad Library; por eso viven aparte y se pintan como tales.
 */
export interface CandidateEconomics {
  costEstimate: number | null;
  salePriceEstimate: number | null;
  shippingCost: number | null;
  returnCost: number | null;
}

export interface CandidateNote {
  at: string;
  text: string;
}

export interface CandidateDecision {
  at: string;
  from: ProductResearchStatus | null;
  to: ProductResearchStatus;
  note: string | null;
}

export type WinningProductCandidate = AdLibraryResult & {
  status: ProductResearchStatus;
  economics: CandidateEconomics | null;
  notes: CandidateNote[];
  decisions: CandidateDecision[];
  savedAt: string | null;
  risks: string[];
  saturation: SaturationLevel | null;
};

/** Candidato ya guardado: `savedAt` garantizado. */
export type SavedCandidate = WinningProductCandidate & { savedAt: string };

export interface ProductHunterFilters {
  status?: ProductResearchStatus[];
  country?: string;
  minScore?: number;
  saturation?: SaturationLevel;
}

export interface SaveCandidateInput {
  result: AdLibraryResult;
  note?: string | null;
}

export interface CandidateComparison {
  ids: string[];
  candidates: WinningProductCandidate[];
  comparedAt: string;
}

// --- Fuente de datos (interfaz que implementan los adaptadores) ---

export type ProductHunterSourceKind = "api" | "mock" | "off";

export interface ProductHunterAvailability {
  available: boolean;
  source: ProductHunterSourceKind;
  reason: string;
}

export interface ProductHunterDataSource {
  readonly source: ProductHunterSourceKind;
  search(params: AdLibrarySearchParams): Promise<AdLibrarySearchPage>;
  getCandidate(id: string): Promise<WinningProductCandidate | null>;
  listSaved(filters?: ProductHunterFilters): Promise<SavedCandidate[]>;
  saveCandidate(input: SaveCandidateInput): Promise<SavedCandidate>;
  moveCandidate(id: string, status: ProductResearchStatus, note?: string | null): Promise<WinningProductCandidate>;
  addNote(id: string, text: string): Promise<WinningProductCandidate>;
  setEconomics(id: string, economics: CandidateEconomics): Promise<WinningProductCandidate>;
  compare(ids: string[]): Promise<CandidateComparison>;
}

/** Límites del comparador (también los valida el backend). */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;
