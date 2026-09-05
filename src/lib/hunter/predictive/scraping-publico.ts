import type { PredictiveSearchProvider, PredictiveSearchRequest, PublicSourceName, PublicSourceStatus, SearchEvidence } from "./types";

export const PUBLIC_SEARCH_USER_AGENT = "Casamable-Hunter-Predictivo/1.0 (+https://casamable.com/contacto)";
export const PUBLIC_SEARCH_TIMEOUT_MS = 7_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

interface SiteSpec { source: PublicSourceName; host: string; searchUrl(query: string): string }
const SITES: SiteSpec[] = [
  { source: "aliexpress", host: "www.aliexpress.com", searchUrl: (q) => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}` },
  { source: "1688", host: "s.1688.com", searchUrl: (q) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(q)}` },
  { source: "alibaba", host: "www.alibaba.com", searchUrl: (q) => `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(q)}` },
];

export interface PublicSiteResult extends PublicSourceStatus { evidence: SearchEvidence[] }

const cleanText = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const round2 = (n: number) => Math.round(n * 100) / 100;

function euroPrices(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/(?:EUR|€)\s*([0-9]+(?:[.,][0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s*(?:EUR|€)/gi)) {
    const value = Number((match[1] ?? match[2]).replace(",", "."));
    if (Number.isFinite(value) && value > 0 && value < 100_000) values.push(value);
  }
  return values;
}

function visibleQuantity(text: string): number {
  const match = /\b(500|100)\s*(?:units?|pieces?|pcs|uds|unidades?)\b/i.exec(text);
  return match ? Number(match[1]) : 1;
}

export function extractPublicSearchResults(html: string, spec: SiteSpec, limit: number, now: number): SearchEvidence[] {
  const evidence: SearchEvidence[] = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,2500}?)<\/a>/gi;
  for (const match of html.matchAll(anchor)) {
    if (evidence.length >= limit) break;
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), `https://${spec.host}`);
      if (url.protocol !== "https:" || !url.hostname.endsWith(spec.host.split(".").slice(-2).join("."))) continue;
      const inertText = cleanText(match[2]);
      const prices = euroPrices(inertText);
      if (!prices.length) continue;
      evidence.push({
        kind: "wholesale", sourceUrl: url.toString().slice(0, 2048), sourceDomain: spec.host,
        title: inertText.slice(0, 200), priceEur: round2(prices.reduce((sum, price) => sum + price, 0) / prices.length),
        quantity: visibleQuantity(inertText), weightGrams: null, observedAt: now,
      });
    } catch { /* enlace no valido: dato descartado */ }
  }
  return evidence;
}

function blockedReason(response: Response, html: string): string | null {
  if (response.status === 403 || response.status === 401 || response.status === 429) return `HTTP ${response.status}`;
  const target = response.url || response.headers.get("location") || "";
  if (/login|signin|passport/i.test(target)) return "redireccion a login";
  if (/captcha|verify you are human|robot check|security verification|滑动验证|验证码/i.test(html)) return "captcha detectado";
  if (cleanText(html).length < 10) return "contenido vacio";
  return null;
}

async function searchSite(spec: SiteSpec, query: string, limit: number, fetcher: typeof fetch): Promise<PublicSiteResult> {
  const url = spec.searchUrl(query);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { headers: { "user-agent": PUBLIC_SEARCH_USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(PUBLIC_SEARCH_TIMEOUT_MS) });
      if (!response.ok && response.status !== 429 && response.status < 500) return { source: spec.source, status: "no_disponible", reason: `HTTP ${response.status}`, resultCount: 0, evidence: [] };
      if (!response.ok) { if (attempt === 0) continue; return { source: spec.source, status: "no_disponible", reason: `HTTP ${response.status}`, resultCount: 0, evidence: [] }; }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) return { source: spec.source, status: "no_disponible", reason: "respuesta demasiado grande", resultCount: 0, evidence: [] };
      const html = (await response.text()).slice(0, MAX_HTML_BYTES);
      const blocked = blockedReason(response, html);
      if (blocked) return { source: spec.source, status: "no_disponible", reason: blocked, resultCount: 0, evidence: [] };
      const evidence = extractPublicSearchResults(html, spec, limit, Math.floor(Date.now() / 1000));
      if (!evidence.length) return { source: spec.source, status: "no_disponible", reason: "sin precios EUR visibles", resultCount: 0, evidence: [] };
      return { source: spec.source, status: "disponible", reason: null, resultCount: evidence.length, evidence };
    } catch (error) {
      if (attempt === 0) continue;
      const timeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return { source: spec.source, status: "no_disponible", reason: timeout ? "timeout" : "error de red", resultCount: 0, evidence: [] };
    }
  }
  return { source: spec.source, status: "no_disponible", reason: "error de red", resultCount: 0, evidence: [] };
}

export const searchAliExpressPublic = (query: string, limit: number, fetcher: typeof fetch = fetch) => searchSite(SITES[0], query, limit, fetcher);
export const search1688Public = (query: string, limit: number, fetcher: typeof fetch = fetch) => searchSite(SITES[1], query, limit, fetcher);
export const searchAlibabaPublic = (query: string, limit: number, fetcher: typeof fetch = fetch) => searchSite(SITES[2], query, limit, fetcher);

export class PublicScrapingSearchProvider implements PredictiveSearchProvider {
  readonly available = process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE === "scraping_publico";
  readonly mechanism = this.available ? "scraping_publico" : null;
  private report: PublicSourceStatus[] = [];
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  sourceStatuses(): PublicSourceStatus[] { return [...this.report]; }

  async search(request: PredictiveSearchRequest): Promise<SearchEvidence[]> {
    if (!this.available || request.kind === "retail") return [];
    const configured = Number(process.env.HUNTER_PREDICTIVE_PUBLIC_RESULT_LIMIT ?? 10);
    const limit = Number.isFinite(configured) ? Math.min(20, Math.max(1, Math.trunc(configured))) : 10;
    const results = await Promise.all([
      searchAliExpressPublic(request.query, limit, this.fetcher),
      search1688Public(request.query, limit, this.fetcher),
      searchAlibabaPublic(request.query, limit, this.fetcher),
    ]);
    this.report = results.map(({ evidence: _evidence, ...status }) => status);
    return results.flatMap((result) => result.evidence);
  }
}
