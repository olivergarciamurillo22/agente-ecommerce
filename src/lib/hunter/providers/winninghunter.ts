// ============================================================
// AI Winner Radar — PROVEEDOR WinningHunter.
//
// DOCUMENTACIÓN VERIFICADA el 06-09-2026 en https://app.winninghunter.com/docs
// y /docs/api (ver docs/product-hunter/PROVIDERS.md). Lo comprobado:
//
//   Base            https://app.winninghunter.com
//   Auth            X-API-Key: wh_...   (también acepta Bearer y ?api_key=)
//   Ritmo           60 peticiones/minuto
//   Coste           1 crédito por llamada medida
//   Paginación      token opaco 'scroll'; limit por defecto 20, máximo 50
//
//   GET  /api/v1/credits                      saldo de créditos (cuesta 1)
//   GET  /api/v1/adlibrary                    anuncios de Facebook/Instagram
//   GET  /api/v1/tiktok-ads                   anuncios de TikTok
//   GET  /api/v1/tiktok-ads/{id}              detalle de un anuncio
//   POST /api/v1/magic-ai                     anuncios similares (texto/imagen)
//   POST /api/v1/landers/explore              biblioteca de landings
//   GET  /api/v1/brands                       marcas seguidas
//   POST /api/v1/store-explorer               búsqueda de tiendas Shopify
//   POST /api/v1/tiktok-shop/products/explore productos de TikTok Shop
//   POST /api/v1/trends/...                   tendencias
//
// LO QUE NO ESTÁ VERIFICADO — y por eso el mapeo es DEFENSIVO:
// el detalle por endpoint (nombres exactos de parámetros y de campos de la
// respuesta) vive tras el login de la app y devolvió 404 sin sesión. Así que
// `normalizeAd` prueba VARIOS nombres candidatos por campo y deja `null` lo
// que no encuentre, en vez de asumir una forma y producir filas vacías que
// parezcan datos. `npm run hunter:providers:test` confirma la forma real en
// cuanto haya una clave, y ahí es donde estas capacidades pasan de
// UNVERIFIED a AVAILABLE. Inventar el resto sería exactamente lo que este
// módulo promete no hacer.
// ============================================================

import { CallBudget, hunterFetch } from "../http";
import type {
  AdSearchQuery,
  AdSearchResponse,
  ExternalProduct,
  ExternalStore,
  IntelligenceProvider,
  ProductSearchQuery,
  ProviderResult,
  StoreSearchQuery,
  TrendPoint,
  TrendQuery,
} from "./types";
import { noCapabilities, providerFail, providerOk } from "./types";
import type { CapabilityStatus, HunterAd, ProviderCapability, ProviderHealth } from "../types";
import { adFingerprint, normalizeExternalAd } from "../normalize";

const BASE = "https://app.winninghunter.com";
const PROVIDER = "winninghunter" as const;

/** Los anuncios cambian despacio: media hora de caché ahorra créditos sin mentir. */
const ADS_CACHE_TTL = 1800;
const CREDITS_CACHE_TTL = 300;

function apiKey(): string {
  return (process.env.WINNINGHUNTER_API_KEY ?? "").trim();
}

function headers(): Record<string, string> {
  return { "X-API-Key": apiKey(), "content-type": "application/json" };
}

export class WinningHunterProvider implements IntelligenceProvider {
  readonly id = PROVIDER;
  constructor(private readonly budget?: CallBudget) {}

  capabilities(): Record<ProviderCapability, CapabilityStatus> {
    const configured = apiKey().length > 0;
    if (!configured) return noCapabilities();
    // UNVERIFIED, no AVAILABLE: el endpoint existe en la documentación pero
    // nadie ha visto su respuesta desde este repo. Prometer datos que no se
    // han visto llegar es el error que este módulo evita.
    const u: CapabilityStatus = "UNVERIFIED";
    return {
      ...noCapabilities(),
      META_ADS: u,
      TIKTOK_ADS: u,
      TIKTOK_SHOP: u,
      SHOPIFY_STORES: u,
      TRENDS: u,
      LANDERS: u,
      BRANDS: u,
      SIMILAR_AD_SEARCH: u,
    };
  }

  async health(): Promise<ProviderHealth> {
    const now = Math.floor(Date.now() / 1000);
    if (!apiKey()) {
      return {
        id: PROVIDER,
        status: "NOT_CONFIGURED",
        detail: "Falta WINNINGHUNTER_API_KEY en el entorno.",
        capabilities: noCapabilities(),
        creditsRemaining: null,
        checkedAt: now,
      };
    }
    const res = await hunterFetch<Record<string, unknown>>({
      provider: PROVIDER,
      url: `${BASE}/api/v1/credits`,
      headers: headers(),
      cacheTtlSeconds: CREDITS_CACHE_TTL,
      budget: this.budget,
    });
    if (!res.ok) {
      return {
        id: PROVIDER,
        status: "ERROR",
        // El mensaje describe el fallo, jamás la clave ni un fragmento suyo.
        detail: res.status === 401 ? "La clave fue rechazada (401). Revisa WINNINGHUNTER_API_KEY." : `No se pudo consultar el saldo: ${res.error}`,
        capabilities: this.capabilities(),
        creditsRemaining: null,
        checkedAt: now,
      };
    }
    const credits = pickNumber(res.data, ["credits", "remaining", "credits_remaining", "balance", "available"]);
    return {
      id: PROVIDER,
      status: "CONNECTED",
      detail: credits === null ? "Conectado (el saldo no vino en la respuesta)." : `Conectado · ${credits} créditos disponibles.`,
      capabilities: this.capabilities(),
      creditsRemaining: credits,
      checkedAt: now,
    };
  }

