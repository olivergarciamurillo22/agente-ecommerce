// ============================================================
// Salud de Meta Ads para el Control Center y la card de Ajustes.
// READ-ONLY sobre la base local: no llama a Meta.
// ============================================================

import { listDailyAdSpend, systemDbHandle } from "../db";
import { getServiceHealth } from "../system/repo";
import type { HealthStatus } from "../system/types";
import { metaAdsApiVersion, metaAdsCredentialsPresent, metaAdsVersionLagging, META_ADS_DEFAULT_API_VERSION } from "./config";

export interface MetaAdsHealth {
  status: HealthStatus;
  configured: boolean;
  apiVersion: string;
  versionLagging: boolean;
  lastApiSuccessAt: number | null;
  lastApiErrorAt: number | null;
  lastApiError: string | null;
  lastSyncAt: number | null;
  snapshotDays: number;
  /** Días de gasto en la ventana de 30d y de qué fuente. */
  spendDays30d: { meta: number; manual: number };
  message: string;
}

export function getMetaAdsHealth(): MetaAdsHealth {
  const health = getServiceHealth("meta_ads");

  const base: MetaAdsHealth = {
    status: "unknown",
    configured: metaAdsCredentialsPresent(),
    apiVersion: metaAdsApiVersion(),
    versionLagging: metaAdsVersionLagging(),
    lastApiSuccessAt: health?.last_success_at ?? null,
    lastApiErrorAt: health?.last_error_at ?? null,
    lastApiError: health?.last_error_message ?? null,
    lastSyncAt: null,
    snapshotDays: 0,
    spendDays30d: { meta: 0, manual: 0 },
    message: "",
  };

  try {
    const db = systemDbHandle();
    const r = db.prepare("SELECT MAX(synced_at) AS t, COUNT(DISTINCT day) AS d FROM meta_ads_daily").get() as {
      t: number | null;
      d: number;
    };
    base.lastSyncAt = r?.t ?? null;
    base.snapshotDays = r?.d ?? 0;
  } catch {
    /* tabla sin migrar: ceros */
  }
  const hoy = new Date();
  const hace30 = new Date(hoy.getTime() - 30 * 86400 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  for (const row of listDailyAdSpend(fmt(hace30), fmt(hoy))) {
    if (row.source === "meta_api") base.spendDays30d.meta++;
    else base.spendDays30d.manual++;
  }

  if (!base.configured) {
    base.status = "disabled";
    base.message =
      base.spendDays30d.manual > 0
        ? `sin conectar (gasto manual: ${base.spendDays30d.manual} día(s) en 30d) — pega META_ADS_ACCESS_TOKEN y META_ADS_ACCOUNT_ID`
        : "sin conectar y sin gasto manual: Finanzas no puede calcular ROAS";
  } else if (health?.status === "critical" || health?.status === "warning") {
    const esAuth = /token|190|permiso|ads_read/i.test(base.lastApiError ?? "");
    base.status = esAuth ? "critical" : health.status;
    base.message = base.lastApiError ?? "la Marketing API falló";
  } else if (!health || base.lastApiSuccessAt === null) {
    base.status = "unknown";
    base.message = "credenciales presentes pero sin ninguna llamada todavía (ejecuta meta-ads:doctor)";
  } else {
    base.status = "healthy";
    base.message = `conectado (${base.apiVersion}) · ${base.snapshotDays} día(s) de snapshots`;
  }

  if (base.status === "healthy" && base.versionLagging) {
    base.status = "warning";
    base.message += ` · versión ${base.apiVersion} por detrás de la vigente ${META_ADS_DEFAULT_API_VERSION}: revisar sunset`;
  }
  return base;
}
