export type CandidateState = "nuevo" | "descartado" | "en_prueba" | "ganador";
export type Verdict = "descartar" | "dudoso" | "probar" | "prioritario";

export interface CandidateFacts {
  sourceUrl: string;
  sourceDomain: string;
  fetchedAt: number | null;
  name: string | null;
  category: string | null;
  unitCostEur: number | null;
  /** Precio real decidido por Pedro. Nunca se deduce del coste. */
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

/** Tramos de peso facturable con tarifa confirmada (ver SHIPPING_TIERS en scoring.ts). */
export type ShippingTier = "hasta_1kg" | "hasta_2kg" | "hasta_3kg" | "hasta_4kg";

export interface ScoreReason { factor: string; points: number; detail: string }
export interface CandidateScore {
  shippingTier: ShippingTier;
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
