// ============================================================
// Scheduler de Meta Ads: trae los insights cada META_ADS_SYNC_HOURS
// (default 6 h) con lookback de 7 días — Meta ajusta cifras retroactivas.
// READ-ONLY hacia Meta; sin credenciales, el tick no hace nada.
// ============================================================

import pino from "pino";
import { acquireLease, releaseLease } from "../system/leases";
import { metaAdsEnabled } from "./config";
import { syncMetaAdsInsights } from "./sync";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export const LEASE_META_ADS = "meta-ads-sync";

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function runMetaAdsTick(): Promise<void> {
  if (!metaAdsEnabled()) return;
  if (ticking) return;
  ticking = true;
  const horas = Math.max(1, Number(process.env.META_ADS_SYNC_HOURS) || 6);
  if (!acquireLease(LEASE_META_ADS, Math.max(600, horas * 3600))) {
    ticking = false;
    return;
  }
  try {
    const report = await syncMetaAdsInsights({ lookbackDays: 7 });
    if (!report.skipped && report.errors.length > 0) {
      logger.warn(`[META-ADS] sync con errores: ${report.errors[0]}`);
    }
  } catch (err) {
    logger.warn(`[META-ADS] tick falló: ${err instanceof Error ? err.message : err}`);
  } finally {
    releaseLease(LEASE_META_ADS);
    ticking = false;
  }
}

export function startMetaAdsScheduler(): void {
  if (timer) return;
  if (!metaAdsEnabled()) {
    logger.info("[META-ADS] scheduler inactivo (faltan credenciales)");
    return;
  }
  const horas = Math.max(1, Number(process.env.META_ADS_SYNC_HOURS) || 6);
  logger.info(`[META-ADS] sync de insights activa (cada ${horas} h)`);
  void runMetaAdsTick();
  timer = setInterval(() => void runMetaAdsTick(), horas * 3600 * 1000);
}
