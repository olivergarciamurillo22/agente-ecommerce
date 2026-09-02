import crypto from "node:crypto";
import { PRODUCT_INTELLIGENCE_CONFIG, productIntelligenceEnabled } from "./config";
import { saveSession } from "./repository";
import { classifyLifecycle, opportunityScore, recommend, scoreBreakdown } from "./scoring";
import { advertiserKey, clusterSimilarity } from "./clustering";
import { appendSnapshot } from "./state";
import type { AdSource, ProductFinding, RawAd, ResearchQuery, ResearchSession, ScoreInput } from "./types";

export const normalizeQuery = (value: string) => value.trim().toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
const id = () => crypto.randomUUID();
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));

function expand(query: ResearchQuery, ads: RawAd[]): string[] {
  const names = ads.map((ad) => ad.productName).filter((name): name is string => Boolean(name));
  return [...new Set(names)].filter((name) => normalizeQuery(name) !== query.normalizedQuery).slice(0, PRODUCT_INTELLIGENCE_CONFIG.maxChildrenPerQuery);
}

export function analyzeAds(ads: RawAd[]): ProductFinding[] {
  const groups = new Map<string, { name: string; ads: RawAd[]; aliases: string[]; confidence: "HIGH" | "MEDIUM" | "LOW" }>();
  for (const ad of ads) {
    const name = ad.productName?.trim() || ad.copy.split(/[.!?]/)[0].slice(0, 70) || "Producto sin nombre";
    const match = [...groups.entries()].find(([, group]) => clusterSimilarity(group.name, name).score >= PRODUCT_INTELLIGENCE_CONFIG.productClusterThreshold);
    const key = match?.[0] ?? normalizeQuery(name); const previous = groups.get(key);
    groups.set(key, previous ? { ...previous, ads: [...previous.ads, ad], aliases: [...new Set([...previous.aliases, name])], confidence: clusterSimilarity(previous.name, name).confidence } : { name, ads: [ad], aliases: [], confidence: "LOW" });
  }
  return [...groups.entries()].map(([key, group]) => {
    const productAds = group.ads;
    const advertisers = new Set(productAds.map(advertiserKey)).size;
    const active = productAds.filter((ad) => ad.active);
    const oldest = Math.max(0, ...active.map((ad) => daysSince(ad.startedAt)));
    const recent = productAds.filter((ad) => daysSince(ad.startedAt) <= 7).length;
    const saturation = Math.min(100, advertisers * 8 + Math.max(0, advertisers - 5) * 3);
    const input: ScoreInput = {
      metaValidation: Math.min(100, productAds.length * 12 + advertisers * 8),
      longevity: Math.min(100, oldest * 2),
      creativeVelocity: Math.min(100, recent * 18),
      momentum: Math.min(100, recent * 12 + active.length * 7),
      pain: /dolor|problema|elimina|alivia|limpia|corrige/i.test(productAds.map((ad) => ad.copy).join(" ")) ? 80 : 50,
      creativePotential: 60,
      casamableFit: 65,
      economics: productAds.some((ad) => ad.price) ? 65 : 40,
      saturation: 100 - saturation,
      logistics: 65,
      penalties: 0,
    };
    const score = opportunityScore(input);
    return {
      ...input, id: key, name: group.name, aliases: group.aliases,
      advertiserCount: advertisers, activeAds: active.length, oldestActiveAdDays: oldest,
      opportunityScore: score, lifecycle: classifyLifecycle({ ...input, saturation }, advertisers),
      recommendation: recommend(score, { ...input, saturation }),
      signals: [`${active.length} anuncios activos`, `${advertisers} anunciantes`, `Anuncio activo más antiguo: ${oldest} días`],
      risks: advertisers > 8 ? ["Competencia elevada"] : [],
      confidence: productAds.length >= 10 && advertisers >= 3 && productAds.some((ad) => ad.price) ? "HIGH" : productAds.length >= 4 && advertisers >= 2 ? "MEDIUM" : "LOW",
      clusterConfidence: group.confidence,
      scoreBreakdown: scoreBreakdown(input),
      missingData: [...(!productAds.some((ad) => ad.price) ? ["economics"] : []), ...(productAds.length < 3 ? ["more_ads"] : [])],
    };
  });
}

export function calculateQueryScore(input: { newProducts: number; newAdvertisers: number; averageOpportunity: number; duplicateRate: number; emptyRuns?: number }): number {
  return Math.max(0, Math.min(100, Math.round(input.newProducts * 15 + input.newAdvertisers * 8 + input.averageOpportunity * 0.45 - input.duplicateRate * 35 - (input.emptyRuns ?? 0) * 10)));
}

function makeQuery(displayQuery: string, source: string, rootQueryId?: string, parentQueryId?: string, depth = 0): ResearchQuery {
  const queryId = id();
  return { id: queryId, displayQuery, normalizedQuery: normalizeQuery(displayQuery), rootQueryId: rootQueryId ?? queryId, parentQueryId, depth, source, priority: 100 - depth * 20, status: "PENDING", resultsCount: 0, queryScore: 0 };
}

