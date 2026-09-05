export type PredictiveVerdict = "descartar" | "investigar" | "candidato_fuerte";
export type EvidenceKind = "wholesale" | "retail";
export type EstimateConfidence = "baja" | "media";
export type PublicSourceName = "aliexpress" | "1688" | "alibaba";

export interface PublicSourceStatus {
  source: PublicSourceName;
  status: "disponible" | "no_disponible";
  reason: string | null;
  resultCount: number;
}

export interface SearchEvidence {
  kind: EvidenceKind;
  sourceUrl: string;
  sourceDomain: string;
  title: string;
  priceEur: number;
  quantity: number | null;
  weightGrams: number | null;
  observedAt: number;
}

export interface PriceRange {
  min: number;
  max: number;
  probable: number;
  sources: SearchEvidence[];
  consultedAt: number;
  expiresAt: number;
  confidence: EstimateConfidence;
}

export interface WholesaleEstimate {
  at100: PriceRange | null;
  at500: PriceRange | null;
  reason: string | null;
  sourceStatuses?: PublicSourceStatus[];
}

export interface RetailEstimate {
  unit: PriceRange | null;
  tiers: { unit: PriceRange; pack2Reference: string; pack4Reference: string } | null;
  reason: string | null;
}

export interface PreliminaryViability {
  verdict: PredictiveVerdict | null;
  worstContributionEur: number | null;
  bestContributionEur: number | null;
  logisticsEur: number | null;
  shippingTier: "hasta_1kg" | "hasta_4kg" | null;
  reason: string | null;
}

export interface PredictiveEstimate {
  id?: number;
  productQuery: string;
  competitorUrl: string | null;
  searchAvailable: boolean;
  searchMechanism: string | null;
  wholesale: WholesaleEstimate;
  retail: RetailEstimate;
  viability: PreliminaryViability;
  consultedAt: number;
  expiresAt: number;
  promotedCandidateId?: number | null;
}

export interface PredictiveSearchRequest {
  query: string;
  competitorUrl?: string | null;
  kind: EvidenceKind;
}

export interface PredictiveSearchProvider {
  readonly available: boolean;
  readonly mechanism: string | null;
  search(request: PredictiveSearchRequest): Promise<SearchEvidence[]>;
  sourceStatuses?(): PublicSourceStatus[];
}
