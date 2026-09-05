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
//      se actúa (anti-replay, anti-restos de desarrollo). Medida desde
//      ordered_at (T2 — fecha REAL de compra), no desde created_at (que es
//      cuándo se insertó la fila, no cuándo se compró).
//   4. canSendRealWhatsApp / canWriteToShopify: en safe mode se LOGUEA la
//      simulación y NO se transiciona estado (nada queda "a medias" que
//      pudiera dispararse al cambiar la config).
//   5. Claims atómicos: un pedido no puede recibir dos iniciales ni dos
//      recordatorios aunque el tick se repita.
// ============================================================

import pino from "pino";
import { acquireLease, LEASE_ORDERS } from "../system/leases";
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
import { sendWhatsAppMessage, sendWhatsAppInteractive, whatsappReady } from "../whatsapp";
import { whatsappProviderName } from "../whatsapp/provider";
import { buildConfirmationOutbound, firstName } from "../whatsapp/interactive";
import { buildApprovedTemplateMessage, TemplateNotReadyError } from "../whatsapp/templates";
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
import { deferOrderUntil, getOrdersForSupplierEvaluation, setOrderSupplierEvaluation } from "../db";
import { evaluateOrderForSupplier } from "../suppliers/service";
import { isConfirmationEligible } from "./eligibility";
import { logIntegrationEvent, runInstrumented } from "../system/repo";

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
/**
 * Cuántas ACCIONES externas (envíos/escalados) hace un tick como máximo.
 * Lo que se acota es el trabajo con efectos, NO cuántos pedidos se MIRAN.
 *
 * Bug real (03-09): las colas se leían con `LIMIT 20` ordenadas por fecha, y
 * un pedido que el tick se salta sin cambiarle el estado (fuera de allowlist
 * en TEST_MODE, no elegible, plantilla bloqueada) se quedaba en la cola. Con
 * 20 de esos delante, el pedido nuevo del piloto NUNCA entraba en el LIMIT:
 * inanición silenciosa (head-of-line blocking). Ahora se recorre la cola
 * entera (acotada a QUEUE_SCAN_LIMIT) y solo se limita cuánto se ENVÍA.
 */
