// ============================================================
// Salud de la integración con Beeping para el Control Center y la card de
// Ajustes. READ-ONLY sobre la base local (service_health + orders): NUNCA
// llama a la API — eso lo hacen el doctor y la reconciliación.
// ============================================================

import { getSetting, systemDbHandle } from "../db";
import { countIntegrationEvents, getServiceHealth } from "../system/repo";
import type { HealthStatus } from "../system/types";
import { beepingAutoReleaseEnabled, beepingCredentialsPresent, beepingEnabled, beepingWriteEnabled, cachedBeepingShopName } from "./config";

export interface BeepingHealth {
  status: HealthStatus;
  configured: boolean;
  enabled: boolean;
  writeEnabled: boolean;
  /** SIEMPRE false hoy; el toggle vive bloqueado hasta el piloto real. */
  autoRelease: boolean;
  shopName: string | null;
  lastApiSuccessAt: number | null;
  lastApiErrorAt: number | null;
  lastApiError: string | null;
  lastSyncCheckpointAt: number | null;
  /** Pedidos con foto de Beeping, por status crudo (0-6). */
  ordersByBeepingStatus: Record<string, number>;
  /** Confirmados por el cliente pendientes de liberar. */
  awaitingRelease: number;
  /** Liberaciones en estado ambiguo (release_unknown). */
  ambiguousReleases: number;
  releaseFailures7d: number;
  message: string;
}

const now = () => Math.floor(Date.now() / 1000);
const WEEK = 7 * 86400;

export function getBeepingHealth(): BeepingHealth {
  const health = getServiceHealth("beeping");
  const checkpoint = parseInt(getSetting("beeping_sync_checkpoint") ?? "", 10);

  const base: BeepingHealth = {
    status: "unknown",
    configured: beepingCredentialsPresent(),
    enabled: beepingEnabled(),
    writeEnabled: beepingWriteEnabled(),
    autoRelease: beepingAutoReleaseEnabled(),
    shopName: cachedBeepingShopName(),
    lastApiSuccessAt: health?.last_success_at ?? null,
    lastApiErrorAt: health?.last_error_at ?? null,
    lastApiError: health?.last_error_message ?? null,
    lastSyncCheckpointAt: Number.isFinite(checkpoint) ? checkpoint : null,
    ordersByBeepingStatus: {},
    awaitingRelease: 0,
    ambiguousReleases: 0,
    releaseFailures7d: countIntegrationEvents("beeping", "release_failed", now() - WEEK),
    message: "",
  };

  try {
    const db = systemDbHandle();
    for (const row of db
      .prepare("SELECT beeping_order_status AS s, COUNT(*) AS n FROM orders WHERE beeping_order_status IS NOT NULL GROUP BY 1")
      .all() as Array<{ s: number; n: number }>) {
      base.ordersByBeepingStatus[String(row.s)] = row.n;
    }
    base.awaitingRelease = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM orders
           WHERE status = 'confirmed' AND beeping_sync_status IN ('not_released','release_failed')
             AND closure_status NOT IN ('cancelled','delivered','refused')`
        )
        .get() as { n: number }
    ).n;
    base.ambiguousReleases = (
      db.prepare("SELECT COUNT(*) AS n FROM orders WHERE beeping_sync_status = 'release_unknown'").get() as { n: number }
    ).n;
  } catch {
    /* DB sin migrar todavía: se queda en ceros */
  }

  if (!base.configured) {
    base.status = "disabled";
    base.message = "sin credencial: ejecuta npm run beeping:auth:init y pon BEEPING_ENABLED=1";
  } else if (!base.enabled) {
    base.status = "disabled";
    base.message = "credencial presente pero BEEPING_ENABLED=0";
  } else if (health?.status === "critical" || health?.status === "warning") {
    const esAuth = /401|credencial|unauthorized/i.test(base.lastApiError ?? "");
    base.status = esAuth ? "critical" : health.status;
    base.message = esAuth
      ? "la credencial de Beeping no funciona: repite beeping:auth:init"
      : `la API de Beeping falló: ${base.lastApiError ?? "error"}`;
  } else if (!health || base.lastApiSuccessAt === null) {
    base.status = "unknown";
    base.message = "habilitada pero sin ninguna llamada todavía (ejecuta beeping:doctor)";
  } else {
    base.status = "healthy";
    const modo = base.writeEnabled ? (base.autoRelease ? "auto-release" : "LIBERACIÓN MANUAL") : "solo lectura";
    base.message = `conectado (${modo})${base.shopName ? ` · tienda ${base.shopName}` : ""}`;
  }

  if (base.status === "healthy" && base.ambiguousReleases > 0) {
    base.status = "warning";
    base.message += ` · ${base.ambiguousReleases} liberación(es) en estado ambiguo: resolver`;
  }
  return base;
}
