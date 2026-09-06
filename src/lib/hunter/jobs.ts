// ============================================================
// AI Winner Radar — TRABAJOS PERIÓDICOS.
//
// Usa los LEASES que ya existen en el repo (`system/leases.ts`), los mismos
// que los schedulers de pedidos y tracking. Si algún día hay dos contenedores
// vivos, el lease impide que ambos refresquen y dupliquen snapshots — que
// falsearía el momentum, no solo gastaría créditos.
//
// Idempotentes: correrlos dos veces el mismo día no duplica fotos ni avisos.
// ============================================================

import { acquireLease, releaseLease } from "../system/leases";
import { logIntegrationEvent } from "../system/repo";
import { purgeHunterCache } from "./http";
import { evaluateWatchlistAlerts, listWatchlist } from "./decisions";
import { computeSignals } from "./signals";
import * as repo from "./repo";
import { scoreCreativeInvestment, scoreMarket, scoreMomentum, scoreSaturation } from "./scoring/market";

export const HUNTER_SNAPSHOT_LEASE = "hunter:snapshot";
export const HUNTER_WATCHLIST_LEASE = "hunter:watchlist";
/** Una foto al día por producto: más no aporta y ensucia el histórico. */
const SNAPSHOT_MIN_INTERVAL_HOURS = 20;

export interface JobResult {
  ran: boolean;
  reason: string;
  processed: number;
  alerts?: number;
}

/**
 * Refresca las señales de lo vigilado a partir de los anuncios ya guardados y
 * deja una foto nueva. NO sale a la red: el gasto de créditos lo decide
 * Pedro lanzando búsquedas, no un job de fondo.
 */
export function runSnapshotRefresh(nowSec = Math.floor(Date.now() / 1000)): JobResult {
  if (!acquireLease(HUNTER_SNAPSHOT_LEASE, 600)) {
    return { ran: false, reason: "otro proceso tiene el lease", processed: 0 };
  }
  try {
    let procesados = 0;
    for (const { product } of listWatchlist()) {
      const ultimo = repo.getSnapshotAround(product.id, 0, 1);
      // Idempotencia: si ya hay foto reciente, no se hace otra.
      if (ultimo && repo.countSnapshots(product.id) > 0) {
        const reciente = repo
          .getSnapshotAround(product.id, 0, SNAPSHOT_MIN_INTERVAL_HOURS / 24);
        if (reciente) continue;
      }
      const ads = repo.getAdsForProduct(product.id);
      if (ads.length === 0) continue;
      const signals = computeSignals(ads, nowSec);
      const ago7 = repo.getSnapshotAround(product.id, 7);
      const scores = {
        market: scoreMarket(signals),
        momentum: scoreMomentum({ now: signals, ago7d: ago7 }),
        saturation: scoreSaturation(signals),
        creative_investment: scoreCreativeInvestment(signals),
      };
      repo.saveSnapshot(product.id, signals, scores);
      procesados += 1;
    }
    if (procesados > 0) {
      logIntegrationEvent("hunter", "hunter_score_updated", "info", `${procesados} producto(s) vigilados refrescados`);
    }
    return { ran: true, reason: "ok", processed: procesados };
  } finally {
    releaseLease(HUNTER_SNAPSHOT_LEASE);
  }
}

export function runWatchlistAlerts(): JobResult {
  if (!acquireLease(HUNTER_WATCHLIST_LEASE, 300)) {
    return { ran: false, reason: "otro proceso tiene el lease", processed: 0 };
  }
  try {
    const alertas = evaluateWatchlistAlerts();
    return { ran: true, reason: "ok", processed: alertas, alerts: alertas };
  } finally {
    releaseLease(HUNTER_WATCHLIST_LEASE);
  }
}

/** Mantenimiento: retención de caché (§58). */
export function runHunterMaintenance(): JobResult {
  const borradas = purgeHunterCache();
  return { ran: true, reason: "ok", processed: borradas };
}