export const MAX_ACTIONS_PER_TICK = 20;
export const QUEUE_SCAN_LIMIT = 500;

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
  for (const order of getOrdersDueNeedsCall(needsCallCutoff, QUEUE_SCAN_LIMIT)) {
    if (summary.escalated >= MAX_ACTIONS_PER_TICK) break;
    // Elegibilidad ANTES que nada: un pedido ya cancelado en Shopify o con
    // fulfillment en marcha no debe escalar jamás a needs_call (el hallazgo
    // 4/5/1 del 23-08 era exactamente esto).
    const elig = isConfirmationEligible(order);
    if (!elig.eligible) {
      logOnce(
        `inelig-nc-${order.id}-${elig.reason}`,
        `[ELIGIBILITY] #${order.shopify_order_number} no escala a needs_call: ${elig.detail}`
      );
      continue;
    }
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
    for (const order of getOrdersDueInitialSend(QUEUE_SCAN_LIMIT)) {
      if (summary.sent >= MAX_ACTIONS_PER_TICK) break;
      const elig = isConfirmationEligible(order);
      if (!elig.eligible) {
        logOnce(
          `inelig-init-${order.id}-${elig.reason}`,
          `[ELIGIBILITY] #${order.shopify_order_number} sin confirmación inicial: ${elig.detail}`
        );
        continue;
      }
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
      // nadie. La antigüedad se mide desde la apertura si estuvo en espera;
      // si no, desde ordered_at (T2 — fecha REAL de compra en Shopify, de
      // T1), nunca desde created_at (que es cuándo se insertó la fila, no
      // cuándo se compró). Solo cae a created_at si ordered_at es NULL — fila
      // de antes de T1 que el backfill de la columna aún no ha resuelto.
      const baseEdad = order.deferred_until ?? order.ordered_at ?? order.created_at;
      if (orderTooOld(baseEdad, now)) {
        if (markOrderIgnoredOld(order.id, "ignored_old_order: demasiado antiguo al ir a enviar")) {
          logger.warn(
            `[SAFETY] #${order.shopify_order_number} ignored_old_order (${Math.round((now - baseEdad) / 60)} min) — sin acciones`
          );
        }
        continue;
      }
      // Botones de verdad SOLO en cloud_api: Baileys no los tiene, y el
      // texto de fallback es justo el flujo 1/2/3 de siempre, así que
      // Baileys sigue mandando lo mismo que manda hoy. El proveedor se
      // resuelve UNA vez aquí; el resto del bloque (gates, claim, log) no
      // sabe ni le importa cuál es.
      //
      // BUG1: fuera de la ventana de 24h, Meta EXIGE una plantilla aprobada
      // — un interactivo o texto libre se rechaza siempre con
      // outside_24h_window. El primer mensaje a un cliente nuevo está
      // SIEMPRE fuera de ventana (nunca ha escrito), así que sin esto
      // ninguna confirmación inicial podía salir en cloud_api.
      let interactive: ReturnType<typeof buildConfirmationOutbound> | null = null;
      if (whatsappProviderName() === "cloud_api") {
        try {
          interactive = buildConfirmationOutbound(order);
        } catch (err) {
          // Dos causas posibles, ninguna de Meta:
          //  · TemplateNotReadyError — el mapping lógico→WABA no está
          //    verificado/aprobado (incidente 132001). El pedido NO se
          //    consume: en cuanto el doctor verifique la plantilla, el
          //    siguiente tick lo envía. Y se deja RASTRO VISIBLE: sin esto,
          //    producción estuvo días reintentando 404 en silencio.
          //  · cualquier otra — error de catálogo local (programación).
          const esBloqueo = err instanceof TemplateNotReadyError;
          logger.error(
            `[WHATSAPP] #${order.shopify_order_number}: no se pudo construir la confirmación (${err instanceof Error ? err.message : String(err)}) — se reintenta en el siguiente tick`
          );
          logIntegrationEvent(
            "whatsapp",
            esBloqueo ? "template_not_ready" : "template_build_failed",
            "warning",
            esBloqueo
              ? `confirmación inicial BLOQUEADA (${(err as TemplateNotReadyError).blocker}): ${err instanceof Error ? err.message : ""}`.slice(0, 300)
              : `no se pudo construir la confirmación: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
            order.shopify_order_number
          );
          continue;
        }
      }
      const message = interactive ? interactive.fallbackText : buildConfirmationMessage(order);
      const autorizado = order.pilot_authorized === 1;
      if (!canSendRealWhatsApp(order.phone, { orderAuthorized: autorizado })) {
        // Simulación (safe mode / flags cerrados): NO transicionar estado.
        logBlockedSend(`sim-init-${order.id}`, order.phone, message);
        continue;
      }
      // Claim atómico ANTES de encolar: jamás dos mensajes iniciales.
      if (!claimOrderInitialSend(order.id, now)) continue;
      if (interactive) {
        sendWhatsAppInteractive(order.phone, interactive, {
          name: order.customer_name ?? undefined,
          orderAuthorized: autorizado,
        });
      } else {
        sendWhatsAppMessage(order.phone, message, {
          name: order.customer_name ?? undefined,
          orderAuthorized: autorizado,
        });
      }
      summary.sent++;
      logger.info(`[WHATSAPP] Confirmation sent #${order.shopify_order_number}`);
    }

    // 3) Recordatorios vencidos (solo a quien no ha contestado NADA).
    // También respetan la ventana horaria: nada de recordar a las 3 de la mañana.
    const reminderCutoff = now - Math.round(firstReminderMin() * 60);
    for (const order of ventanaAbierta ? getOrdersDueReminder(reminderCutoff, QUEUE_SCAN_LIMIT) : []) {
      if (summary.reminders >= MAX_ACTIONS_PER_TICK) break;
      const elig = isConfirmationEligible(order);
      if (!elig.eligible) {
        logOnce(
          `inelig-rem-${order.id}-${elig.reason}`,
          `[ELIGIBILITY] #${order.shopify_order_number} sin recordatorio: ${elig.detail}`
        );
        continue;
      }
      if (!orderActionAllowed(order)) {
        logOnce(
          `test-skip-rem-${order.id}`,
          `[TEST MODE] Recordatorio #${order.shopify_order_number} ignorado: fuera de allowlist y sin autorizar`
        );
        continue;
      }
      const message = buildReminderMessage(order);
      const autorizado = order.pilot_authorized === 1;
      // BUG REAL (03-09): en cloud_api el recordatorio salía como TEXTO libre.
      // Un recordatorio va, por definición, a quien NO ha contestado — así que
      // SIEMPRE está fuera de la ventana de 24 h de Meta, que rechaza todo lo
      // que no sea plantilla. El claim ya se había consumido: el cliente nunca
      // recibía el recordatorio y el pedido escalaba a llamada en silencio.
      // La WABA tiene `recordatorio_confirmacion` (2 variables, 2 botones) para
      // esto exactamente. Sin verificación de plantilla, se RETIENE (no se
      // consume) y queda rastro visible, igual que la confirmación inicial.
      let reminderSpec: ReturnType<typeof buildConfirmationOutbound> | null = null;
      if (whatsappProviderName() === "cloud_api") {
        try {
          reminderSpec = {
            message: buildApprovedTemplateMessage("order_reminder", {
              nombre: firstName(order) || "cliente",
              numero_pedido: `#${order.shopify_order_number}`,
            }),
            fallbackText: message,
          };
        } catch (err) {
          const esBloqueo = err instanceof TemplateNotReadyError;
          logIntegrationEvent(
            "whatsapp",
            esBloqueo ? "template_not_ready" : "template_build_failed",
            "warning",
            (esBloqueo
              ? `recordatorio BLOQUEADO (${(err as TemplateNotReadyError).blocker}): ${err instanceof Error ? err.message : ""}`
              : `no se pudo construir el recordatorio: ${err instanceof Error ? err.message : String(err)}`).slice(0, 300),
            order.shopify_order_number
          );
          continue; // sin claim: cuando la plantilla esté verificada, saldrá
        }
      }
      if (!canSendRealWhatsApp(order.phone, { orderAuthorized: autorizado })) {
        logBlockedSend(`sim-rem-${order.id}`, order.phone, message);
        continue;
      }
      if (!claimOrderReminder(order.id, now)) continue;
      if (reminderSpec) {
        sendWhatsAppInteractive(order.phone, reminderSpec, {
          name: order.customer_name ?? undefined,
          orderAuthorized: autorizado,
        });
      } else {
        sendWhatsAppMessage(order.phone, message, {
          name: order.customer_name ?? undefined,
          orderAuthorized: autorizado,
        });
      }
      summary.reminders++;
      logger.info(`[REMINDER] #${order.shopify_order_number} sent`);
    }
  }

  // 3.5) Proveedores (Dropi/Dropea): SOLO evaluación, sin ningún efecto
  //      externo. Deja escrito en cada pedido confirmado qué proveedor le
  //      tocaría y si algo lo bloquea (dirección inválida, falta routing),
  //      para que Pedro lo vea en el panel. La sincronización real llegará
  //      cuando exista el handoff de las APIs.
  for (const order of getOrdersForSupplierEvaluation()) {
    const evaluation = evaluateOrderForSupplier(order);
    if (
      order.supplier_sync_status !== evaluation.status ||
      order.supplier_platform !== evaluation.platform
    ) {
      logger.info(
        `[SUPPLIER] #${order.shopify_order_number} routing → ${evaluation.platform} | ${evaluation.status}: ${evaluation.reason}`
      );
    }
    setOrderSupplierEvaluation(order.id, evaluation.platform, evaluation.status, evaluation.reason);
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
    // LEASE: sin él, no se ejecuta. La guarda `ticking` de arriba solo
    // protege dentro de ESTE proceso; el lease protege contra un SEGUNDO
    // proceso (dos contenedores, reinicio solapado, un `start:bot` a mano).
    // Lo que duplicarían no son lecturas: son efectos externos.
    if (!acquireLease(LEASE_ORDERS, Math.max(120, pollSeconds() * 4))) {
      ticking = false;
      return;
    }
    // Instrumentación best-effort: latido + fila en scheduler_runs si hubo
    // trabajo. Si registrar falla, el tick sigue funcionando igual.
    void runInstrumented("scheduler:orders", "orders", async () => {
      const s = await runSchedulerTick();
      return { processed: s.sent + s.reminders + s.escalated, errors: 0 };
    })
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