  async searchAds(q: AdSearchQuery): Promise<ProviderResult<AdSearchResponse>> {
    if (!apiKey()) return providerFail("WinningHunter no está configurado");
    const params = new URLSearchParams({
      keyword: q.keywords,
      country: q.country,
      limit: String(Math.min(q.limit ?? 25, 50)),
    });
    if (q.activeOnly) params.set("active", "true");
    if (q.cursor) params.set("scroll", q.cursor);
    const res = await hunterFetch<Record<string, unknown>>({
      provider: PROVIDER,
      url: `${BASE}/api/v1/adlibrary?${params.toString()}`,
      headers: headers(),
      cacheTtlSeconds: ADS_CACHE_TTL,
      budget: this.budget,
    });
    if (!res.ok) return providerFail(res.error ?? "fallo", { status: res.status, calls: res.calls });
    const rows = pickArray(res.data);
    const ads = rows.map((r) => this.toAd(r, "facebook")).filter((a): a is HunterAd => a !== null);
    return providerOk(
      { ads, nextCursor: pickString(res.data, ["scroll", "next_scroll", "next_cursor", "cursor"]) },
      { calls: res.calls, credits: res.fromCache ? 0 : res.calls, fromCache: res.fromCache }
    );
  }

  async searchProducts(q: ProductSearchQuery): Promise<ProviderResult<ExternalProduct[]>> {
    if (!apiKey()) return providerFail("WinningHunter no está configurado");
    const res = await hunterFetch<Record<string, unknown>>({
      provider: PROVIDER,
      url: `${BASE}/api/v1/tiktok-shop/products/explore`,
      method: "POST",
      headers: headers(),
      body: { country: q.country, period: "30d", limit: Math.min(q.limit ?? 20, 50), keyword: q.keywords },
      cacheTtlSeconds: ADS_CACHE_TTL,
      budget: this.budget,
    });
    if (!res.ok) return providerFail(res.error ?? "fallo", { status: res.status, calls: res.calls });
    const products = pickArray(res.data).map(toExternalProduct);
    return providerOk(products, { calls: res.calls, credits: res.fromCache ? 0 : res.calls, fromCache: res.fromCache });
  }

  async searchStores(q: StoreSearchQuery): Promise<ProviderResult<ExternalStore[]>> {
    if (!apiKey()) return providerFail("WinningHunter no está configurado");
    const res = await hunterFetch<Record<string, unknown>>({
      provider: PROVIDER,
      url: `${BASE}/api/v1/store-explorer`,
      method: "POST",
      headers: headers(),
      body: { keyword: q.keywords, country: q.country, limit: Math.min(q.limit ?? 20, 50) },
      cacheTtlSeconds: ADS_CACHE_TTL,
      budget: this.budget,
    });
    if (!res.ok) return providerFail(res.error ?? "fallo", { status: res.status, calls: res.calls });
    const stores = pickArray(res.data).map((r) => ({
      externalId: String(pickString(r, ["id", "store_id", "domain"]) ?? ""),
      name: pickString(r, ["name", "store_name", "title"]) ?? "(sin nombre)",
      domain: pickString(r, ["domain", "url", "website"]),
      platform: pickString(r, ["platform"]) ?? "shopify",
      raw: r,
    }));
    return providerOk(stores, { calls: res.calls, credits: res.fromCache ? 0 : res.calls, fromCache: res.fromCache });
  }

  async searchTrends(q: TrendQuery): Promise<ProviderResult<TrendPoint[]>> {
    if (!apiKey()) return providerFail("WinningHunter no está configurado");
    const res = await hunterFetch<Record<string, unknown>>({
      provider: PROVIDER,
      url: `${BASE}/api/v1/trends/search`,
      method: "POST",
      headers: headers(),
      body: { query: q.keyword, country: q.country ?? null },
      cacheTtlSeconds: 3600,
      budget: this.budget,
    });
    if (!res.ok) return providerFail(res.error ?? "fallo", { status: res.status, calls: res.calls });
    const points = pickArray(res.data).map((r) => ({
      keyword: pickString(r, ["keyword", "topic", "name", "query"]) ?? q.keyword,
      score: pickNumber(r, ["score", "value", "interest", "growth"]),
      direction: normalizeDirection(pickString(r, ["direction", "trend", "status"])),
      raw: r,
    }));
    return providerOk(points, { calls: res.calls, credits: res.fromCache ? 0 : res.calls, fromCache: res.fromCache });
  }

