// ============================================================
// Cliente READ-ONLY de la Marketing API de Meta.
//
// SOLO métodos GET. El token viaja en la cabecera Authorization (nunca en
// la URL: las URLs acaban en logs) y JAMÁS se imprime ni se incluye en un
// mensaje de error.
// ============================================================

import { metaAdsConfig } from "./config";
import type { MetaAdsAccountInfo, MetaAdsDailyRow, MetaAdsLevel } from "./types";

export class MetaAdsApiError extends Error {
  readonly httpStatus: number;
  /** Código de error de la Graph API (p.ej. 190 = token inválido). */
  readonly graphCode: number | null;
  constructor(params: { message: string; httpStatus: number; graphCode?: number | null }) {
    super(params.message);
    this.name = "MetaAdsApiError";
    this.httpStatus = params.httpStatus;
    this.graphCode = params.graphCode ?? null;
  }
}

async function metaGet<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const config = metaAdsConfig();
  if (!config) throw new MetaAdsApiError({ message: "faltan META_ADS_ACCESS_TOKEN / META_ADS_ACCOUNT_ID", httpStatus: 0 });

  const url = new URL(`${config.baseUrl}/${config.apiVersion}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${config.accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    registrarSalud(false, `sin respuesta de Meta (${path})`);
    throw new MetaAdsApiError({
      message: `no se pudo contactar con Meta: ${err instanceof Error ? err.message : "error de red"}`,
      httpStatus: 0,
    });
  }

  const texto = await res.text();
  let json: unknown = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const errObj =
      typeof json === "object" && json !== null && "error" in json ? ((json as { error: Record<string, unknown> }).error ?? {}) : {};
    const code = typeof errObj.code === "number" ? errObj.code : null;
    const msg = typeof errObj.message === "string" ? errObj.message.slice(0, 250) : `HTTP ${res.status}`;
    const humano =
      code === 190
        ? "token de Meta Ads inválido o caducado"
        : code === 100
          ? "petición rechazada por Meta (¿id de cuenta correcto?)"
          : code === 10 || code === 200 || code === 294
            ? "el token no tiene permiso ads_read sobre esta cuenta"
            : "error de la Marketing API";
    const error = new MetaAdsApiError({ message: `${humano}: ${msg}`, httpStatus: res.status, graphCode: code });
    registrarSalud(false, error.message);
    throw error;
  }

  registrarSalud(true);
  return json as T;
}

/** Datos básicos de la cuenta: existencia, divisa y huso (para el doctor). */
export async function getAccountInfo(): Promise<MetaAdsAccountInfo> {
  const config = metaAdsConfig();
  if (!config) throw new MetaAdsApiError({ message: "sin credenciales", httpStatus: 0 });
  const data = await metaGet<Record<string, unknown>>(`/act_${config.accountId}`, {
    fields: "id,name,currency,timezone_name",
  });
  return {
    id: String(data.id ?? `act_${config.accountId}`),
    name: typeof data.name === "string" ? data.name : null,
    currency: typeof data.currency === "string" ? data.currency : null,
    timezone: typeof data.timezone_name === "string" ? data.timezone_name : null,
  };
}

/** Permisos del token (el doctor comprueba ads_read). */
export async function getTokenPermissions(): Promise<Array<{ permission: string; status: string }>> {
  const data = await metaGet<{ data?: Array<{ permission: string; status: string }> }>(`/me/permissions`);
  return data.data ?? [];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

interface InsightsRawRow {
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  actions?: unknown;
  account_currency?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
}

/**
 * Insights diarios (time_increment=1) para un rango, a un nivel dado.
 * Devuelve filas ya normalizadas al snapshot. Pagina con `after`.
 */
export async function getDailyInsights(params: {
  level: MetaAdsLevel;
  /** YYYY-MM-DD, inclusive. */
  since: string;
  until: string;
}): Promise<MetaAdsDailyRow[]> {
  const config = metaAdsConfig();
  if (!config) throw new MetaAdsApiError({ message: "sin credenciales", httpStatus: 0 });

  const idFields =
    params.level === "campaign"
      ? "campaign_id,campaign_name,"
      : params.level === "adset"
        ? "adset_id,adset_name,"
        : params.level === "ad"
          ? "ad_id,ad_name,"
          : "";
  const fields = `${idFields}spend,impressions,reach,clicks,ctr,cpc,cpm,actions,account_currency`;

  const rows: MetaAdsDailyRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 30; page++) {
    const data = await metaGet<{ data?: InsightsRawRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      `/act_${config.accountId}/insights`,
      {
        level: params.level,
        time_increment: 1,
        time_range: JSON.stringify({ since: params.since, until: params.until }),
        fields,
        limit: 500,
        after,
      }
    );
    for (const r of data.data ?? []) {
      const day = r.date_start;
      if (!day) continue;
      const entityId =
        params.level === "campaign" ? r.campaign_id : params.level === "adset" ? r.adset_id : params.level === "ad" ? r.ad_id : config.accountId;
      const entityName =
        params.level === "campaign" ? r.campaign_name : params.level === "adset" ? r.adset_name : params.level === "ad" ? r.ad_name : "cuenta";
      if (!entityId) continue;
      rows.push({
        day,
        level: params.level,
        entityId,
        entityName: entityName ?? null,
        spend: num(r.spend),
        impressions: num(r.impressions),
        reach: num(r.reach),
        clicks: num(r.clicks),
        ctr: num(r.ctr),
        cpc: num(r.cpc),
        cpm: num(r.cpm),
        actionsJson: r.actions !== undefined ? JSON.stringify(r.actions) : null,
        currency: r.account_currency ?? null,
      });
    }
    if (!data.paging?.next || !data.paging.cursors?.after) break;
    after = data.paging.cursors.after;
  }
  return rows;
}

function registrarSalud(ok: boolean, error?: string): void {
  void import("../system/repo")
    .then((repo) => {
      repo.recordServiceCheck("meta_ads", { status: ok ? "healthy" : "warning", ok, error });
    })
    .catch(() => {
      /* best-effort */
    });
}
