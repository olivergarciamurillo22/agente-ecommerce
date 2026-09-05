import type { EstimatedRange, PredictiveEconomics, PreliminaryVerdict, PriceEvidence, RawAd } from "./types";

export type EvidenceKind = "wholesale" | "retail";
export interface PredictiveEvidence extends PriceEvidence { kind: EvidenceKind }
export interface PredictiveProvider {
  readonly available: boolean;
  readonly mechanism: string | null;
  search(input: { query: string; kind: EvidenceKind; competitorUrl?: string | null }): Promise<PredictiveEvidence[]>;
  sourceStatuses?(): PredictiveEconomics["supplierStatuses"];
}

const TTL_MS = 30 * 86400000;
const round2 = (value: number) => Math.round(value * 100) / 100;

function range(evidence: PredictiveEvidence[], now: string): EstimatedRange | null {
  if (!evidence.length) return null;
  const bySource = new Map<string, number[]>();
  for (const item of evidence) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item.priceEur]);
  const means = [...bySource.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  const prices = evidence.map((item) => item.priceEur).sort((a, b) => a - b);
  return {
    min: round2(prices[0]), max: round2(prices.at(-1)!), probable: round2(means.reduce((sum, value) => sum + value, 0) / means.length),
    confidence: bySource.size === 1 ? "LOW" : "MEDIUM", sourceType: "ESTIMATED",
    sources: evidence.map((item) => ({ ...item, observedAt: item.observedAt || now })),
  };
}

function forQuantity(evidence: PredictiveEvidence[], target: 100 | 500): PredictiveEvidence[] {
  const selected = new Map<string, PredictiveEvidence>();
  for (const item of evidence.filter((entry) => entry.kind === "wholesale")) {
    if (item.quantity !== null && item.quantity > target) continue;
    const previous = selected.get(item.source);
    if (!previous || (item.quantity ?? 1) > (previous.quantity ?? 1)) selected.set(item.source, item);
  }
  return [...selected.values()];
}

export function observedRetailEvidence(ads: RawAd[]): PredictiveEvidence[] {
  return ads.flatMap((ad) => {
    if (!ad.price || ad.price <= 0 || !ad.landingUrl) return [];
    try { return [{ kind: "retail" as const, source: new URL(ad.landingUrl).hostname, url: ad.landingUrl, priceEur: ad.price, quantity: 1, weightGrams: null, observedAt: ad.fetchedAt ?? ad.normalizedAt ?? new Date().toISOString() }]; }
    catch { return []; }
  });
}

export async function estimatePredictiveEconomics(query: string, provider: PredictiveProvider, ads: RawAd[] = [], now = new Date()): Promise<{ economics: PredictiveEconomics; verdict: PreliminaryVerdict | null; expiresAt: string }> {
  const errors: string[] = [];
  let wholesale: PredictiveEvidence[] = [];
  let retail = observedRetailEvidence(ads);
  if (provider.available) {
    const [wholesaleResult, retailResult] = await Promise.allSettled([
      provider.search({ query, kind: "wholesale" }), provider.search({ query, kind: "retail", competitorUrl: ads.find((ad) => ad.landingUrl)?.landingUrl }),
    ]);
    if (wholesaleResult.status === "fulfilled") wholesale = wholesaleResult.value; else errors.push("supplier_search_failed");
    if (retailResult.status === "fulfilled") retail = [...retail, ...retailResult.value]; else errors.push("retail_search_failed");
  } else errors.push("predictive_search_off");
  const observedAt = now.toISOString();
  const costAt100 = range(forQuantity(wholesale, 100), observedAt);
  const costAt500 = range(forQuantity(wholesale, 500), observedAt);
  const pvp = range(retail.filter((item) => item.kind === "retail"), observedAt);
  const weights = [...wholesale, ...retail].map((item) => item.weightGrams).filter((value): value is number => value !== null && value > 0);
  const worstWeight = weights.length ? Math.max(...weights) : null;
  const logistics = worstWeight === null ? null : worstWeight <= 1000 ? 6.48 : worstWeight <= 4000 ? 8.9 : null;
  const contributionMarginMin = costAt500 && pvp && logistics !== null ? round2(pvp.min - costAt500.max - logistics) : null;
  const contributionMarginMax = costAt500 && pvp && logistics !== null ? round2(pvp.max - costAt500.min - logistics) : null;
  let verdict: PreliminaryVerdict | null = null;
  if (contributionMarginMin !== null && contributionMarginMax !== null) verdict = contributionMarginMax <= 0 ? "DESCARTAR" : contributionMarginMin >= 8 ? "CANDIDATO_FUERTE" : "INVESTIGAR";
  const supplierCount = new Set((costAt500 ?? costAt100)?.sources.map((item) => item.source) ?? []).size;
  const missingData = [...errors, ...(!costAt100 ? ["coste_100"] : []), ...(!costAt500 ? ["coste_500"] : []), ...(!pvp ? ["pvp"] : []), ...(logistics === null ? ["peso_logistico"] : [])];
  return {
    economics: {
      costAt100, costAt500, pvp, contributionMarginMin, contributionMarginMax,
      confidence: supplierCount === 0 ? "SIN_DATOS" : supplierCount === 1 ? "LOW" : "MEDIUM",
      sourceType: "ESTIMATED", supplierStatuses: provider.sourceStatuses?.() ?? [], missingData: [...new Set(missingData)],
    },
    verdict,
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };
}

