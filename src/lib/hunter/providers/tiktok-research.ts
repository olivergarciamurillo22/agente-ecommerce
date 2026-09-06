// ============================================================
// AI Winner Radar — PROVEEDOR TikTok Research API (opcional, tras aprobación).
//
// La Research API de TikTok NO se abre con darse de alta: exige una solicitud
// aprobada por TikTok. Por eso este proveedor tiene un estado propio,
// NOT_APPROVED, distinto de NOT_CONFIGURED: "no tengo credenciales" y "tengo
// credenciales pero no me dejan entrar" se arreglan de formas distintas, y
// mezclarlos haría perder el tiempo a quien lo lea.
//
// El client_secret se usa SOLO en servidor para pedir el token y JAMÁS se
// guarda en la base de datos (§7). El token vive en memoria del proceso.
//
// V1 NO depende de esto: si falta, el radar funciona igual con menos fuentes
// y la confianza baja sola.
// ============================================================

import { CallBudget, hunterFetch } from "../http";
import { normalizeExternalAd } from "../normalize";
import type { CapabilityStatus, HunterAd, ProviderCapability, ProviderHealth } from "../types";
import type { AdSearchQuery, AdSearchResponse, IntelligenceProvider, ProviderResult } from "./types";
import { noCapabilities, providerFail, providerOk } from "./types";

const PROVIDER = "tiktok_research" as const;
const BASE = "https://open.tiktokapis.com";

function clientKey(): string {
  return (process.env.TIKTOK_RESEARCH_CLIENT_KEY ?? "").trim();
}
function clientSecret(): string {
  return (process.env.TIKTOK_RESEARCH_CLIENT_SECRET ?? "").trim();
}
function configured(): boolean {
  return clientKey().length > 0 && clientSecret().length > 0;
}

/** Token en memoria: nunca a disco, nunca a la base. */
let cachedToken: { value: string; expiresAt: number } | null = null;

export function __clearTikTokTokenForTests(): void {
  cachedToken = null;
}

async function accessToken(budget?: CallBudget): Promise<{ token: string | null; error: string | null; status: number | null }> {
  if (!configured()) return { token: null, error: "TikTok Research no está configurado", status: null };
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return { token: cachedToken.value, error: null, status: null };

  const body = new URLSearchParams({
    client_key: clientKey(),
    client_secret: clientSecret(),
    grant_type: "client_credentials",
  });
  const res = await hunterFetch<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>({
    provider: PROVIDER,
    url: `${BASE}/v2/oauth/token/`,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // El cuerpo va como texto: hunterFetch serializa a JSON, así que se pasa
    // ya montado y se marca con la cabecera correcta.
    body: body.toString(),
    cacheTtlSeconds: 0,
    budget,
  });
  if (!res.ok || !res.data?.access_token) {
    return { token: null, error: res.data?.error_description ?? res.error ?? "no se pudo obtener el token", status: res.status };
  }
  cachedToken = { value: res.data.access_token, expiresAt: now + (res.data.expires_in ?? 7200) };
  return { token: cachedToken.value, error: null, status: 200 };
}

export class TikTokResearchProvider implements IntelligenceProvider {
  readonly id = PROVIDER;
  constructor(private readonly budget?: CallBudget) {}

  capabilities(): Record<ProviderCapability, CapabilityStatus> {
    if (!configured()) return noCapabilities();
    // UNVERIFIED: hasta que una cuenta aprobada responda, no se promete nada.
    return { ...noCapabilities(), TIKTOK_ADS: "UNVERIFIED" };
  }

  async health(): Promise<ProviderHealth> {
    const now = Math.floor(Date.now() / 1000);
    if (!configured()) {
      return {
        id: PROVIDER,
        status: "NOT_CONFIGURED",
        detail: "Faltan TIKTOK_RESEARCH_CLIENT_KEY y TIKTOK_RESEARCH_CLIENT_SECRET. Opcional: el radar funciona sin ellas.",
        capabilities: noCapabilities(),
        creditsRemaining: null,
        checkedAt: now,
      };
    }
    const { token, error, status } = await accessToken(this.budget);
    if (!token) {
      // 401/403 con credenciales presentes = solicitud sin aprobar.
      const notApproved = status === 401 || status === 403;
      return {
        id: PROVIDER,
        status: notApproved ? "NOT_APPROVED" : "ERROR",
        detail: notApproved
          ? "Las credenciales existen pero TikTok no ha aprobado el acceso a la Research API."
          : `No se pudo autenticar: ${error}`,
        capabilities: this.capabilities(),
        creditsRemaining: null,
        checkedAt: now,
      };
    }
    return {
      id: PROVIDER,
      status: "CONNECTED",
      detail: "Conectado a la Research API de TikTok.",
      capabilities: this.capabilities(),
      creditsRemaining: null,
      checkedAt: now,
    };
  }

  async searchAds(q: AdSearchQuery): Promise<ProviderResult<AdSearchResponse>> {
    const { token, error } = await accessToken(this.budget);
    if (!token) return providerFail(error ?? "sin token");
    const res = await hunterFetch<{ data?: { videos?: unknown[]; cursor?: number; has_more?: boolean } }>({
      provider: PROVIDER,
      url: `${BASE}/v2/research/adlib/ad/query/?fields=ad.id,ad.first_shown_date,ad.last_shown_date,advertiser.business_name,ad.videos`,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: {
        filters: { ad_published_date_range: {}, country_code: q.country.toUpperCase(), search_term: q.keywords },
        max_count: Math.min(q.limit ?? 20, 50),
      },
      cacheKey: `${PROVIDER}|${q.country}|${q.keywords}|${q.limit}`,
      cacheTtlSeconds: 1800,
      budget: this.budget,
    });
    if (!res.ok) return providerFail(res.error ?? "fallo", { status: res.status, calls: res.calls });
    const rows = Array.isArray(res.data?.data?.videos) ? (res.data!.data!.videos as unknown[]) : [];
    const ads = rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => this.toAd(r, q.country))
      .filter((a): a is HunterAd => a !== null);
    return providerOk({ ads, nextCursor: null }, { calls: res.calls, fromCache: res.fromCache });
  }

  private toAd(row: Record<string, unknown>, country: string): HunterAd | null {
    const id = row["ad.id"] ?? row.id;
    if (typeof id !== "string" && typeof id !== "number") return null;
    return normalizeExternalAd({
      provider: PROVIDER,
      externalId: String(id),
      platform: "tiktok",
      advertiserName: asString(row["advertiser.business_name"]),
      advertiserExternalId: null,
      productName: null,
      adCopy: null,
      format: "video",
      countries: [country.toUpperCase()],
      startedAt: asString(row["ad.first_shown_date"]),
      lastSeenAt: asString(row["ad.last_shown_date"]),
      active: null,
      activeDays: null,
      landingUrl: null,
      previewUrl: null,
      imageUrl: null,
      creativeIds: [],
      priceAmount: null,
      priceCurrency: null,
      raw: row,
    });
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
