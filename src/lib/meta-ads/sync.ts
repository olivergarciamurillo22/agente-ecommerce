// ============================================================
// Sincronización de insights de Meta Ads → snapshots locales.
// READ-ONLY hacia Meta; escribe SOLO tablas locales de métricas
// (meta_ads_daily + puente a daily_ad_spend). No toca pedidos.
// ============================================================

import pino from "pino";
import { businessDay } from "../time";
import { logIntegrationEvent, recordSchedulerRun } from "../system/repo";
import { getDailyInsights } from "./client";
import { metaAdsEnabled } from "./config";
import { bridgeMetaSpendToDailyAdSpend, upsertMetaAdsDaily } from "./repo";
import type { MetaAdsDailyRow, MetaAdsLevel } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export interface MetaAdsSyncDeps {
  getDailyInsights: typeof getDailyInsights;
  now: () => Date;
}

const defaultDeps: MetaAdsSyncDeps = { getDailyInsights, now: () => new Date() };

export interface MetaAdsSyncReport {
  skipped: boolean;
  skippedReason?: string;
  since: string;
  until: string;
  rowsByLevel: Record<string, number>;
  spendDaysBridged: number;
  errors: string[];
}

function dayShift(day: string, deltaDays: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Trae los últimos `lookbackDays` días (por defecto 7: Meta ajusta cifras
 * retroactivamente los primeros días) a los 4 niveles y los persiste.
 */
export async function syncMetaAdsInsights(
  opts: { lookbackDays?: number; levels?: MetaAdsLevel[] } = {},
  deps: MetaAdsSyncDeps = defaultDeps
): Promise<MetaAdsSyncReport> {
  const until = businessDay(deps.now().getTime());
  const since = dayShift(until, -(opts.lookbackDays ?? 7));
  const levels = opts.levels ?? (["account", "campaign", "adset", "ad"] as MetaAdsLevel[]);
  const report: MetaAdsSyncReport = { skipped: false, since, until, rowsByLevel: {}, spendDaysBridged: 0, errors: [] };

  if (!metaAdsEnabled()) {
    return { ...report, skipped: true, skippedReason: "faltan META_ADS_ACCESS_TOKEN / META_ADS_ACCOUNT_ID" };
  }

  const startedAt = Math.floor(deps.now().getTime() / 1000);
  let accountRows: MetaAdsDailyRow[] = [];
  for (const level of levels) {
    try {
      const rows = await deps.getDailyInsights({ level, since, until });
      for (const row of rows) upsertMetaAdsDaily(row);
      report.rowsByLevel[level] = rows.length;
      if (level === "account") accountRows = rows;
    } catch (err) {
      report.errors.push(`${level}: ${err instanceof Error ? err.message : "error"}`);
    }
  }

  if (accountRows.length > 0) {
    report.spendDaysBridged = bridgeMetaSpendToDailyAdSpend(accountRows);
  }

  recordSchedulerRun("meta-ads-sync", {
    startedAt,
    finishedAt: Math.floor(deps.now().getTime() / 1000),
    status: report.errors.length === 0 ? "ok" : "error",
    processedCount: Object.values(report.rowsByLevel).reduce((a, b) => a + b, 0),
    errorCount: report.errors.length,
    lastError: report.errors[0] ?? null,
  });
  if (report.errors.length > 0) {
    logIntegrationEvent("meta_ads", "sync_error", "warning", report.errors[0]);
  }
  logger.info(`[META-ADS] sync ${since}..${until}: ${JSON.stringify(report.rowsByLevel)} · ${report.spendDaysBridged} días de gasto`);
  return report;
}
