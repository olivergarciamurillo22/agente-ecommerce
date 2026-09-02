export const PRODUCT_INTELLIGENCE_CONFIG = {
  maxQueriesPerRun: 12,
  maxDepth: 2,
  minimumQueryScore: 20,
  maxChildrenPerQuery: 5,
  productClusterThreshold: 0.75,
  branchPruning: { maxConsecutiveNoProducts: 3, duplicateRateThreshold: 0.9, minimumScore: 20 },
  safeTest: { maxInitialQueries: 5, maxPagesPerQuery: 2, maxDepth: 2, maxProviderCalls: 20, dryRun: true },
  weights: {
    metaValidation: 0.14,
    longevity: 0.1,
    creativeVelocity: 0.1,
    momentum: 0.14,
    pain: 0.08,
    creativePotential: 0.09,
    casamableFit: 0.14,
    economics: 0.11,
    saturation: 0.05,
    logistics: 0.05,
  },
  autonomousSeeds: [
    "pago contra reembolso",
    "envío 24/48h",
    "personas mayores",
    "dolor cervical",
    "durezas pies",
    "pelos de mascota",
  ],
} as const;

export const META_AD_LIBRARY_CONFIG = {
  country: (process.env.META_AD_LIBRARY_COUNTRY || "ES") as "ES" | "PT" | "IT" | "FR" | "DE" | "EU",
  maxPages: Math.max(1, Number(process.env.META_AD_LIBRARY_MAX_PAGES || 3)),
  maxAdsPerQuery: Math.max(1, Number(process.env.META_AD_LIBRARY_MAX_ADS_PER_QUERY || 150)),
  maxProviderCallsPerCycle: Math.max(1, Number(process.env.META_AD_LIBRARY_MAX_CALLS_PER_CYCLE || 20)),
  maxCallsPerHour: Math.max(1, Number(process.env.META_AD_LIBRARY_MAX_CALLS_PER_HOUR || 100)),
  requestTimeoutMs: Math.max(1000, Number(process.env.META_AD_LIBRARY_TIMEOUT_MS || 15000)),
  maxRetries: Math.max(0, Number(process.env.META_AD_LIBRARY_MAX_RETRIES || 3)),
  cooldownSeconds: Math.max(1, Number(process.env.META_AD_LIBRARY_COOLDOWN_SECONDS || 60)),
} as const;

export function productIntelligenceEnabled(): boolean { return process.env.PRODUCT_INTELLIGENCE_ENABLED !== "false"; }
export function autoHuntEnabled(): boolean { return process.env.AUTO_HUNT_ENABLED === "true"; }