  private toAd(row: Record<string, unknown>, platformHint: string): HunterAd | null {
    const externalId = pickString(row, ["id", "ad_id", "adArchiveID", "ad_archive_id", "adId"]);
    if (!externalId) return null;
    const ad = normalizeExternalAd({
      provider: PROVIDER,
      externalId,
      platform: pickString(row, ["platform", "publisher_platform"]) ?? platformHint,
      advertiserName: pickString(row, ["page_name", "advertiser", "brand", "brand_name", "pageName"]),
      advertiserExternalId: pickString(row, ["page_id", "advertiser_id", "brand_id", "pageId"]),
      productName: pickString(row, ["product_name", "title", "product", "headline"]),
      adCopy: pickString(row, ["body", "ad_copy", "text", "description", "caption"]),
      format: pickString(row, ["format", "media_type", "creative_type", "type"]),
      countries: pickStringArray(row, ["countries", "country", "reached_countries"]),
      startedAt: pickString(row, ["start_date", "started_at", "ad_delivery_start_time", "created_at", "first_seen"]),
      lastSeenAt: pickString(row, ["last_seen", "last_seen_at", "updated_at", "end_date"]),
      active: pickBoolean(row, ["active", "is_active", "running"]),
      activeDays: pickNumber(row, ["days_active", "active_days", "duration_days", "running_days"]),
      landingUrl: pickString(row, ["landing_url", "link", "url", "destination_url", "link_url"]),
      previewUrl: pickString(row, ["ad_url", "preview_url", "snapshot_url", "permalink"]),
      imageUrl: pickString(row, ["image", "image_url", "thumbnail", "thumbnail_url", "media_url"]),
      creativeIds: pickStringArray(row, ["creative_ids", "creatives", "variations"]),
      priceAmount: pickNumber(row, ["price", "product_price", "amount"]),
      priceCurrency: pickString(row, ["currency", "price_currency"]),
      raw: row,
    });
    return ad;
  }
}

// --- Extractores tolerantes ---------------------------------------------
// Prueban varios nombres porque la forma exacta no está verificada. Devuelven
// `null` cuando no encuentran nada: un `null` honesto vale más que un 0 falso.

export function pickString(o: unknown, keys: string[]): string | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export function pickNumber(o: unknown, keys: string[]): number | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v.replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function pickBoolean(o: unknown, keys: string[]): boolean | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "boolean") return v;
    if (v === "true" || v === 1) return true;
    if (v === "false" || v === 0) return false;
  }
  return null;
}

export function pickStringArray(o: unknown, keys: string[]): string[] {
  if (!o || typeof o !== "object") return [];
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) {
      return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as Record<string, unknown>).id ?? "") : String(x))).filter(Boolean);
    }
    if (typeof v === "string" && v.trim()) return [v.trim()];
  }
  return [];
}

/**
 * La lista de resultados puede venir en la raíz o envuelta. Se prueban los
 * envoltorios habituales antes de rendirse.
 */
export function pickArray(o: unknown): Record<string, unknown>[] {
  if (Array.isArray(o)) return o.filter(isRecord);
  if (!o || typeof o !== "object") return [];
  const rec = o as Record<string, unknown>;
  for (const k of ["data", "results", "items", "ads", "products", "stores", "rows", "hits", "list"]) {
    const v = rec[k];
    if (Array.isArray(v)) return v.filter(isRecord);
  }
  return [];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function normalizeDirection(s: string | null): "rising" | "flat" | "falling" | null {
  if (!s) return null;
  const n = s.toLowerCase();
  if (/ris|up|grow|subiendo/.test(n)) return "rising";
  if (/fall|down|declin|bajando/.test(n)) return "falling";
  if (/flat|stable|plano/.test(n)) return "flat";
  return null;
}

function toExternalProduct(r: Record<string, unknown>): ExternalProduct {
  return {
    externalId: pickString(r, ["id", "product_id", "sku"]) ?? "",
    name: pickString(r, ["name", "title", "product_name"]) ?? "(sin nombre)",
    category: pickString(r, ["category", "category_name"]),
    imageUrl: pickString(r, ["image", "image_url", "thumbnail"]),
    priceMin: pickNumber(r, ["price_min", "min_price", "price"]),
    priceMax: pickNumber(r, ["price_max", "max_price", "price"]),
    currency: pickString(r, ["currency"]),
    // Lo marca el tipo y lo repite la UI: esto lo ESTIMA un tercero.
    estimatedSales: pickNumber(r, ["sales", "sold_count", "estimated_sales", "sales_count"]),
    shopCount: pickNumber(r, ["shop_count", "shops", "sellers"]),
    raw: r,
  };
}

export { adFingerprint };
