// ============================================================
// Scheduler de confirmaciones — el reloj del sistema.
//
// NO usa setTimeout por pedido: todo el estado vive en SQLite y cada tick
// (ORDER_POLL_SECONDS) deriva de la DB qué toca hacer. Si el proceso se
// reinicia, no se pierde nada: el siguiente tick retoma donde iba.
//
// SEGURIDAD — antes de CUALQUIER acción externa, cada pedido pasa por:
//   1. EMERGENCY_STOP → el tick entero se detiene.
//   2. Allowlist (TEST_MODE): teléfono fuera de la lista → el pedido NO se
//      procesa (ni mensaje, ni reminder, ni needs_call operativo).
//   3. Edad (MAX_ORDER_AGE_MINUTES): pedidos viejos → ignored_old, jamás
//      se actúa (anti-replay, anti-restos de desarrollo).
//   4. canSendRealWhatsApp / canWriteToShopify: en safe mode se LOGUEA la
//      simulación y NO se transiciona estado (nada queda "a medias" que
//      pudiera dispararse al cambiar la config).
//   5. Claims atómicos: un pedido no puede recibir dos iniciales ni dos
//      recordatorios aunque el tick se repita.
// ============================================================

import pino from "pino";
import {
  getOrdersDueInitialSend,
  getOrdersDueReminder,
  getOrdersDueNeedsCall,
  getConfirmedUntagged,
  claimOrderInitialSend,
  claimOrderReminder,
  markOrderNeedsCall,
  markOrderIgnoredOld,
  setOrderShopifyTagged,
  touchOrder,
} from "../db";
import { sendWhatsAppMessage, whatsappReady } from "../whatsapp";
import { buildConfirmationMessage, buildReminderMessage } from "./messages";
import { tagOrderConfirmed, shopifyAdminConfigured } from "../shopify/admin";
import {
  externalActionsLocked,
  orderActionAllowed,
  orderTooOld,
  canSendRealWhatsApp,
  canWriteToShopify,
  insideSendWindow,
  nextWindowOpen,
  windowLabel,
  logBlockedSend,
  logOnce,
  maskPhone,
} from "../safety";
import { deferOrderUntil } from "../db";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Minutos (admite decimales para pruebas: 0.5 = 30s) desde el envío inicial. */
function minutesEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const firstReminderMin = () => minutesEnv("FIRST_REMINDER_MINUTES", 30);
const needsCallMin = () => minutesEnv("NEEDS_CALL_MINUTES", 120);
const pollSeconds = () => {
  const v = parseInt(process.env.ORDER_POLL_SECONDS ?? "", 10);
  return Number.isFinite(v) && v >= 3 ? v : 20;
};

const TAG_RETRY_BACKOFF_SEC = 10 * 60;

/**
 * Un tick del scheduler. `nowSec` inyectable para tests.
 * Devuelve un resumen de lo hecho (útil en tests y logs).
 */
