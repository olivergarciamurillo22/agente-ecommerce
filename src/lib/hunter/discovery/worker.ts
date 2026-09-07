// ============================================================
// VIGILANTE DE BÚSQUEDAS (07-09-2026) — docs/HUNTER-BUSCADOR.md
//
// Corre EN EL PROCESO DEL BOT, junto al resto de trabajos largos. El panel solo
// encola; aquí es donde se gastan los quince minutos. Motivo: una ruta de Next
// muere en cada redespliegue y bloquearía su hilo durante la agrupación.
//
// Una búsqueda a la vez, siempre. Dos partirían la cuota del mismo token.
// ============================================================

import pino from "pino";
import { canRunDiscovery } from "../../safety";
import { AdLibraryClient } from "./client";
import {
  claimNextDiscoveryJob,
  failDiscoveryJob,
  finishDiscoveryJob,
  recordJobProgress,
  requeueStuckJobs,
  type DiscoveryJobView,
} from "./jobs";
import { runWordSearch } from "./word-search";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Cada cuánto mira la cola. Una búsqueda dura minutos: sondear cada 10 s sobra. */
const TICK_MS = 10_000;

export function discoveryToken(env: Record<string, string | undefined> = process.env): string {
  return (env.META_AD_LIBRARY_ACCESS_TOKEN ?? env.META_ADS_ACCESS_TOKEN ?? "").trim();
}

export interface DiscoveryWorkerDeps {
  client?: AdLibraryClient;
  token?: string;
  now?: number;
}

/**
 * Un ciclo: recupera trabajos huérfanos, coge el siguiente pendiente y lo
 * ejecuta hasta el final. Devuelve el trabajo atendido, o null si no había.
 * NUNCA lanza: un fallo se guarda en la fila y el vigilante sigue vivo.
 */
export async function runDiscoveryWorkerTick(deps: DiscoveryWorkerDeps = {}): Promise<DiscoveryJobView | null> {
  requeueStuckJobs();
  // Con la parada activa ni se reclama: el trabajo se queda pendiente y saldrá
  // cuando se levante, en vez de fallar en bucle.
  if (!canRunDiscovery()) return null;
  const job = claimNextDiscoveryJob();
  if (!job) return null;

  const token = deps.token ?? discoveryToken();
  if (!token && !deps.client) {
    failDiscoveryJob(job.id, "falta META_AD_LIBRARY_ACCESS_TOKEN en el entorno: sin token no se busca nada");
    return job;
  }

  try {
    const result = await runWordSearch({
      seed: job.seed,
      country: job.country,
      days: job.days,
      minutes: job.minutes,
      token,
      now: deps.now,
      client: deps.client,
      onProgress: (p) => recordJobProgress(job.id, p),
    });
    finishDiscoveryJob(job.id, result);
  } catch (err) {
    failDiscoveryJob(job.id, err instanceof Error ? err.message : String(err));
  }
  return job;
}

let timer: ReturnType<typeof setInterval> | null = null;
let corriendo = false;

/** Arranca el vigilante en el proceso del bot. Idempotente. */
export function startDiscoveryWorker(): void {
  if (timer) return;
  logger.info("[hunter] vigilante de búsquedas de competencia en marcha");
  timer = setInterval(() => {
    if (corriendo) return; // una búsqueda a la vez
    corriendo = true;
    void runDiscoveryWorkerTick()
      .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[hunter] el ciclo del vigilante falló (no bloquea)"))
      .finally(() => {
        corriendo = false;
      });
  }, TICK_MS);
  timer.unref?.();
}

export function stopDiscoveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  corriendo = false;
}
