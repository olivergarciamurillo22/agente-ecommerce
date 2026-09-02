export type ResearchMode = "MANUAL_SEED" | "AUTONOMOUS";
export type SessionStatus = "RUNNING" | "PAUSED" | "STOPPED" | "WAITING_FOR_META_AUTHORIZATION" | "COMPLETED" | "LIMIT_REACHED" | "FAILED";
export type QueryStatus = "PENDING" | "RUNNING" | "COMPLETED" | "LOW_VALUE" | "EXHAUSTED" | "FAILED";
export type Lifecycle = "EMERGING" | "SCALING" | "VALIDATED" | "SATURATING" | "DECLINING" | "UNKNOWN";
export type Recommendation = "TEST_NOW" | "WATCHLIST" | "RESEARCH_MORE" | "REJECT";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type MetaStatusCode = "META_NOT_CONFIGURED" | "META_CONFIGURED_UNAUTHORIZED" | "META_CONNECTED" | "META_RATE_LIMITED" | "META_ERROR";

export interface RawAd {
  id: string;
  advertiserId: string;
  advertiserName: string;
  copy: string;
  productName?: string;
  landingUrl?: string;
  startedAt: string;
  active: boolean;
  price?: number;
  provider?: "META_AD_LIBRARY" | "JSON_IMPORT" | "TEST_FIXTURE";
  pageId?: string;
  title?: string;
  description?: string;
  endedAt?: string;
  media?: Array<{ type: string; url?: string }>;
  platforms?: string[];
  countries?: string[];
  rawProviderPayload?: Record<string, unknown>;
  providerVersion?: string;
  normalizerVersion?: string;
  normalizedAt?: string;
}

export interface AdSearchOptions {
  query: string;
  country?: "ES" | "PT" | "IT" | "FR" | "DE" | "EU";
  activeStatus?: "ACTIVE" | "INACTIVE" | "ALL";
  mediaType?: "IMAGE" | "MEME" | "VIDEO" | "NONE" | "ALL";
  limit?: number;
}

export interface ProviderStatus {
  source: "META_AD_LIBRARY" | "JSON_IMPORT" | "TEST_FIXTURE";
  available: boolean;
  reason?: string;
  lastSuccessfulScan?: string;
  code?: MetaStatusCode;
  configured?: boolean;
  authorization?: "NOT_CONFIGURED" | "PENDING" | "CONNECTED" | "RATE_LIMITED" | "ERROR";
  apiVersion?: string;
  lastConnectionAttempt?: string;
  researchAvailable?: boolean;
}

export interface AdSource {
  searchAds(query: string): Promise<RawAd[]>;
}

export interface ScoreInput {
  metaValidation: number;
  longevity: number;
  creativeVelocity: number;
  momentum: number;
  pain: number;
  creativePotential: number;
  casamableFit: number;
  economics: number;
  saturation: number;
  logistics: number;
  penalties?: number;
}

export interface ProductFinding extends ScoreInput {
  id: string;
  name: string;
  aliases: string[];
  advertiserCount: number;
  activeAds: number;
  oldestActiveAdDays: number;
  opportunityScore: number;
  lifecycle: Lifecycle;
  recommendation: Recommendation;
  signals: string[];
  risks: string[];
  confidence: Confidence;
  scoreBreakdown: Record<string, number>;
  discoveryPath?: string[];
  missingData?: string[];
  clusterConfidence?: Confidence;
}

export interface ResearchQuery {
  id: string;
  displayQuery: string;
  normalizedQuery: string;
  rootQueryId: string;
  parentQueryId?: string;
  depth: number;
  source: string;
  priority: number;
  status: QueryStatus;
  resultsCount: number;
  queryScore: number;
  newProductsFound?: number;
  newAdvertisersFound?: number;
  duplicateRate?: number;
}

export interface ResearchSession {
  id: string;
  mode: ResearchMode;
  userQuery?: string;
  status: SessionStatus;
  startedAt: string;
  queriesProcessed: number;
  productsFound: number;
  queries: ResearchQuery[];
  products: ProductFinding[];
  source?: ProviderStatus["source"];
  adsScanned?: number;
  advertisersFound?: number;
  rootQuery?: string;
  qualifiedProductsFound?: number;
  currentDepth?: number;
  safeTest?: boolean;
}

export type WatchlistStatus = "MONITORING" | "TEST_CANDIDATE" | "TESTED" | "REJECTED" | "ARCHIVED" | "PAUSED";
export interface WatchlistItem { productId: string; status: WatchlistStatus; addedAt: string; updatedAt: string }
export interface ProductSnapshot { id: string; productId: string; capturedAt: string; activeAds: number; advertisers: number; medianAdAge: number; oldestAd: number; newAds7d: number; newAds14d: number; creativeVelocity: number; opportunityScore: number; momentum: number; lifecycle: Lifecycle }
export type SignalType = "NEW_AD" | "REMOVED_AD" | "NEW_ADVERTISER" | "CREATIVE_SPIKE" | "SCORE_SPIKE" | "SCORE_DROP" | "LIFECYCLE_CHANGE";
export interface ProductSignal { id: string; productId: string; type: SignalType; createdAt: string; message: string }

export interface CasamableTestPerformance { productId: string; cpa?: number; cvr?: number; roas?: number; orders?: number; returns?: number }
export interface ExistingEconomicsReader { estimateProductEconomics(productId: string): Promise<{ status: "known" | "unknown"; contributionMargin?: number; breakEvenCpa?: number }> }