export async function runSchedulerTick(nowSec?: number): Promise<{
  sent: number;
  reminders: number;
  escalated: number;
}> {
  const summary = { sent: 0, reminders: 0, escalated: 0 };

  // KILL SWITCH: con EMERGENCY_STOP=1 el scheduler no ejecuta NADA.
  if (externalActionsLocked()) {
    logOnce("sched-emergency", "[SAFETY] EMERGENCY_STOP activo — scheduler detenido (sin acciones)");
    return summary;
  }

  const now = nowSec ?? Math.floor(Date.now() / 1000);

  // 1) Escalar a needs_call ANTES de recordar (si ya venció el plazo de
  //    llamada, no tiene sentido un recordatorio que caduca en el mismo tick).
  //    Solo pedidos elegibles: fuera de allowlist = "no operativo" en TEST_MODE.
  const needsCallCutoff = now - Math.round(needsCallMin() * 60);
  for (const order of getOrdersDueNeedsCall(needsCallCutoff)) {
    if (!orderActionAllowed(order)) {
      logOnce(
        `test-skip-${order.id}`,
        `[TEST MODE] Pedido #${order.shopify_order_number} ignorado: fuera de allowlist y sin autorizar`
      );
      continue;
    }
    if (markOrderNeedsCall(order.id)) {
      summary.escalated++;
      logger.info(`[ORDER] #${order.shopify_order_number} -> needs_call (sin respuesta)`);
    }
  }

  const ventanaAbierta = insideSendWindow();

  if (whatsappReady()) {
    // 2) Confirmaciones iniciales en cola.
    for (const order of getOrdersDueInitialSend()) {
      if (!orderActionAllowed(order)) {
        logOnce(
          `test-skip-${order.id}`,
          `[TEST MODE] Pedido #${order.shopify_order_number} ignorado: fuera de allowlist y sin autorizar`
        );
        continue;
      }

      // VENTANA HORARIA: fuera de horario el pedido NO se envía ni se pierde.
      // Se marca la próxima apertura y se reintenta entonces. La espera es
      // deliberada, así que NO cuenta para la antigüedad (nada de ignored_old).
      if (!ventanaAbierta) {
        const apertura = nextWindowOpen();
        if (deferOrderUntil(order.id, apertura)) {
          logger.info(
            `[VENTANA] #${order.shopify_order_number} en espera: fuera de ${windowLabel()}. ` +
              `Se enviará hacia las ${new Date(apertura * 1000).toLocaleString("es-ES")}`
          );
        }
        continue;
      }

      // Pedido antiguo (restos de dev, replay, backfill) → fuera, sin tocar a
      // nadie. La antigüedad se mide desde la apertura si estuvo en espera.
      const baseEdad = order.deferred_until ?? order.created_at;
      if (orderTooOld(baseEdad, now)) {
        if (markOrderIgnoredOld(order.id, "ignored_old_order: demasiado antiguo al ir a enviar")) {
          logger.warn(
            `[SAFETY] #${order.shopify_order_number} ignored_old_order (${Math.round((now - baseEdad) / 60)} min) — sin acciones`
          );
        }
        continue;
      }
      const message = buildConfirmationMessage(order);
      const autorizado = order.pilot_authorized === 1;
      if (!canSendRealWhatsApp(order.phone, { orderAuthorized: autorizado })) {
        // Simulación (safe mode / flags cerrados): NO transicionar estado.
        logBlockedSend(`sim-init-${order.id}`, order.phone, message);
        continue;
      }
      // Claim atómico ANTES de encolar: jamás dos mensajes iniciales.
      if (!claimOrderInitialSend(order.id, now)) continue;
      sendWhatsAppMessage(order.phone, message, {
        name: order.customer_name ?? undefined,
        orderAuthorized: autorizado,
      });
      summary.sent++;
      logger.info(`[WHATSAPP] Confirmation sent #${order.shopify_order_number}`);
    }

    // 3) Recordatorios vencidos (solo a quien no ha contestado NADA).
    // También respetan la ventana horaria: nada de recordar a las 3 de la mañana.
    const reminderCutoff = now - Math.round(firstReminderMin() * 60);
    for (const order of ventanaAbierta ? getOrdersDueReminder(reminderCutoff) : []) {
      if (!orderActionAllowed(order)) {
        logOnce(
          `test-skip-rem-${order.id}`,
          `[TEST MODE] Recordatorio #${order.shopify_order_number} ignorado: fuera de allowlist y sin autorizar`
        );
        continue;
      }
      const message = buildReminderMessage(order);
      const autorizado = order.pilot_authorized === 1;
      if (!canSendRealWhatsApp(order.phone, { orderAuthorized: autorizado })) {
        logBlockedSend(`sim-rem-${order.id}`, order.phone, message);
        continue;
      }
      if (!claimOrderReminder(order.id, now)) continue;
      sendWhatsAppMessage(order.phone, message, {
        name: order.customer_name ?? undefined,
        orderAuthorized: autorizado,
      });
      summary.reminders++;
      logger.info(`[REMINDER] #${order.shopify_order_number} sent`);
    }
  }

  // 4) Tags pendientes en Shopify. Gate central primero: en safe/test-sin-flag
  //    no se toca la tienda (y al abrir el flag, se taggea retroactivamente).
  if (canWriteToShopify() && shopifyAdminConfigured()) {
    for (const order of getConfirmedUntagged(now - TAG_RETRY_BACKOFF_SEC)) {
      // En TEST_MODE, solo pedidos de prueba o autorizados a mano.
      if (!orderActionAllowed(order)) continue;
      touchOrder(order.id); // marca el intento: si falla, backoff natural de 10 min
      const ok = await tagOrderConfirmed(order.shopify_order_id);
      if (ok) setOrderShopifyTagged(order.id);
    }
  }

  return summary;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startOrderScheduler(): void {
  if (timer) return;
  logger.info(
    `[scheduler] confirmaciones activas (recordatorio: ${firstReminderMin()} min, llamada: ${needsCallMin()} min, tick: ${pollSeconds()}s)`
  );
  timer = setInterval(() => {
    if (ticking) return; // nunca solapar ticks
    ticking = true;
    void runSchedulerTick()
      .catch((err) =>
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[scheduler] tick falló")
      )
      .finally(() => {
        ticking = false;
      });
  }, pollSeconds() * 1000);
}

export function stopOrderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
