import { META_AD_LIBRARY_CONFIG } from "../config";
import type { AdSearchOptions, AdSource, ProviderStatus, RawAd } from "../types";

type MetaResponse = { data?: Record<string, unknown>[]; paging?: { next?: string; cursors?: { after?: string } }; error?: { code?: number; message?: string } };
const FIELDS = ["id", "page_id", "page_name", "ad_creation_time", "ad_delivery_start_time", "ad_delivery_stop_time", "ad_snapshot_url", "ad_creative_bodies", "ad_creative_link_titles", "ad_creative_link_descriptions", "publisher_platforms", "languages", "target_locations", "eu_total_reach", "age_country_gender_reach_breakdown"].join(",");

function firstText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return Array.isArray(value) ? value.find((item): item is string => typeof item === "string" && Boolean(item.trim()))?.trim() : undefined;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/token|secret|authorization/i.test(key)).map(([key, child]) => [key, sanitize(child)]));
}

export function normalizeMetaAd(payload: Record<string, unknown>): RawAd | null {
  const adId = firstText(payload.id);
  const startedAt = firstText(payload.ad_delivery_start_time) ?? firstText(payload.ad_creation_time);
  if (!adId || !startedAt) return null;
  return {
    id: adId,
    advertiserId: firstText(payload.page_id) ?? "unknown",
    advertiserName: firstText(payload.page_name) ?? "Anunciante desconocido",
    pageId: firstText(payload.page_id),
    copy: firstText(payload.ad_creative_bodies) ?? "",
    productName: firstText(payload.ad_creative_link_titles),
    title: firstText(payload.ad_creative_link_titles),
    description: firstText(payload.ad_creative_link_descriptions),
    landingUrl: firstText(payload.ad_snapshot_url),
    startedAt,
    endedAt: firstText(payload.ad_delivery_stop_time),
    active: !firstText(payload.ad_delivery_stop_time),
    platforms: Array.isArray(payload.publisher_platforms) ? payload.publisher_platforms.filter((item): item is string => typeof item === "string") : [],
    provider: "META_AD_LIBRARY",
    rawProviderPayload: sanitize(payload) as Record<string, unknown>,
    providerVersion: "META_AD_LIBRARY_GRAPH",
    normalizerVersion: "1.0.0",
    normalizedAt: new Date().toISOString(),
  };
}

export class MetaAdLibraryUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "MetaAdLibraryUnavailableError"; }
}

export class MetaAdLibraryProvider implements AdSource {
  private calls = 0;
  private callHistory: number[] = [];
  private cooldownUntil = 0;
  private lastSuccessfulScan?: string;
  private readonly token = process.env.META_AD_LIBRARY_ACCESS_TOKEN?.trim();
  private readonly apiVersion = process.env.META_GRAPH_API_VERSION?.trim();
  constructor(private readonly limits: { maxPages?: number; maxCalls?: number; maxRetries?: number } = {}) {}

  status(): ProviderStatus {
    const missing = [!this.token && "META_AD_LIBRARY_ACCESS_TOKEN", !this.apiVersion && "META_GRAPH_API_VERSION"].filter(Boolean);
    return missing.length
      ? { source: "META_AD_LIBRARY", available: false, configured: false, code: "META_NOT_CONFIGURED", authorization: "NOT_CONFIGURED", researchAvailable: false, apiVersion: this.apiVersion, reason: `Configuración ausente: ${missing.join(", ")}` }
      : { source: "META_AD_LIBRARY", available: false, configured: true, code: "META_CONFIGURED_UNAUTHORIZED", authorization: "PENDING", researchAvailable: false, apiVersion: this.apiVersion, reason: "Meta Ad Library authorization pending", lastSuccessfulScan: this.lastSuccessfulScan };
  }

  async healthCheck(): Promise<ProviderStatus> {
    const base = this.status(); const attemptedAt = new Date().toISOString();
    if (!base.configured) return { ...base, lastConnectionAttempt: attemptedAt };
    try {
      await this.search({ query: "healthcheck", country: META_AD_LIBRARY_CONFIG.country, activeStatus: "ACTIVE", limit: 1 });
      return { ...this.status(), available: true, code: "META_CONNECTED", authorization: "CONNECTED", researchAvailable: true, reason: undefined, lastConnectionAttempt: attemptedAt, lastSuccessfulScan: this.lastSuccessfulScan };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido";
      if (/permission|not authorized|authorization/i.test(message)) return { ...base, available: false, code: "META_CONFIGURED_UNAUTHORIZED", authorization: "PENDING", researchAvailable: false, reason: "Meta Ad Library authorization pending", lastConnectionAttempt: attemptedAt };
      if (/rate|cooldown|429|code 4|code 17|613/i.test(message)) return { ...base, available: false, code: "META_RATE_LIMITED", authorization: "RATE_LIMITED", researchAvailable: false, reason: "Meta Ad Library rate limited", lastConnectionAttempt: attemptedAt };
      return { ...base, available: false, code: "META_ERROR", authorization: "ERROR", researchAvailable: false, reason: "Meta Ad Library connection error", lastConnectionAttempt: attemptedAt };
    }
  }