export async function runResearch(provider: AdSource, userQuery?: string, recovered?: ResearchSession): Promise<ResearchSession> {
  if (!productIntelligenceEnabled()) throw new Error("Product Intelligence is disabled");
  const manual = typeof userQuery === "string" && userQuery.trim().length > 0;
  const initial = manual ? [makeQuery(userQuery!, "USER")] : PRODUCT_INTELLIGENCE_CONFIG.autonomousSeeds.slice(0, PRODUCT_INTELLIGENCE_CONFIG.safeTest.maxInitialQueries).map((seed) => makeQuery(seed, "SEED"));
  const session: ResearchSession = recovered ?? { id: id(), mode: manual ? "MANUAL_SEED" : "AUTONOMOUS", userQuery: manual ? userQuery : undefined, rootQuery: manual ? userQuery : undefined, status: "RUNNING", startedAt: new Date().toISOString(), queriesProcessed: 0, productsFound: 0, qualifiedProductsFound: 0, queries: initial, products: [], adsScanned: 0, advertisersFound: 0, currentDepth: 0, safeTest: !manual };
  session.status = "RUNNING";
  const seen = new Set(session.queries.map((q) => q.normalizedQuery));
  const processedAtStart = session.queriesProcessed;
  while (session.queriesProcessed - processedAtStart < PRODUCT_INTELLIGENCE_CONFIG.maxQueriesPerRun) {
    const query = session.queries.filter((q) => q.status === "PENDING").sort((a, b) => b.priority - a.priority)[0];
    if (!query) break;
    query.status = "RUNNING";
    try {
      const ads = await provider.searchAds(query.displayQuery); // Garantía: la query manual exacta es la primera llamada.
      session.source = ads[0]?.provider ?? session.source;
      session.adsScanned = (session.adsScanned ?? 0) + ads.length;
      const beforeProducts = new Set(session.products.map((item) => item.id));
      const beforeAdvertisers = session.advertisersFound ?? 0;
      const findings = analyzeAds(ads);
      query.resultsCount = ads.length;
      query.newProductsFound = findings.filter((item) => !beforeProducts.has(item.id)).length;
      query.newAdvertisersFound = Math.max(0, new Set(ads.map(advertiserKey)).size - beforeAdvertisers);
      query.duplicateRate = ads.length ? 1 - new Set(ads.map((ad) => ad.id)).size / ads.length : 0;
      query.queryScore = calculateQueryScore({ newProducts: query.newProductsFound, newAdvertisers: query.newAdvertisersFound, averageOpportunity: findings.length ? findings.reduce((sum, item) => sum + item.opportunityScore, 0) / findings.length : 0, duplicateRate: query.duplicateRate, emptyRuns: ads.length ? 0 : 1 });
      query.status = query.queryScore < PRODUCT_INTELLIGENCE_CONFIG.minimumQueryScore ? "LOW_VALUE" : "COMPLETED";
      if ((query.duplicateRate ?? 0) >= PRODUCT_INTELLIGENCE_CONFIG.branchPruning.duplicateRateThreshold || (query.depth > 0 && !query.newProductsFound && query.queryScore < PRODUCT_INTELLIGENCE_CONFIG.branchPruning.minimumScore)) query.status = "EXHAUSTED";
      for (const finding of findings) {
        const previous = session.products.find((item) => item.id === finding.id);
        if (!previous || previous.opportunityScore < finding.opportunityScore) {
          session.products = session.products.filter((item) => item.id !== finding.id).concat(finding);
        }
      }
      if (query.status !== "EXHAUSTED" && query.depth < PRODUCT_INTELLIGENCE_CONFIG.maxDepth) for (const derived of expand(query, ads)) {
        const normalized = normalizeQuery(derived);
        if (!seen.has(normalized)) { seen.add(normalized); session.queries.push(makeQuery(derived, "PRODUCT_NAME", query.rootQueryId, query.id, query.depth + 1)); }
      }
    } catch { query.status = "FAILED"; }
    session.queriesProcessed++;
    session.productsFound = session.products.length;
    session.advertisersFound = session.products.reduce((total, product) => total + product.advertiserCount, 0);
    session.qualifiedProductsFound = session.products.filter((product) => product.opportunityScore >= 70).length;
    session.currentDepth = Math.max(0, ...session.queries.filter((item) => item.status !== "PENDING").map((item) => item.depth));
    saveSession(session);
  }
  session.status = session.queries.some((q) => q.status === "PENDING") ? "LIMIT_REACHED" : "COMPLETED";
  for (const product of session.products) appendSnapshot({ productId: product.id, activeAds: product.activeAds, advertisers: product.advertiserCount, medianAdAge: product.oldestActiveAdDays, oldestAd: product.oldestActiveAdDays, newAds7d: Math.round(product.creativeVelocity / 18), newAds14d: Math.round(product.creativeVelocity / 12), creativeVelocity: product.creativeVelocity, opportunityScore: product.opportunityScore, momentum: product.momentum, lifecycle: product.lifecycle });
  saveSession(session);
  return session;
}

export async function resumeResearch(provider: AdSource, session: ResearchSession): Promise<ResearchSession> { return runResearch(provider, session.userQuery, session); }
