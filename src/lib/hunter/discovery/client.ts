import { META_ADS_DEFAULT_API_VERSION } from "../../meta-ads/config";
import { ADLIB_FIELDS, type AdLibraryAd, type AdLibraryPage } from "./types";
import { AdLibraryError, asAdLibraryError, backoffMs } from "./errors";
import { DiscoveryBudget, mergeRateLimits, type StopReason } from "./budget";

const TIMEOUT_MS = 20_000;
const PAGE_DELAY_MS = 1_000;
const MAX_PAGES = 20;
/** Reintentos ante rate limit o fallo temporal. El camino SIN error no cambia. */
const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 2000)) : [];
const bound = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const range = (v: unknown): { lowerBound: number | null; upperBound: number | null } | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { lowerBound: bound(o.lower_bound), upperBound: bound(o.upper_bound) };
};

function normalize(raw: unknown): AdLibraryAd | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || (typeof o.page_id !== "string" && typeof o.page_id !== "number")) return null;
  return {
    id: o.id, pageId: String(o.page_id), pageName: typeof o.page_name === "string" ? o.page_name.slice(0, 200) : null,
    snapshotUrl: typeof o.ad_snapshot_url === "string" ? o.ad_snapshot_url.slice(0, 2048) : null,
    bodies: strings(o.ad_creative_bodies), captions: strings(o.ad_creative_link_captions), titles: strings(o.ad_creative_link_titles),
    platforms: strings(o.publisher_platforms), languages: strings(o.languages),
    creationTime: typeof o.ad_creation_time === "string" ? o.ad_creation_time : null,
    startTime: typeof o.ad_delivery_start_time === "string" ? o.ad_delivery_start_time : null,
    stopTime: typeof o.ad_delivery_stop_time === "string" ? o.ad_delivery_stop_time : null,
    impressions: range(o.impressions), audience: range(o.estimated_audience_size),
  };
}

function parseUsage(headers: Headers): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const name of ["x-app-usage", "x-business-use-case-usage", "x-ad-account-usage"]) {
    const value = headers.get(name); if (!value) continue;
    try { out[name] = JSON.parse(value); } catch { out[name] = value.slice(0, 500); }
  }
  return Object.keys(out).length ? out : null;
}

