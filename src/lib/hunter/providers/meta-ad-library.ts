// ============================================================
// AI Winner Radar — PROVEEDOR Meta Ad Library (oficial, opcional).
//
// GET https://graph.facebook.com/v{version}/ads_archive
//   access_token, search_terms (máx. 100 car.), ad_reached_countries,
//   ad_type=ALL, ad_active_status=ACTIVE|INACTIVE|ALL, fields, limit, after
//
// ══ LA TRAMPA QUE HAY QUE CONOCER (verificada el 06-09-2026) ══
// `ad_type=ALL` devuelve anuncios COMERCIALES **solo cuando
// `ad_reached_countries` apunta a un país de la UE o al Reino Unido**. Existe
// porque la DSA obliga, no porque Meta quisiera abrir esos datos. En
// cualquier otro país la MISMA llamada responde 200 con anuncios POLÍTICOS
// únicamente — sin error, sin aviso.
//
// Es la misma clase de trampa que `read_all_orders` en Shopify: la respuesta
// parece correcta y los datos son otra cosa. Por eso `assertCommercialScope`
// BLOQUEA la llamada fuera de UE/UK en vez de dejar que devuelva basura
// plausible. España es UE, así que el caso de Casamable funciona.
//
// Cuota: ~200 llamadas/hora por app en acceso estándar.
// El token NO se comparte con WhatsApp ni con Meta Ads: variable propia
// (META_AD_LIBRARY_ACCESS_TOKEN) para que revocar uno no tumbe los otros.
// ============================================================

import { CallBudget, hunterFetch } from "../http";
// Los constructores de enlace viven en `links.ts` porque también se usan en
// el navegador y este módulo arrastra la base de datos.
import { adLibraryPageUrl, adLibrarySearchUrl, captionDomain, normalizeDomain } from "../links";
import { normalizeExternalAd } from "../normalize";
import type { CapabilityStatus, HunterAd, ProviderCapability, ProviderHealth } from "../types";
import type { AdSearchQuery, AdSearchResponse, IntelligenceProvider, ProviderResult } from "./types";
import { noCapabilities, providerFail, providerOk } from "./types";

export { adLibraryPageUrl, adLibrarySearchUrl, captionDomain, normalizeDomain };

const PROVIDER = "meta_ad_library" as const;
const GRAPH = "https://graph.facebook.com";
const DEFAULT_VERSION = "v21.0";
/** Páginas por consulta. 3 × 25 ≈ 75 anuncios: suficiente para ver el mercado. */
const DEFAULT_PAGES = 3;
/** Techo duro: más allá de esto se gasta cuota sin aprender nada nuevo. */
const MAX_PAGES = 6;

/** UE + Reino Unido: los únicos donde `ad_type=ALL` trae anuncios comerciales. */
export const COMMERCIAL_SCOPE_COUNTRIES: readonly string[] = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "GB",
] as const;

export function isCommercialScopeCountry(country: string): boolean {
  return COMMERCIAL_SCOPE_COUNTRIES.includes(country.trim().toUpperCase());
}

/** Campos que la API entrega de verdad. Nada de ventas, ROAS ni gasto. */
const FIELDS = [
  "id",
  "ad_creation_time",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "ad_creative_bodies",
  "ad_creative_link_captions",
  "ad_creative_link_titles",
  "ad_creative_link_descriptions",
  "ad_snapshot_url",
  "page_id",
  "page_name",
  "publisher_platforms",
  "languages",
  "eu_total_reach",
  "target_locations",
].join(",");

function token(): string {
  return (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? "").trim();
}

interface GraphResponse {
  data?: unknown[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { message?: string; type?: string; code?: number };
}

export class MetaAdLibraryProvider implements IntelligenceProvider {
  readonly id = PROVIDER;
  constructor(private readonly budget?: CallBudget) {}

  capabilities(): Record<ProviderCapability, CapabilityStatus> {
    if (!token()) return noCapabilities();
    // AVAILABLE de verdad: el contrato de esta API es público y estable, a
    // diferencia del de WinningHunter, cuyo detalle está tras login.
    return { ...noCapabilities(), META_ADS: "AVAILABLE" };
  }