  async searchAds(query: string): Promise<RawAd[]> { return this.search({ query }); }

  async search(options: AdSearchOptions): Promise<RawAd[]> {
    this.assertAvailable();
    const country = options.country ?? META_AD_LIBRARY_CONFIG.country;
    const countries = country === "EU" ? ["ES", "PT", "IT", "FR", "DE"] : [country];
    const maximum = Math.min(options.limit ?? META_AD_LIBRARY_CONFIG.maxAdsPerQuery, META_AD_LIBRARY_CONFIG.maxAdsPerQuery);
    const ads: RawAd[] = [];
    let after: string | undefined;
    for (let page = 0; page < (this.limits.maxPages ?? META_AD_LIBRARY_CONFIG.maxPages) && ads.length < maximum; page++) {
      this.useCall();
      const url = this.baseUrl();
      url.searchParams.set("search_terms", options.query); // Texto exacto del usuario en la primera llamada.
      this.setCommonParams(url, countries, options);
      url.searchParams.set("limit", String(Math.min(100, maximum - ads.length)));
      if (after) url.searchParams.set("after", after);
      const payload = await this.request(url);
      for (const raw of payload.data ?? []) { const ad = normalizeMetaAd(raw); if (ad && !ads.some((item) => item.id === ad.id)) ads.push(ad); }
      after = payload.paging?.cursors?.after;
      if (!payload.paging?.next || !after || !payload.data?.length) break;
    }
    this.lastSuccessfulScan = new Date().toISOString();
    return ads;
  }

  async getAdvertiserAds(pageId: string, options: Omit<AdSearchOptions, "query"> = {}): Promise<RawAd[]> {
    this.assertAvailable(); this.useCall();
    const country = options.country ?? META_AD_LIBRARY_CONFIG.country;
    const url = this.baseUrl();
    url.searchParams.set("search_page_ids", JSON.stringify([pageId]));
    this.setCommonParams(url, country === "EU" ? ["ES", "PT", "IT", "FR", "DE"] : [country], options);
    url.searchParams.set("limit", String(Math.min(100, options.limit ?? 100)));
    const payload = await this.request(url);
    return (payload.data ?? []).map(normalizeMetaAd).filter((ad): ad is RawAd => Boolean(ad));
  }

  private baseUrl() { return new URL(`https://graph.facebook.com/${this.apiVersion}/ads_archive`); }
  private setCommonParams(url: URL, countries: string[], options: Omit<AdSearchOptions, "query">) {
    url.searchParams.set("ad_reached_countries", JSON.stringify(countries));
    url.searchParams.set("ad_active_status", options.activeStatus ?? "ACTIVE");
    url.searchParams.set("ad_type", "ALL"); url.searchParams.set("fields", FIELDS);
    if (options.mediaType && options.mediaType !== "ALL") url.searchParams.set("media_type", options.mediaType);
  }
  private assertAvailable() {
    if (!this.token || !this.apiVersion) throw new MetaAdLibraryUnavailableError("Meta Ad Library configuration missing");
    if (Date.now() < this.cooldownUntil) throw new MetaAdLibraryUnavailableError("Provider temporalmente en cooldown por rate limit");
  }
  private useCall() {
    const now = Date.now(); this.callHistory = this.callHistory.filter((timestamp) => now - timestamp < 3600000);
    if (this.callHistory.length >= META_AD_LIBRARY_CONFIG.maxCallsPerHour) throw new MetaAdLibraryUnavailableError("Presupuesto horario del provider agotado");
    if (this.calls >= (this.limits.maxCalls ?? META_AD_LIBRARY_CONFIG.maxProviderCallsPerCycle)) throw new MetaAdLibraryUnavailableError("Presupuesto de llamadas del ciclo agotado");
    this.calls++; this.callHistory.push(now);
  }
  private async request(url: URL): Promise<MetaResponse> {
    const retries = this.limits.maxRetries ?? META_AD_LIBRARY_CONFIG.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), META_AD_LIBRARY_CONFIG.requestTimeoutMs);
      try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as MetaResponse;
        if (response.ok) return payload;
        const limited = response.status === 429 || [4, 17, 613].includes(payload.error?.code ?? 0);
        if (!limited || attempt === retries) throw new MetaAdLibraryUnavailableError(`Meta Ad Library HTTP ${response.status}: ${payload.error?.message ?? "error sin detalle"}`);
        const delay = Math.min(META_AD_LIBRARY_CONFIG.cooldownSeconds * 1000, 1000 * 2 ** attempt + Math.floor(Math.random() * 300)); this.cooldownUntil = Date.now() + delay;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        if (error instanceof MetaAdLibraryUnavailableError || attempt === retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10000, 500 * 2 ** attempt)));
      } finally { clearTimeout(timeout); }
    }
    throw new MetaAdLibraryUnavailableError("Meta Ad Library no respondió");
  }
}