export class AdLibraryClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch, private readonly wait = sleep) {}
  async page(params: { term: string; country: string; since: string; until: string; after?: string; fields?: readonly string[] }): Promise<AdLibraryPage> {
    const version = process.env.META_AD_LIBRARY_API_VERSION || process.env.META_GRAPH_API_VERSION || process.env.META_ADS_API_VERSION || META_ADS_DEFAULT_API_VERSION;
    const url = new URL(`https://graph.facebook.com/${version}/ads_archive`);
    url.searchParams.set("search_terms", params.term); url.searchParams.set("ad_reached_countries", JSON.stringify([params.country]));
    url.searchParams.set("ad_type", "ALL"); url.searchParams.set("ad_active_status", "ACTIVE");
    url.searchParams.set("ad_delivery_date_min", params.since); url.searchParams.set("ad_delivery_date_max", params.until);
    url.searchParams.set("fields", (params.fields ?? ADLIB_FIELDS).join(",")); url.searchParams.set("limit", "100");
    if (params.after) url.searchParams.set("after", params.after);
    const response = await this.fetcher(url, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const payload = await response.json() as { data?: unknown[]; paging?: { cursors?: { after?: string }; next?: string }; error?: { message?: string; code?: number } };
    if (!response.ok) {
      // Mismo texto que antes (hay diagnósticos escritos que lo citan), pero
      // ahora clasificado: quien lo recibe sabe si esperar, parar o rendirse.
      throw new AdLibraryError(
        response.status,
        typeof payload.error?.code === "number" ? payload.error.code : null,
        `Meta ads_archive HTTP ${response.status}${payload.error?.code ? ` code ${payload.error.code}` : ""}: ${(payload.error?.message ?? "error").slice(0, 250)}`
      );
    }
    return { ads: (payload.data ?? []).map(normalize).filter((x): x is AdLibraryAd => x !== null), after: payload.paging?.next && payload.paging.cursors?.after ? payload.paging.cursors.after : null, rateLimit: parseUsage(response.headers) };
  }
  /**
   * Una petición con reintentos ante rate limit o fallo temporal. Un token
   * inválido o un permiso que falta NO se reintentan: se propagan para que la
   * corrida pare de inmediato en vez de quemar la cuota.
   */
  private async pageWithRetry(params: Parameters<AdLibraryClient["page"]>[0], budget: DiscoveryBudget | null): Promise<AdLibraryPage> {
    let ultimo: AdLibraryError | null = null;
    for (let intento = 0; intento <= MAX_RETRIES; intento++) {
      try {
        budget?.spend();
        return await this.page(params);
      } catch (err) {
        const error = asAdLibraryError(err);
        ultimo = error;
        if (!error.retryable || intento === MAX_RETRIES) throw error;
        const espera = backoffMs(intento);
        // No tiene sentido esperar más de lo que queda de presupuesto.
        if (budget && budget.remainingMs() < espera) throw error;
        await this.wait(espera);
      }
    }
    throw ultimo ?? new AdLibraryError(0, null, "sin respuesta de Meta");
  }

  /**
   * Pagina un término hasta agotarlo, el tope de páginas o el presupuesto.
   * NUNCA lanza por rate limit: devuelve lo obtenido con su `stopReason`, que
   * es lo que permite persistir una corrida parcial en vez de perderla entera.
   * Un token inválido sí se propaga (no hay nada que salvar reintentando).
   */
  async search(params: {
    term: string; country: string; since: string; until: string; fields?: readonly string[];
    budget?: DiscoveryBudget; maxPages?: number;
  }): Promise<{ ads: AdLibraryAd[]; rateLimit: Record<string, unknown> | null; stopReason: StopReason; pages: number }> {
    const ads: AdLibraryAd[] = []; let after: string | undefined; let rateLimit: Record<string, unknown> | null = null;
    const budget = params.budget ?? null;
    const maxPages = params.maxPages ?? MAX_PAGES;
    let stopReason: StopReason = "completado";
    let pages = 0;
    for (let page = 0; page < maxPages; page++) {
      const freno = budget?.check() ?? null;
      if (freno) { stopReason = freno; break; }
      if (page > 0) await this.wait(PAGE_DELAY_MS);
      let result: AdLibraryPage;
      try {
        result = await this.pageWithRetry({ ...params, after }, budget);
      } catch (err) {
        const error = asAdLibraryError(err);
        if (error.abortRun) throw error;
        stopReason = error.kind === "rate_limit" ? "rate_limit" : "error";
        break;
      }
      pages++;
      ads.push(...result.ads);
      rateLimit = mergeRateLimits(rateLimit, result.rateLimit);
      budget?.observeRateLimit(result.rateLimit);
      if (!result.after) break;
      after = result.after;
    }
    return { ads, rateLimit, stopReason, pages };
  }
}

export interface FieldProbe { field: string; status: "datos" | "vacio" | "error"; error: string | null }

/** Prueba campo a campo: un opcional rechazado no inutiliza la consulta. */
export async function probeAdLibraryFields(client: AdLibraryClient, params: { term: string; country: string; since: string; until: string }, wait: (ms: number) => Promise<void> = sleep): Promise<FieldProbe[]> {
  const probes: FieldProbe[] = [];
  for (const field of ADLIB_FIELDS) {
    try {
      const page = await client.page({ ...params, fields: field === "id" || field === "page_id" ? ["id", "page_id"] : ["id", "page_id", field] });
      const hasData = page.ads.some((ad) => {
        if (field === "id" || field === "page_id") return true;
        if (field === "page_name") return ad.pageName !== null;
        if (field === "ad_snapshot_url") return ad.snapshotUrl !== null;
        if (field === "ad_creation_time") return ad.creationTime !== null;
        if (field === "ad_delivery_start_time") return ad.startTime !== null;
        if (field === "ad_delivery_stop_time") return ad.stopTime !== null;
        if (field === "ad_creative_bodies") return ad.bodies.length > 0;
        if (field === "ad_creative_link_captions") return ad.captions.length > 0;
        if (field === "ad_creative_link_titles") return ad.titles.length > 0;
        if (field === "publisher_platforms") return ad.platforms.length > 0;
        if (field === "languages") return ad.languages.length > 0;
        if (field === "impressions") return ad.impressions !== null;
        if (field === "estimated_audience_size") return ad.audience !== null;
        return false;
      });
      probes.push({ field, status: hasData ? "datos" : "vacio", error: null });
    } catch (error) {
      probes.push({ field, status: "error", error: error instanceof Error ? error.message.slice(0, 300) : "error" });
    }
    await wait(250);
  }
  return probes;
}