  async health(): Promise<ProviderHealth> {
    const now = Math.floor(Date.now() / 1000);
    if (!token()) {
      return {
        id: PROVIDER,
        status: "NOT_CONFIGURED",
        detail: "Falta META_AD_LIBRARY_ACCESS_TOKEN. Es opcional: el radar funciona sin ella.",
        capabilities: noCapabilities(),
        creditsRemaining: null,
        checkedAt: now,
      };
    }
    // Sonda mínima y barata: 1 anuncio en España.
    const res = await this.rawSearch({ keywords: "casa", country: "ES", limit: 1 });
    if (!res.ok) {
      return {
        id: PROVIDER,
        status: "ERROR",
        detail: res.error ?? "no se pudo consultar la Ad Library",
        capabilities: this.capabilities(),
        creditsRemaining: null,
        checkedAt: now,
      };
    }
    return {
      id: PROVIDER,
      status: "CONNECTED",
      detail: "Conectado. Anuncios comerciales solo en UE/Reino Unido (lo impone la DSA).",
      capabilities: this.capabilities(),
      creditsRemaining: null,
      checkedAt: now,
    };
  }

  async searchAds(q: AdSearchQuery): Promise<ProviderResult<AdSearchResponse>> {
    const scope = assertCommercialScope(q.country);
    if (scope) return providerFail(scope);

    // Meta pagina de 25 en 25 aunque pidas más, y un producto que va bien
    // tiene decenas de anuncios repartidos entre marcas. Quedarse en la
    // primera página hace que un mercado activo parezca uno muerto — que es
    // justo el error que arruina la puntuación de saturación.
    const paginas = Math.max(1, Math.min(q.pages ?? DEFAULT_PAGES, MAX_PAGES));
    const acumulados: HunterAd[] = [];
    let cursor = q.cursor ?? null;
    let llamadas = 0;
    let deCache = true;
    let ultimoError: ProviderResult<AdSearchResponse> | null = null;

    for (let i = 0; i < paginas; i++) {
      const res = await this.rawSearch({ ...q, cursor });
      llamadas += res.calls;
      if (!res.ok || !res.data) {
        // Con páginas ya recogidas, un fallo tardío NO tira la consulta: se
        // devuelve lo que hay. Perder 60 anuncios buenos por un 429 en la
        // cuarta página sería tirar llamadas ya pagadas.
        if (acumulados.length > 0) break;
        ultimoError = res;
        break;
      }
      if (!res.fromCache) deCache = false;
      acumulados.push(...res.data.ads);
      cursor = res.data.nextCursor;
      if (!cursor || res.data.ads.length === 0) break;
    }

    if (acumulados.length === 0 && ultimoError) return ultimoError;
    return providerOk(
      { ads: acumulados, nextCursor: cursor },
      { calls: llamadas, fromCache: deCache && llamadas > 0 }
    );
  }

  private async rawSearch(q: AdSearchQuery): Promise<ProviderResult<AdSearchResponse>> {
    if (!token()) return providerFail("Meta Ad Library no está configurada");
    const version = (process.env.META_AD_LIBRARY_API_VERSION ?? DEFAULT_VERSION).trim();
    const params = new URLSearchParams({
      access_token: token(),
      // `ALL` es lo que trae anuncios comerciales; sin esto solo hay políticos.
      ad_type: "ALL",
      ad_reached_countries: JSON.stringify([q.country.toUpperCase()]),
      search_terms: q.keywords.slice(0, 100),
      ad_active_status: q.activeOnly === false ? "ALL" : "ACTIVE",
      fields: FIELDS,
      limit: String(Math.min(q.limit ?? 25, 100)),
    });
    if (q.cursor) params.set("after", q.cursor);

    const res = await hunterFetch<GraphResponse>({
      provider: PROVIDER,
      url: `${GRAPH}/${version}/ads_archive?${params.toString()}`,
      // La clave viaja en la query (lo exige Graph), pero la caché se indexa
      // SIN ella: si no, el token acabaría escrito en la tabla de caché.
      cacheKey: `${PROVIDER}|${version}|${q.country}|${q.keywords}|${q.activeOnly}|${q.limit}|${q.cursor ?? ""}`,
      cacheTtlSeconds: 1800,
      budget: this.budget,
      // Cuota de ~200/hora: 1,2 s entre llamadas deja margen de sobra.
      config: { minIntervalMs: 1200 },
    });

    if (!res.ok) {
      return providerFail(sanitizeGraphError(res.error), { status: res.status, calls: res.calls });
    }
    const payload = res.data;
    if (payload?.error) {
      return providerFail(sanitizeGraphError(payload.error.message ?? "error de Graph"), { status: res.status, calls: res.calls });
    }
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const ads = rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => this.toAd(r, q.country))
      .filter((a): a is HunterAd => a !== null);

