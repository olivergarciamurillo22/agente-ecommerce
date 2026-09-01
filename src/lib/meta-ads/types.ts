// ============================================================
// Tipos de la integración READ-ONLY con la Marketing API de Meta.
// ============================================================

export type MetaAdsLevel = "account" | "campaign" | "adset" | "ad";

export const META_ADS_LEVELS: MetaAdsLevel[] = ["account", "campaign", "adset", "ad"];

/** Una fila de insights ya normalizada a nuestro snapshot diario. */
export interface MetaAdsDailyRow {
  /** YYYY-MM-DD (date_start de la fila; Meta reporta en el huso de la cuenta). */
  day: string;
  level: MetaAdsLevel;
  /** Id de la entidad (cuenta/campaña/adset/ad). */
  entityId: string;
  entityName: string | null;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  /** El array `actions` crudo de Meta (JSON), para métricas de compra futuras. */
  actionsJson: string | null;
  currency: string | null;
}

export interface MetaAdsAccountInfo {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}
