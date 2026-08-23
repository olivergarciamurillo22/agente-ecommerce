// ============================================================
// Polling de estado de envíos — RED DE SEGURIDAD de los webhooks.
//
// Aunque Dropi/Dropea manden webhooks, uno puede perderse (caída del NAS,
// fallo de red). Este polling pregunta periódicamente por los envíos vivos.
//
// Cadencia por estado (más frecuente cuanto más cerca está la entrega, que
// es cuando el aviso al cliente tiene valor):
//   processing        → cada 10 min
//   shipped/in_transit→ cada 15 min
//   out_for_delivery  → cada 5 min
//   incident          → cada 30 min
// Los terminales (delivered/returned/cancelled) NO se consultan nunca más.
//
// HOY NO HACE NINGUNA LLAMADA: sin provider configurado, el bucle termina
// sin tocar la red. Los intervalos son ajustables cuando conozcamos los
// rate limits reales de cada API.
// ============================================================

import pino from "pino";
import { getOrdersForTrackingPolling, setOrderSupplierReview, type OrderRow } from "../db";
import { emergencyStop } from "../safety";
import { getProvider, supplierSyncEnabled } from "../suppliers/service";
import { ProviderNotConfiguredError, type SupplierPlatform } from "../suppliers/types";
import { processSupplierUpdate } from "./service";
import { isTerminalTracking, type TrackingStatus } from "./types";
import { runInstrumented } from "../system/repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Minutos entre consultas, según en qué punto está el envío. */
function intervaloMinutos(status: string): number {
  const env = (name: string, def: number) => {
    const v = parseFloat(process.env[name] ?? "");
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  switch (status as TrackingStatus) {
    case "out_for_delivery":
      return env("TRACKING_POLL_OUT_FOR_DELIVERY_MIN", 5);
    case "shipped":
    case "in_transit":
      return env("TRACKING_POLL_IN_TRANSIT_MIN", 15);
    case "incident":
      return env("TRACKING_POLL_INCIDENT_MIN", 30);
    default:
      return env("TRACKING_POLL_DEFAULT_MIN", 10);
  }
}

/** ¿Toca consultar ya este pedido? */
function tocaConsultar(order: OrderRow, nowSec: number): boolean {
  if (isTerminalTracking(order.supplier_status_normalized)) return false;
  const ultima = order.tracking_last_checked_at ?? 0;
  return nowSec - ultima >= intervaloMinutos(order.supplier_status_normalized) * 60;
}

export interface TrackingPollResult {
  checked: number;
  updated: number;
  skipped: number;
  blocked: string | null;
}

/**
 * Un ciclo de polling. `nowSec` inyectable para tests.
 * Sin proveedores implementados no hace absolutamente nada.
 */
export async function runTrackingPollTick(nowSec?: number): Promise<TrackingPollResult> {
  const result: TrackingPollResult = { checked: 0, updated: 0, skipped: 0, blocked: null };
  const now = nowSec ?? Math.floor(Date.now() / 1000);

  if (emergencyStop()) return { ...result, blocked: "EMERGENCY_STOP activo" };
  if (!supplierSyncEnabled()) return { ...result, blocked: "SUPPLIER_SYNC_ENABLED=0" };

  // Candidatos: envíos vivos cuya última consulta ya venció (el margen ancho
  // se afina abajo con el intervalo exacto de cada estado).
  const candidatos = getOrdersForTrackingPolling(now - 5 * 60);

  for (const order of candidatos) {
    if (!tocaConsultar(order, now)) {
      result.skipped++;
      continue;
    }
    const platform = order.supplier_platform as SupplierPlatform | null;
    const provider = platform ? getProvider(platform) : null;
    if (!provider || !provider.isConfigured()) {
      result.skipped++;
      continue; // sin implementación real: no hay nada que consultar
    }

    result.checked++;
    try {
      const estado = await provider.getStatus(order.supplier_external_order_id as string);
      const r = processSupplierUpdate(order, {
        rawStatus: estado.status ?? null,
        trackingNumber: estado.trackingNumber ?? null,
        trackingUrl: estado.trackingUrl ?? null,
        carrier: estado.carrier ?? null,
        source: "polling",
      });
      if (r.events.length) result.updated++;
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        result.skipped++;
        continue;
      }
      // Un fallo consultando no rompe el ciclo ni cambia el estado del envío.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        `[TRACKING] #${order.shopify_order_number} no se pudo consultar el estado`
      );
      setOrderSupplierReview(
        order.id,
        `error consultando estado: ${err instanceof Error ? err.message : "desconocido"}`
      );
    }
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startTrackingScheduler(): void {
  if (timer) return;
  const cada = Math.max(60, parseInt(process.env.TRACKING_POLL_SECONDS ?? "300", 10) || 300);
  logger.info(`[TRACKING] polling de envíos activo (cada ${cada}s)`);
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    // Instrumentación best-effort (latido + scheduler_runs). "checked" es el
    // trabajo real; los skipped no cuentan como procesado.
    void runInstrumented("scheduler:tracking", "tracking", async () => {
      const r = await runTrackingPollTick();
      return { processed: r.checked, errors: 0 };
    })
      .catch((err) =>
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[TRACKING] ciclo de polling falló"
        )
      )
      .finally(() => {
        ticking = false;
      });
  }, cada * 1000);
}

export function stopTrackingScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
