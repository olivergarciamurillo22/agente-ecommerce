// ============================================================
// Scheduler de Beeping: la reconciliación periódica (§15) dentro de la app.
//
// Cada BEEPING_SYNC_INTERVAL_MINUTES (default 10):
//   1. reconcileBeepingOrders  — READ-ONLY hacia Beeping, actualiza local.
//   2. resolveAllAmbiguousReleases — consulta los release_unknown.
//   3. autoReleasePendingConfirmed — no-op mientras el auto-release esté
//      apagado (BEEPING_AUTO_RELEASE_CONFIRMED=0, el modo acordado).
//
// Con BEEPING_ENABLED=0 (default) el tick no hace NADA: instalar este
// scheduler en el NAS no cambia ningún comportamiento hasta encenderlo.
// Lease propio: dos procesos no reconcilian a la vez.
// ============================================================

import pino from "pino";
import { acquireLease, releaseLease } from "../system/leases";
import { beepingEnabled } from "./config";
import { autoReleasePendingConfirmed, resolveAllAmbiguousReleases } from "./release";
import { reconcileBeepingOrders } from "./sync";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export const LEASE_BEEPING = "beeping-sync";

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function runBeepingTick(): Promise<void> {
  if (!beepingEnabled()) return;
  if (ticking) return;
  ticking = true;
  const minutos = Math.max(5, Number(process.env.BEEPING_SYNC_INTERVAL_MINUTES) || 10);
  if (!acquireLease(LEASE_BEEPING, Math.max(300, minutos * 60))) {
    ticking = false;
    return;
  }
  try {
    const report = await reconcileBeepingOrders();
    if (!report.skipped && (report.updated || report.closureUpdates || report.errors.length)) {
      logger.info(
        `[BEEPING] tick: ${report.matched} emparejados, ${report.updated} actualizados, ${report.closureUpdates} cierres, ${report.errors.length} errores`
      );
    }
    await resolveAllAmbiguousReleases();
    await autoReleasePendingConfirmed();
  } catch (err) {
    logger.warn(`[BEEPING] tick falló (se reintenta en el próximo): ${err instanceof Error ? err.message : err}`);
  } finally {
    releaseLease(LEASE_BEEPING);
    ticking = false;
  }
}

export function startBeepingScheduler(): void {
  if (timer) return;
  if (!beepingEnabled()) {
    logger.info("[BEEPING] scheduler inactivo (BEEPING_ENABLED=0 o sin credencial)");
    return;
  }
  const minutos = Math.max(5, Number(process.env.BEEPING_SYNC_INTERVAL_MINUTES) || 10);
  logger.info(`[BEEPING] reconciliación periódica activa (cada ${minutos} min)`);
  void runBeepingTick();
  timer = setInterval(() => void runBeepingTick(), minutos * 60 * 1000);
}
