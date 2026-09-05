import crypto from "node:crypto";
import { runResearch } from "./engine";
import { saveSession } from "./repository";
import { savePipelineRun } from "./pipeline-repository";
import { configuredPredictiveProvider, estimatePredictiveEconomics, type PredictiveProvider } from "./predictive";
import type { AdSearchOptions, AdSource, ProductFinding, RawAd, ResearchSession } from "./types";
import { sanitizeProductIntelligencePayload } from "./redaction";

interface SearchableSource extends AdSource {
  search?: (options: AdSearchOptions) => Promise<RawAd[]>;
  telemetry?: () => { callsMade?: number; usageHeaders?: Record<string, string> };
}

export interface HunterPipelineOptions {
  query: string;
  country?: "ES" | "PT" | "IT" | "FR" | "DE" | "EU";
  days?: number;
  maxResultsPerQuery?: number;
  predictive?: boolean;
  maxPredictiveCandidates?: number;
  provider: SearchableSource;
  predictiveProvider?: PredictiveProvider;
  persist?: boolean;
}

export interface HunterPipelineMetrics {
  queries: number;
  metaCalls: number;
  adsReceived: number;
  groups: number;
  candidates: number;
  noiseRejected: number;
  supplierCalls: number;
  predictiveEnriched: number;
  errors: number;
}

export interface HunterPipelineResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  rootQuery: string;
  country: string;
  sessionId: string;
  metrics: HunterPipelineMetrics;
  usageHeaders: Record<string, string>;
  discoveryPath: Array<{ rootQuery: string; parentQuery: string | null; query: string; depth: number; source: string }>;
  rawMetaResponses: Array<{ adId: string; payload: Record<string, unknown> }>;
  normalizedAds: RawAd[];
  candidates: ProductFinding[];
  errors: Array<{ stage: string; message: string }>;
  autoHunt24x7: "OFF";
}

export async function runHunterPipeline(options: HunterPipelineOptions): Promise<HunterPipelineResult> {
  const query = options.query.trim();
  if (!query) throw new Error("Falta --termino o --producto");
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const country = options.country ?? "ES";
  const days = Math.max(1, Math.min(90, Math.trunc(options.days ?? 14)));
  const adsById = new Map<string, RawAd>();
  const errors: Array<{ stage: string; message: string }> = [];
  const source: AdSource = {
    searchAds: async (term) => {
      try {
        const dateMax = new Date().toISOString().slice(0, 10);
        const dateMin = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const ads = options.provider.search
          ? await options.provider.search({ query: term, country, activeStatus: "ACTIVE", limit: options.maxResultsPerQuery ?? 150, dateMin, dateMax })
          : await options.provider.searchAds(term);
        for (const ad of ads) adsById.set(ad.id, ad);
        return ads;
      } catch (error) {
        const message = error instanceof Error ? error.message : "error desconocido";
        errors.push({ stage: `meta:${term}`, message });
        throw error;
      }
    },
  };
  const session: ResearchSession = await runResearch(source, query);
  const predictiveProvider = options.predictiveProvider ?? configuredPredictiveProvider();
  let predictiveEnriched = 0;
  let supplierCalls = 0;
  if (options.predictive !== false) {
    const eligible = session.products.filter((product) => product.candidateEligible !== false && !product.noise).sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, options.maxPredictiveCandidates ?? 10);
    for (const product of eligible) {
      const productAds = (product.adIds ?? []).map((adId) => adsById.get(adId)).filter((ad): ad is RawAd => Boolean(ad));
      try {
        const result = await estimatePredictiveEconomics(product.name, predictiveProvider, productAds);
        product.predictiveEconomics = result.economics;
        product.preliminaryVerdict = result.verdict;
        product.decisionEligible = false;
        product.missingData = [...new Set([...(product.missingData ?? []).filter((item) => item !== "economics"), ...result.economics.missingData])];
        predictiveEnriched++;
        supplierCalls += predictiveProvider.available ? 2 : 0;
      } catch (error) {
        errors.push({ stage: `predictive:${product.id}`, message: error instanceof Error ? error.message : "error desconocido" });
      }
    }
    saveSession(session);
  }
  const telemetry = options.provider.telemetry?.() ?? {};
  const finishedAt = new Date().toISOString();
  const result: HunterPipelineResult = {
    runId: crypto.randomUUID(), startedAt, finishedAt, durationMs: Date.now() - started, rootQuery: query, country, sessionId: session.id,
    metrics: {
      queries: session.queriesProcessed, metaCalls: telemetry.callsMade ?? session.providerCalls ?? 0, adsReceived: adsById.size,
      groups: session.products.length, candidates: session.products.filter((product) => product.candidateEligible !== false).length,
      noiseRejected: session.products.filter((product) => product.noise).length, supplierCalls, predictiveEnriched, errors: errors.length + (session.errors?.length ?? 0),
    },
    usageHeaders: telemetry.usageHeaders ?? {},
    discoveryPath: session.queries.map((entry) => ({ rootQuery: session.rootQuery ?? query, parentQuery: entry.parentQueryId ? session.queries.find((candidate) => candidate.id === entry.parentQueryId)?.displayQuery ?? null : null, query: entry.displayQuery, depth: entry.depth, source: entry.source })),
    rawMetaResponses: [...adsById.values()].flatMap((ad) => ad.rawProviderPayload ? [{ adId: ad.id, payload: sanitizeProductIntelligencePayload(ad.rawProviderPayload) as Record<string, unknown> }] : []),
    normalizedAds: [...adsById.values()].map((ad) => ({ ...ad, rawProviderPayload: undefined })),
    candidates: session.products,
    errors: [...errors, ...(session.errors ?? []).map((entry) => ({ stage: `query:${entry.query}`, message: entry.message }))],
    autoHunt24x7: "OFF",
  };
  if (options.persist !== false) savePipelineRun(result);
  return result;
}