export class OffPredictiveProvider implements PredictiveProvider {
  readonly available = false;
  readonly mechanism = null;
  async search(): Promise<PredictiveEvidence[]> { return []; }
}

export class HttpPredictiveProvider implements PredictiveProvider {
  readonly available: boolean;
  readonly mechanism: string | null;
  private readonly endpoint = process.env.HUNTER_PREDICTIVE_SEARCH_API_URL?.trim() || null;
  constructor(private readonly fetcher: typeof fetch = fetch) { this.available = Boolean(this.endpoint); this.mechanism = this.available ? "api" : null; }
  async search(input: { query: string; kind: EvidenceKind; competitorUrl?: string | null }): Promise<PredictiveEvidence[]> {
    if (!this.endpoint) return [];
    const response = await this.fetcher(this.endpoint, {
      method: "POST", headers: { "content-type": "application/json", ...(process.env.HUNTER_PREDICTIVE_SEARCH_API_TOKEN ? { authorization: `Bearer ${process.env.HUNTER_PREDICTIVE_SEARCH_API_TOKEN}` } : {}) },
      body: JSON.stringify(input), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`predictive search HTTP ${response.status}`);
    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    return (payload.results ?? []).flatMap((item) => {
      try {
        const url = new URL(String(item.url ?? "")); const priceEur = Number(item.priceEur);
        if (url.protocol !== "https:" || !Number.isFinite(priceEur) || priceEur <= 0) return [];
        return [{ kind: input.kind, source: url.hostname, url: url.toString(), priceEur, quantity: Number(item.quantity) > 0 ? Number(item.quantity) : null, weightGrams: Number(item.weightGrams) > 0 ? Number(item.weightGrams) : null, observedAt: new Date().toISOString() }];
      } catch { return []; }
    });
  }
}

export function configuredPredictiveProvider(): PredictiveProvider {
  return process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE === "scraping_publico" ? new PublicSupplierProvider() : process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE === "api" ? new HttpPredictiveProvider() : new OffPredictiveProvider();
}

export const PUBLIC_SEARCH_USER_AGENT = "Casamable-Hunter-Predictivo/1.0 (+https://casamable.com/contacto)";
const PUBLIC_TIMEOUT_MS = 7000;
type SupplierName = "AliExpress" | "1688" | "Alibaba";
interface SupplierSpec { name: SupplierName; host: string; url(query: string): string }
const SUPPLIERS: SupplierSpec[] = [
  { name: "AliExpress", host: "aliexpress.com", url: (query) => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(query)}` },
  { name: "1688", host: "1688.com", url: (query) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(query)}` },
  { name: "Alibaba", host: "alibaba.com", url: (query) => `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(query)}` },
];

const inertText = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
function blocked(response: Response, html: string): string | null {
  if ([401, 403, 429].includes(response.status)) return `HTTP ${response.status}`;
  if (/login|signin|passport/i.test(response.url || response.headers.get("location") || "")) return "redireccion a login";
  if (/captcha|verify you are human|robot check|security verification/i.test(html)) return "captcha detectado";
  return inertText(html).length < 10 ? "contenido vacio" : null;
}

