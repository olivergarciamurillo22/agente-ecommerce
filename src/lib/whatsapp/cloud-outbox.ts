// ============================================================
// LOOP DE ENTREGA DEL OUTBOX — modo Cloud API.
//
// Es el gemelo de src/lib/baileys/outbox.ts para el proveedor oficial. El
// de Baileys NO se toca (lleva meses probado en producción); este solo
// arranca cuando WHATSAPP_PROVIDER=cloud_api. Ambos compiten por el MISMO
// lease (LEASE_OUTBOX), así que aunque alguien arrancara los dos por un
// error de configuración, solo uno drenaría la cola: jamás doble envío.
//
// Mismas garantías que el de Baileys, y una más:
//   · safety gates revalidados justo antes de entregar
//   · mensajes viejos retenidos (nunca se envían solos)
//   · CLAIM atómico por item (markOutboxSent WHERE sent=0): at-most-once
//   · fallo RETRYABLE → revert y reintento en el siguiente tick
//   · fallo TERMINAL → item marcado failed con motivo, fuera de la cola
//     (reintentar un "fuera de ventana de 24 h" daría lo mismo eternamente)
//   · provider_message_id persistido → los webhooks de estado (delivered/
//     read/failed) encuentran su fila
// ============================================================

import pino from "pino";
import {
  getConversationById,
  getPendingOutbox,
  markOutboxSent,
  markOutboxFailedTerminal,
  revertOutboxSent,
  setOutboxProviderResult,
  type OutboxItem,
} from "../db";
import { canSendRealWhatsApp, logOnce, maskPhone } from "../safety";
import { acquireLease, LEASE_OUTBOX } from "../system/leases";
import { heartbeat, recordSchedulerRun, recordServiceCheck } from "../system/repo";
import { MetaCloudWhatsAppProvider } from "./meta-cloud";
import type { OutboundWhatsAppMessage, WhatsAppProvider } from "./provider";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

function outboxMaxAgeMinutes(): number {
  const v = parseInt(process.env.OUTBOX_MAX_AGE_MINUTES ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 15;
}

/** Reconstruye el mensaje del item: interactivo desde payload_json, o texto. */
export function outboundFromItem(item: OutboxItem): OutboundWhatsAppMessage {
  if (item.payload_json && item.message_type !== "text") {
    try {
      const parsed = JSON.parse(item.payload_json) as OutboundWhatsAppMessage;
      if (parsed && typeof parsed === "object" && "kind" in parsed) return parsed;
    } catch {
      // payload ilegible: mejor el texto de fallback que perder el mensaje
    }
  }
  return { kind: "text", text: item.content };
}

/** Un tick de entrega. Exportado y con provider inyectable para tests. */
export async function runCloudOutboxTick(provider: WhatsAppProvider): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  const pending = getPendingOutbox(20);
  if (pending.length === 0) return result;

  const now = Math.floor(Date.now() / 1000);
  for (const item of pending) {
    // SAFETY GATE: última barrera, igual que en Baileys.
    if (!canSendRealWhatsApp(item.phone, { orderAuthorized: item.authorized === 1 })) {
      logOnce(
        `outbox-hold-${item.id}`,
        `[SAFETY] outbox #${item.id} → ${maskPhone(item.phone)} retenido por safety gates. NO enviado.`
      );
      continue;
    }
    if (now - item.created_at > outboxMaxAgeMinutes() * 60) {
      logOnce(
        `outbox-old-${item.id}`,
        `[SAFETY] outbox #${item.id} tiene ${Math.round((now - item.created_at) / 60)} min — retenido.`
      );
      continue;
    }
    // Imagen (la manda un humano desde el panel de Chats): la Cloud API
    // exige subir el binario a Meta primero, y eso NO está implementado.
    // Fallar con gracia y motivo visible — jamás mandar un texto vacío o el
    // pie de foto suelto como si fuera el mensaje.
    if (item.type === "image") {
      if (!markOutboxSent(item.id)) continue;
      markOutboxFailedTerminal(
        item.id,
        provider.name,
        "imagen no soportada por la Cloud API todavía: reenviar como texto, o usar Baileys"
      );
      result.failed++;
      continue;
    }

    // CLAIM atómico: si otro proceso se lo llevó, aquí no se envía nada.
    if (!markOutboxSent(item.id)) continue;

    const r = await provider.send(item.phone, outboundFromItem(item));
    if (r.ok) {
      setOutboxProviderResult(item.id, provider.name, r.providerMessageId);
      logger.info(`[META] → outbox #${item.id} enviado a ${maskPhone(item.phone)} (${item.message_type})`);
      result.sent++;
    } else if (r.retryable) {
      // Fallo blando: devolver a la cola, el siguiente tick reintenta.
      revertOutboxSent(item.id);
      result.failed++;
      logger.warn(`[META] outbox #${item.id} falló (reintentable): ${r.error}`);
    } else {
      // Terminal: reintentar daría lo mismo. Fuera de la cola, CON motivo.
      markOutboxFailedTerminal(item.id, provider.name, r.error ?? "fallo terminal");
      result.failed++;
      logger.warn(`[META] outbox #${item.id} fallo TERMINAL: ${r.error}`);
      recordServiceCheck("whatsapp", { status: "warning", ok: false, error: r.error ?? "fallo terminal" });
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startCloudOutboxLoop(provider: WhatsAppProvider = new MetaCloudWhatsAppProvider()): void {
  if (timer) return;
  logger.info("[META] loop de entrega por Cloud API activo (cada 2s)");
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      // Mismo lease que el loop de Baileys: un único drenador, siempre.
      if (!acquireLease(LEASE_OUTBOX, 60)) return;
      heartbeat("scheduler:outbox");
      const r = await runCloudOutboxTick(provider);
      if (r.sent > 0 || r.failed > 0) {
        recordSchedulerRun("outbox", {
          startedAt: Math.floor(Date.now() / 1000),
          finishedAt: Math.floor(Date.now() / 1000),
          status: r.failed > 0 ? "error" : "ok",
          processedCount: r.sent,
          errorCount: r.failed,
          lastError: null,
        });
      }
    })()
      .catch((err) =>
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[META] tick del outbox falló")
      )
      .finally(() => {
        ticking = false;
      });
  }, 2000);
}

export function stopCloudOutboxLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