    return providerOk(
      { ads, nextCursor: payload?.paging?.cursors?.after ?? null },
      { calls: res.calls, fromCache: res.fromCache }
    );
  }

  private toAd(row: Record<string, unknown>, country: string): HunterAd | null {
    const id = typeof row.id === "string" ? row.id : null;
    if (!id) return null;
    const bodies = Array.isArray(row.ad_creative_bodies) ? (row.ad_creative_bodies as unknown[]) : [];
    const titles = Array.isArray(row.ad_creative_link_titles) ? (row.ad_creative_link_titles as unknown[]) : [];
    const platforms = Array.isArray(row.publisher_platforms) ? (row.publisher_platforms as unknown[]) : [];
    const stop = typeof row.ad_delivery_stop_time === "string" ? row.ad_delivery_stop_time : null;

    return normalizeExternalAd({
      provider: PROVIDER,
      externalId: id,
      platform: typeof platforms[0] === "string" ? (platforms[0] as string) : "facebook",
      advertiserName: typeof row.page_name === "string" ? row.page_name : null,
      advertiserExternalId: typeof row.page_id === "string" ? row.page_id : null,
      productName: typeof titles[0] === "string" ? (titles[0] as string) : null,
      adCopy: typeof bodies[0] === "string" ? (bodies[0] as string) : null,
      // La Ad Library no dice si es vídeo o imagen: `null`, no una suposición.
      format: null,
      countries: [country.toUpperCase()],
      startedAt: typeof row.ad_delivery_start_time === "string" ? row.ad_delivery_start_time : null,
      lastSeenAt: stop,
      active: stop === null,
      activeDays: null,
      // Meta NO da la URL de destino, pero sí el dominio que se enseña en el
      // anuncio (`ad_creative_link_captions`). Es menos, y es cierto: se
      // guarda eso en vez de inventar una URL completa que nadie ha visto.
      landingUrl: captionDomain(row.ad_creative_link_captions),
      previewUrl: typeof row.ad_snapshot_url === "string" ? row.ad_snapshot_url : null,
      // La Ad Library no entrega la imagen del creativo por API. Dejarlo en
      // null y que la ficha lo diga es mejor que enseñar un icono genérico
      // haciéndolo pasar por el producto.
      imageUrl: null,
      creativeIds: [],
      priceAmount: null,
      priceCurrency: null,
      raw: row,
    });
  }
}

/**
 * Devuelve el motivo del bloqueo, o `null` si el país sí sirve. Preferimos
 * negarnos a consultar antes que devolver anuncios políticos disfrazados de
 * investigación de producto.
 */
export function assertCommercialScope(country: string): string | null {
  if (isCommercialScopeCountry(country)) return null;
  return (
    `La Ad Library solo entrega anuncios COMERCIALES en la UE y Reino Unido (lo impone la DSA). ` +
    `Para ${country.toUpperCase()} la misma consulta devolvería únicamente anuncios políticos, sin avisar. ` +
    `Consulta bloqueada a propósito.`
  );
}

/** Un mensaje de Graph puede llevar el token: se recorta antes de guardarlo. */
function sanitizeGraphError(msg: string | null): string {
  if (!msg) return "error desconocido de la Ad Library";
  return msg.replace(/access_token=[^&\s]+/gi, "access_token=<oculto>").slice(0, 300);
}
