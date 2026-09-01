// ============================================================
// Persistencia de los snapshots diarios de Meta Ads (meta_ads_daily, v13)
// y su puente con daily_ad_spend (la tabla que consume la economía).
// ============================================================

import { systemDbHandle, upsertDailyAdSpend } from "../db";
import type { MetaAdsDailyRow, MetaAdsLevel } from "./types";

export function upsertMetaAdsDaily(row: MetaAdsDailyRow): void {
  systemDbHandle()
    .prepare(
      `INSERT INTO meta_ads_daily
         (day, level, entity_id, entity_name, spend, impressions, reach, clicks, ctr, cpc, cpm, actions_json, currency, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(day, level, entity_id) DO UPDATE SET
         entity_name = excluded.entity_name,
         spend = excluded.spend,
         impressions = excluded.impressions,
         reach = excluded.reach,
         clicks = excluded.clicks,
         ctr = excluded.ctr,
         cpc = excluded.cpc,
         cpm = excluded.cpm,
         actions_json = excluded.actions_json,
         currency = excluded.currency,
         synced_at = unixepoch()`
    )
    .run(
      row.day,
      row.level,
      row.entityId,
      row.entityName,
      row.spend,
      row.impressions,
      row.reach,
      row.clicks,
      row.ctr,
      row.cpc,
      row.cpm,
      row.actionsJson,
      row.currency
    );
}

export interface MetaAdsDailyDbRow {
  day: string;
  level: MetaAdsLevel;
  entity_id: string;
  entity_name: string | null;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  actions_json: string | null;
  currency: string | null;
  synced_at: number;
}

export function listMetaAdsDaily(params: { fromDay: string; toDay: string; level: MetaAdsLevel }): MetaAdsDailyDbRow[] {
  return systemDbHandle()
    .prepare("SELECT * FROM meta_ads_daily WHERE day >= ? AND day <= ? AND level = ? ORDER BY day, entity_id")
    .all(params.fromDay, params.toDay, params.level) as MetaAdsDailyDbRow[];
}

export function lastMetaAdsSyncAt(): number | null {
  const r = systemDbHandle().prepare("SELECT MAX(synced_at) AS t FROM meta_ads_daily").get() as { t: number | null };
  return r?.t ?? null;
}

/**
 * Puente hacia la economía: el gasto de nivel CUENTA de cada día se vuelca a
 * daily_ad_spend con source='meta_api'. El dato de la API SUSTITUYE al
 * manual del mismo día (decisión §39: cuando Meta conecta, manda la API;
 * la fila conserva source para saber de dónde salió cada cifra).
 */
export function bridgeMetaSpendToDailyAdSpend(rows: MetaAdsDailyRow[]): number {
  let dias = 0;
  for (const row of rows) {
    if (row.level !== "account" || row.spend === null) continue;
    upsertDailyAdSpend(row.day, row.spend, "meta_api");
    dias++;
  }
  return dias;
}