export function parseSupplierHtml(html: string, spec: SupplierSpec, limit = 10, observedAt = new Date().toISOString()): PredictiveEvidence[] {
  const output: PredictiveEvidence[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,2500}?)<\/a>/gi)) {
    if (output.length >= limit) break;
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), `https://www.${spec.host}`);
      if (!url.hostname.endsWith(spec.host)) continue;
      const text = inertText(match[2]);
      const priceMatch = /(?:EUR|€)\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:EUR|€)/i.exec(text);
      const priceEur = Number((priceMatch?.[1] ?? priceMatch?.[2] ?? "").replace(",", "."));
      if (!Number.isFinite(priceEur) || priceEur <= 0) continue;
      const quantityMatch = /\b(100|500)\s*(?:units?|pieces?|pcs|uds|unidades?)\b/i.exec(text);
      output.push({ kind: "wholesale", source: spec.name, url: url.toString(), priceEur, quantity: quantityMatch ? Number(quantityMatch[1]) : 1, weightGrams: null, observedAt });
    } catch { /* fuente de terceros no válida */ }
  }
  return output;
}

async function searchSupplier(spec: SupplierSpec, query: string, fetcher: typeof fetch, limit: number): Promise<{ status: PredictiveEconomics["supplierStatuses"][number]; evidence: PredictiveEvidence[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(spec.url(query), { headers: { "user-agent": PUBLIC_SEARCH_USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS) });
      if (!response.ok && response.status < 500 && response.status !== 429) return { status: { source: spec.name, status: "NO_DISPONIBLE", reason: `HTTP ${response.status}` }, evidence: [] };
      if (!response.ok) { if (!attempt) continue; return { status: { source: spec.name, status: "NO_DISPONIBLE", reason: `HTTP ${response.status}` }, evidence: [] }; }
      const html = (await response.text()).slice(0, 2 * 1024 * 1024); const reason = blocked(response, html);
      if (reason) return { status: { source: spec.name, status: "NO_DISPONIBLE", reason }, evidence: [] };
      const evidence = parseSupplierHtml(html, spec, limit);
      return evidence.length ? { status: { source: spec.name, status: "DISPONIBLE", reason: null }, evidence } : { status: { source: spec.name, status: "NO_DISPONIBLE", reason: "sin precios EUR visibles" }, evidence: [] };
    } catch (error) {
      if (!attempt) continue;
      const timeout = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      return { status: { source: spec.name, status: "NO_DISPONIBLE", reason: timeout ? "timeout" : "error de red" }, evidence: [] };
    }
  }
  return { status: { source: spec.name, status: "NO_DISPONIBLE", reason: "error de red" }, evidence: [] };
}

export const searchAliExpressPublic = (query: string, fetcher: typeof fetch = fetch, limit = 10) => searchSupplier(SUPPLIERS[0], query, fetcher, limit);
export const search1688Public = (query: string, fetcher: typeof fetch = fetch, limit = 10) => searchSupplier(SUPPLIERS[1], query, fetcher, limit);
export const searchAlibabaPublic = (query: string, fetcher: typeof fetch = fetch, limit = 10) => searchSupplier(SUPPLIERS[2], query, fetcher, limit);

export class PublicSupplierProvider implements PredictiveProvider {
  readonly available = process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE === "scraping_publico";
  readonly mechanism = this.available ? "scraping_publico" : null;
  private statuses: PredictiveEconomics["supplierStatuses"] = [];
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  sourceStatuses() { return [...this.statuses]; }
  async search(input: { query: string; kind: EvidenceKind }): Promise<PredictiveEvidence[]> {
    if (!this.available || input.kind === "retail") return [];
    const configured = Number(process.env.HUNTER_PREDICTIVE_PUBLIC_RESULT_LIMIT ?? 10); const limit = Number.isFinite(configured) ? Math.max(1, Math.min(20, Math.trunc(configured))) : 10;
    const results = await Promise.all([searchAliExpressPublic(input.query, this.fetcher, limit), search1688Public(input.query, this.fetcher, limit), searchAlibabaPublic(input.query, this.fetcher, limit)]);
    this.statuses = results.map((result) => result.status);
    return results.flatMap((result) => result.evidence);
  }
}
