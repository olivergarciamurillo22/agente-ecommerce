import type { WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import { getPendingOutbox, markOutboxSent, revertOutboxSent, getConversationById } from "../db";
import { canSendRealWhatsApp, logOnce, maskPhone } from "../safety";
import { heartbeat, recordSchedulerRun, recordServiceCheck } from "../system/repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

let outboxTimer: NodeJS.Timeout | null = null;

/** Un mensaje encolado hace más de X min NO se envía solo (restos de dev,
 *  reinicios, colas olvidadas): queda retenido hasta revisión manual. */
function outboxMaxAgeMinutes(): number {
  const v = parseFloat(process.env.OUTBOX_MAX_AGE_MINUTES ?? "");
  return Number.isFinite(v) && v > 0 ? v : 60;
}

/**
 * Loop que cada 2s revisa la tabla outbox y manda los mensajes pendientes
 * a través de Baileys.
 *
 * Patrón outbox: bot y Next.js son procesos separados, no comparten memoria.
 * El dashboard/scheduler escriben en outbox; el bot lee y envía.
 *
 * SEGURIDAD (defensa en profundidad): aunque el chokepoint de entrada ya
 * filtra, cada item se re-valida aquí contra los safety gates justo antes de
 * tocar Baileys. Bloqueado ≠ borrado: el item queda pendiente y visible
 * (npm run outbox:inspect / outbox:clear-safe).
 */
export function startOutboxLoop(sock: WASocket): void {
  if (outboxTimer) return;

  outboxTimer = setInterval(async () => {
    // Latido para el Control Center (con throttle interno: escribe ~1/min
    // aunque este loop corra cada 2s). Nunca puede romper el envío.
    heartbeat("scheduler:outbox");

    const pending = getPendingOutbox(20);
    if (pending.length === 0) return;

    const startedAt = Math.floor(Date.now() / 1000);
    let enviados = 0;
    let fallos = 0;
    let ultimoError: string | null = null;

    const now = Math.floor(Date.now() / 1000);

    for (const item of pending) {
      // SAFETY GATE: última barrera antes de Baileys. La marca `authorized`
      // viene del pedido autorizado a mano (piloto) y solo relaja la allowlist.
      if (!canSendRealWhatsApp(item.phone, { orderAuthorized: item.authorized === 1 })) {
        logOnce(
          `outbox-hold-${item.id}`,
          `[SAFETY] outbox #${item.id} → ${maskPhone(item.phone)} retenido por safety gates. NO enviado.`
        );
        continue;
      }
      // Mensajes viejos NO se envían solos jamás (revisar con outbox:inspect).
      if (now - item.created_at > outboxMaxAgeMinutes() * 60) {
        logOnce(
          `outbox-old-${item.id}`,
          `[SAFETY] outbox #${item.id} tiene ${Math.round((now - item.created_at) / 60)} min — retenido. ` +
            `Revisa con "npm run outbox:inspect" y limpia con "npm run outbox:clear-safe".`
        );
        continue;
      }

      // Usar la dirección completa guardada en la conversación (soporta @lid).
      // Fallback al formato clásico para filas antiguas sin jid registrado.
      const convo = getConversationById(item.conversation_id);
      const jid = convo?.jid ?? `${item.phone}@s.whatsapp.net`;

      // Patrón CLAIM → SEND → REVERT: se marca enviado ANTES de enviar y se
      // revierte solo si Baileys falla de forma controlada. Así un crash entre
      // envío y marca jamás DUPLICA el WhatsApp al reiniciar (at-most-once);
      // si el claim se pierde sin enviar, la red de seguridad de reminders/
      // needs_call recoge al cliente. WhatsApp no ofrece idempotency key:
      // este es el mejor compromiso posible (documentado en PEDRO-MVP.md).
      // CLAIM atómico: si otro proceso se lo llevó, aquí no se envía nada.
      // Sin esta comprobación, dos bots en marcha duplicarían el mensaje.
      if (!markOutboxSent(item.id)) {
        logger.info(`[bot] outbox #${item.id} ya reclamado por otro proceso — no se envía`);
        continue;
      }
      try {
        if (item.type === "image" && item.media_path) {
          if (!fs.existsSync(item.media_path)) {
            logger.warn(`[bot] outbox #${item.id}: imagen no encontrada, descartada`);
            continue; // ya está marcado sent: descartado
          }
          await sock.sendMessage(jid, {
            image: fs.readFileSync(item.media_path),
            caption: item.content || undefined,
          });
        } else {
          await sock.sendMessage(jid, { text: item.content });
        }
        logger.info(`[bot] → outbox enviado a ${maskPhone(item.phone)}: "${item.content.slice(0, 40)}..."`);
        enviados++;
      } catch (err) {
        // Fallo blando (desconexión transitoria): devolver a la cola y
        // reintentar en el siguiente tick.
        revertOutboxSent(item.id);
        fallos++;
        ultimoError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          `[bot] outbox #${item.id} falló, reintentando`
        );
      }
    }

    // Registro del tick CON contenido (los vacíos no generan filas).
    if (enviados > 0 || fallos > 0) {
      recordSchedulerRun("outbox", {
        startedAt,
        finishedAt: Math.floor(Date.now() / 1000),
        status: fallos > 0 ? "error" : "ok",
        processedCount: enviados,
        errorCount: fallos,
        lastError: ultimoError,
      });
      if (fallos > 0) {
        recordServiceCheck("whatsapp", {
          status: "warning",
          ok: false,
          error: `fallo enviando por Baileys: ${ultimoError ?? "?"}`,
        });
      }
    }
  }, 2000);
}

export function stopOutboxLoop(): void {
  if (outboxTimer) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
}
