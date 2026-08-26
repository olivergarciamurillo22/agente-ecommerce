import type { WASocket, BaileysEventMap, WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import pino from "pino";
import {
  getOrCreateConversation,
  getConversationById,
  insertMessage,
  getRecentHistory,
  getSetting,
  reconcileLidToPn,
} from "../db";
import type { Message } from "../db";
import { generateReply } from "../openrouter";
import { getLeadMemory, memoryToPrompt, rememberConversation, logMessage } from "../memory";
import { guardInbound, guardOutbound, GUARD_FALLBACK } from "../guardrails";
import { transcribeAudio, transcriptionConfigured } from "../transcribe";
import { describeImage, visionConfigured } from "../vision";
import { saneaHumano, dividirMensajes, delayEscritura } from "../humanize";
import { registrarFallback } from "../watchdog";
import { handleOrderReply } from "../orders/confirmation";
import { sendWhatsAppMessage } from "../whatsapp";
import { getActiveOrdersByPhone } from "../db";
import { canSendRealWhatsApp, logOnce } from "../safety";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

// Aviso suave cuando algo falla (LLM caído, sin saldo, error de tool): mejor
// esto que dejar al lead con "escribiendo…" y silencio para siempre.
const RESPUESTA_FALLBACK = "Perdona, se me cruzó un cable un momento. ¿Me lo repites?";

/** Enmascara el teléfono para los logs (deja solo los últimos 4 dígitos) — PII. */
function phoneMasked(phone: string): string {
  return phone.length > 4 ? "***" + phone.slice(-4) : "***";
}

/**
 * Teléfono CANÓNICO del lead, el que lo identifica en memoria, CRM y conversación.
 *
 * WhatsApp (2025+) entrega algunos mensajes directos con dirección `@lid`, cuyo
 * número NO es el teléfono real sino un identificador interno. En esos casos
 * Baileys adjunta el número real en `key.senderPn` (viene del atributo `sender_pn`
 * del propio WhatsApp): lo usamos como identidad para no duplicar a la persona ni
 * perder su memoria entre visitas. El `@lid` completo se sigue usando SOLO como
 * dirección de respuesta (remoteJid / conversations.jid). Si no llega `senderPn`,
 * caemos al número del jid (degradado, pero estable dentro de esa dirección).
 */
function canonicalPhone(remoteJid: string, senderPn?: string): string {
  const digits = (jid: string) => jid.split("@")[0].split(":")[0];
  if (remoteJid.endsWith("@lid") && senderPn && senderPn.includes("@") && /\d/.test(senderPn)) {
    return digits(senderPn);
  }
  return digits(remoteJid);
}

// Buffer de agrupación: cuando llega un mensaje, esperamos unos segundos por si
// el lead escribe más (típico en WhatsApp: varios mensajes cortos seguidos).
// Cada mensaje nuevo reinicia el temporizador; al expirar, se responde UNA vez
// a todo lo acumulado. Editable en caliente desde Ajustes (buffer_seconds),
// con fallback a la variable de entorno BUFFER_SECONDS (por defecto 10).
function bufferMs(): number {
  const s = Number(getSetting("buffer_seconds")) || Number(process.env.BUFFER_SECONDS) || 10;
  return Math.min(Math.max(s, 0), 120) * 1000;
}
const pending = new Map<number, { timer: ReturnType<typeof setTimeout>; jid: string; phone: string }>();

/**
 * Resumen corto de lo último hablado (últimos ~8 mensajes) para la memoria de
 * largo plazo. No usa LLM: es la propia conversación condensada, suficiente para
 * que el agente retome si la persona vuelve semanas después.
 */
function resumenConversacion(history: Message[], ultimaRespuesta: string): string {
  const lineas = history.map(
    (m) => `${m.role === "user" ? "Lead" : "Agente"}: ${String(m.content).replace(/\s+/g, " ").trim()}`
  );
  lineas.push(`Agente: ${ultimaRespuesta.replace(/\s+/g, " ").trim()}`);
  let texto = lineas.slice(-8).join("\n");
  if (texto.length > 1200) texto = texto.slice(texto.length - 1200);
  return texto;
}

/** Envía el aviso suave y lo persiste. Best-effort: si ni esto sale, no lanza. */
async function enviarFallback(
  sock: WASocket,
  jid: string,
  phone: string,
  conversationId: number
): Promise<void> {
  // Cuenta el evento para la alarma del watchdog (picos de mensajes de emergencia).
  registrarFallback(conversationId);
  // SAFETY GATE: ni siquiera el aviso suave sale si los gates están cerrados.
  if (!canSendRealWhatsApp(phone)) return;
  try {
    const fb = saneaHumano(RESPUESTA_FALLBACK);
    insertMessage(conversationId, "assistant", fb);
    await sock.sendMessage(jid, { text: fb });
  } catch {
    // si ni el fallback se puede enviar, el error original ya quedó en el log
  }
}

// ── SERIALIZACIÓN POR TELÉFONO ──────────────────────────────
// El procesado de un mensaje puede esperar en un `await` (transcribir una
// nota de voz, describir una imagen). Sin esta puerta, un "1097" mandado en
// AUDIO seguido de un "todo correcto" en TEXTO se procesarían fuera de
// orden: el texto adelantaría al audio, y la confirmación llegaría ANTES que
// la selección de pedido — exactamente la carrera que la máquina de estados
// multi-pedido no puede permitirse. Cada teléfono procesa sus mensajes en
// orden de llegada; teléfonos distintos no se bloquean entre sí.
const colaPorTelefono = new Map<string, Promise<void>>();

/** Encadena `fn` tras el último mensaje pendiente de este teléfono. */
export async function runSerializedByPhone(phone: string, fn: () => Promise<void>): Promise<void> {
  const anterior = colaPorTelefono.get(phone) ?? Promise.resolve();
  let liberar!: () => void;
  const propio = new Promise<void>((r) => (liberar = r));
  colaPorTelefono.set(
    phone,
    anterior.then(() => propio)
  );
  await anterior;
  try {
    await fn();
  } finally {
    liberar();
    // Limpieza: si nadie más se encoló detrás, el mapa no crece sin límite.
    if (colaPorTelefono.get(phone) === propio) colaPorTelefono.delete(phone);
  }
}


export async function handleIncomingMessages(
  sock: WASocket,
  event: BaileysEventMap["messages.upsert"]
): Promise<void> {
  if (event.type !== "notify") return;

  for (const msg of event.messages) {
    if (msg.key.fromMe) continue;

    const remoteJid = msg.key.remoteJid ?? "";
    if (
      remoteJid.endsWith("@g.us") ||
      remoteJid.endsWith("@broadcast") ||
      remoteJid.endsWith("@newsletter")
    ) {
      continue;
    }
    if (!remoteJid.endsWith("@s.whatsapp.net") && !remoteJid.endsWith("@lid")) continue;

    // Identidad ANTES que nada: todas las decisiones de seguridad de aquí en
    // adelante dependen del teléfono canónico.
    const senderPn = msg.key.senderPn ?? undefined;
    const phone = canonicalPhone(remoteJid, senderPn);
    if (remoteJid.endsWith("@lid")) {
      if (senderPn) {
        logger.info(`[bot] @lid resuelto a número real ${phoneMasked(phone)}`);
        // Reconcilia una conversación antigua creada bajo el LID (antes de este
        // arreglo): la re-indexa o fusiona con la del número real, sin duplicar.
        reconcileLidToPn(remoteJid.split("@")[0].split(":")[0], phone, remoteJid);
      } else {
        logger.warn("[bot] mensaje @lid sin senderPn: uso el LID como identidad (degradado)");
      }
    }
    const pushName = msg.pushName ?? undefined;

    // Todo lo que sigue corre SERIALIZADO por teléfono (ver arriba).
    await runSerializedByPhone(phone, async () => {

      // ¿Este teléfono está en medio de una confirmación? ¿Hay agente IA activo?
      // SEGURIDAD: un número SIN pedido activo y SIN agente IA es una
      // conversación personal o desconocida: JAMÁS se le responde nada (ni
      // "no encuentro tu pedido"). Solo se guarda el texto para el panel.
      //
      // El agente IA del kit exige DOBLE opt-in (key + AI_AGENT_ENABLED=1):
      // tener una OPENROUTER_API_KEY suelta en el .env jamás debe bastar para
      // que un bot comercial charle con los clientes COD de Casamable.
      const hasActiveOrders = getActiveOrdersByPhone(phone).length > 0;
      const aiActive =
        Boolean(process.env.OPENROUTER_API_KEY) && process.env.AI_AGENT_ENABLED === "1";

      // Texto directo o, si es nota de voz, la transcripción.
      let text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? null;
      const isAudio = Boolean(msg.message?.audioMessage);
      const isImage = Boolean(msg.message?.imageMessage);

      if ((!text || text.trim() === "") && isAudio) {
        if (!hasActiveOrders && !aiActive) {
          logger.info(`[bot] nota de voz de ${phoneMasked(phone)} sin pedido activo — ignorada`);
          return;
        }
        text = await transcribeIncomingAudio(sock, msg, phone);
        if (text === null) return; // ya se le pidió por escrito (vía outbox, con gates)
      }

      // Imagen: el agente la "ve" a través de una descripción del modelo de visión.
      if (isImage) {
        const caption = msg.message?.imageMessage?.caption?.trim() || undefined;
        if (!hasActiveOrders && !aiActive) {
          if (!caption) {
            logger.info(`[bot] imagen de ${phoneMasked(phone)} sin pedido activo — ignorada`);
            return;
          }
          text = caption; // se guarda el texto que la acompaña, sin responder nada
        } else {
          const desc = await describeIncomingImage(sock, msg);
          if (desc) {
            text = caption
              ? `${caption}\n[El cliente ha enviado una imagen: ${desc}]`
              : `[El cliente ha enviado una imagen: ${desc}]`;
          } else if (caption) {
            text = caption; // no se pudo ver, pero al menos hay texto que la acompaña
          } else {
            sendWhatsAppMessage(
              phone,
              "He recibido tu imagen pero no consigo verla bien. ¿Me cuentas qué es o qué necesitas?",
              { name: pushName }
            );
            return;
          }
        }
      }

      if (!text || text.trim() === "") {
        // Sticker, documento, etc. — fuera de alcance por ahora.
        return;
      }

      logger.info(`[bot] ← ${isAudio ? "(voz) " : isImage ? "(imagen) " : ""}mensaje de ${phoneMasked(phone)}: "${text.slice(0, 60)}"`);

      const convo = getOrCreateConversation(phone, pushName, remoteJid);

      // Guardrail de entrada: trunca lo desproporcionado y corta el flood.
      // En flood simplemente NO respondemos (ni gastamos ni alimentamos abuso).
      const inbound = guardInbound(convo.id, text);
      insertMessage(convo.id, "user", inbound.text);
      logMessage(phone, "user", inbound.text); // espejo a Supabase (best-effort)
      if (!inbound.allowed) {
        logger.warn(`[guardrails] entrada bloqueada (${inbound.reason}) — no respondo a ${phoneMasked(phone)}`);
        return;
      }

      // Si un humano tomó la conversación desde el dashboard, el bot calla.
      const fresh = getConversationById(convo.id);
      if (!fresh || fresh.mode !== "AI") {
        logger.info(`[bot] conversación ${convo.id} en modo HUMAN, no respondo`);
        return;
      }

      // --- Confirmación de pedidos COD (determinista, SIN IA, coste 0) ---
      // Si este teléfono tiene pedidos activos, la respuesta se resuelve aquí al
      // instante (sin buffer de agrupación) y el flujo de IA no interviene.
      // Va por el outbox (sendWhatsAppMessage) para heredar sus reintentos.
      // A propósito NO respeta la pausa global: es transaccional, no el agente.
      const orderResult = handleOrderReply(phone, inbound.text);
      if (orderResult.handled) {
        if (orderResult.reply) {
          sendWhatsAppMessage(phone, orderResult.reply, {
            name: pushName,
            orderAuthorized: orderResult.authorized === true,
          });
        }
        return;
      }

      // Pausa global desde Ajustes: el mensaje se guarda y se ve en el panel,
      // pero el agente no responde a nadie hasta reanudar.
      if (getSetting("paused") === "1") {
        logger.info(`[bot] en PAUSA global — mensaje de ${phoneMasked(phone)} guardado, no respondo`);
        return;
      }

      // Sin doble opt-in (OPENROUTER_API_KEY + AI_AGENT_ENABLED=1) el agente de
      // IA está desactivado: el mensaje queda guardado y visible en el panel
      // (pestaña Chats), pero no se responde.
      if (!aiActive) {
        logger.info(`[bot] agente IA desactivado — mensaje de ${phoneMasked(phone)} guardado`);
        return;
      }

      // SAFETY GATE: la IA tampoco responde si los gates no permiten enviar a
      // este teléfono (safe mode, flags, emergency stop, allowlist).
      if (!canSendRealWhatsApp(phone)) {
        logOnce(
          `ai-blocked-${phone}`,
          `[SAFE MODE] respuesta del agente IA omitida para ${phoneMasked(phone)} (gates cerrados)`
        );
        return;
      }

      scheduleReply(sock, convo.id, remoteJid, phone);
    });
  }
}

/** (Re)programa la respuesta agrupada tras BUFFER_MS de silencio. */
function scheduleReply(sock: WASocket, conversationId: number, jid: string, phone: string): void {
  const existing = pending.get(conversationId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(conversationId);
    void generateAndSend(sock, conversationId, jid, phone);
  }, bufferMs());

  pending.set(conversationId, { timer, jid, phone });

  // Señal de vida durante la espera: "escribiendo…" (best-effort).
  void sock.sendPresenceUpdate("composing", jid).catch(() => {});
}

/** Genera y envía UNA respuesta a todo lo acumulado en la conversación. */
async function generateAndSend(
  sock: WASocket,
  conversationId: number,
  jid: string,
  phone: string
): Promise<void> {
  const fresh = getConversationById(conversationId);
  if (!fresh || fresh.mode !== "AI") return; // pudo pasar a HUMAN durante la espera

  // SAFETY GATE (cinturón extra): los gates pudieron cerrarse durante el buffer.
  if (!canSendRealWhatsApp(phone)) return;

  const start = Date.now();
  try {
    const history = getRecentHistory(conversationId, 20);

    // Memoria de largo plazo: qué sabemos de esta persona de conversaciones
    // anteriores (Supabase). Degrada en silencio si no está configurada o falla.
    // El resumen de lo hablado solo se inyecta si VUELVE tras un rato (>1h desde
    // la última vez); en una charla en curso sería redundante con el historial.
    let memoryContext = "";
    try {
      const mem = await getLeadMemory(phone);
      if (mem) {
        const lastSeenMs = mem.last_seen ? Date.parse(mem.last_seen) : 0;
        const reencuentro = !lastSeenMs || Date.now() - lastSeenMs > 60 * 60 * 1000;
        memoryContext = memoryToPrompt(mem, reencuentro);
      }
    } catch {
      memoryContext = "";
    }
    logger.info(
      `[bot] llamando al LLM con ${history.length} mensajes${memoryContext ? " + memoria" : ""}...`
    );

    const reply = await generateReply({ history, conversationId, memoryContext });
    if (!reply || reply.trim() === "") {
      logger.warn("[bot] LLM devolvió respuesta vacía, envío aviso suave");
      await enviarFallback(sock, jid, phone, conversationId);
      return;
    }

    // Contexto del lead (lo que ha escrito) para que el guard permita que el
    // agente repita cifras que mencionó el propio lead (p.ej. lo que cobró a un cliente).
    const contextoLead = history.filter((m) => m.role === "user").map((m) => m.content).join(" ");
    const guard = guardOutbound(reply, contextoLead);
    if (!guard.ok) {
      logger.warn(`[guardrails] respuesta bloqueada (${guard.reason}) — enviado fallback`);
      const fb = saneaHumano(GUARD_FALLBACK);
      insertMessage(conversationId, "assistant", fb);
      await sock.sendMessage(jid, { text: fb });
      return;
    }

    // El modelo puede pedir varios mensajes (con "|||") para adaptarse a quien
    // escribe a ráfagas. Se envían por separado, con "escribiendo…" y un
    // pequeño retardo entre ellos para que suene humano.
    const partes = dividirMensajes(reply);
    for (let i = 0; i < partes.length; i++) {
      if (i > 0) {
        await sock.sendPresenceUpdate("composing", jid).catch(() => {});
        await new Promise((r) => setTimeout(r, delayEscritura(partes[i])));
      }
      await sock.sendMessage(jid, { text: partes[i] });
      insertMessage(conversationId, "assistant", partes[i]);
      logMessage(phone, "assistant", partes[i]); // espejo a Supabase (best-effort)
    }
    // Memoria de largo plazo: guarda el nombre de WhatsApp (si falta) y un
    // resumen de lo último hablado, para reconocer a esta persona si vuelve.
    void rememberConversation(phone, {
      waName: fresh.name,
      resumen: resumenConversacion(history, partes.join("\n")),
    });
    logger.info(`[bot] → (${Date.now() - start}ms) ${partes.length} msg a ${phoneMasked(phone)}: "${partes[0]?.slice(0, 50)}"`);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      `[bot] error procesando mensaje de ${phoneMasked(phone)}`
    );
    // No dejar al lead con "escribiendo…" y silencio si falla el LLM/red/saldo.
    await enviarFallback(sock, jid, phone, conversationId);
  }
}

/**
 * Descarga y transcribe una nota de voz. Devuelve el texto, o null si no se
 * pudo (en cuyo caso ya se ha pedido al cliente que escriba — vía outbox, que
 * respeta los safety gates: en safe mode no sale nada).
 */
async function transcribeIncomingAudio(
  sock: WASocket,
  msg: WAMessage,
  phone: string
): Promise<string | null> {
  // Audios desactivados desde Ajustes, o sin transcripción disponible.
  if (getSetting("audio_enabled") === "0" || !transcriptionConfigured()) {
    sendWhatsAppMessage(
      phone,
      "Perdona, ahora mismo no puedo escuchar notas de voz. ¿Me lo escribes en un mensaje y te ayudo al momento?"
    );
    return null;
  }

  try {
    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )) as Buffer;

    const text = await transcribeAudio(buffer);
    if (text && text.trim()) return text.trim();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[bot] error transcribiendo audio"
    );
  }

  sendWhatsAppMessage(phone, "No he conseguido entender bien el audio. ¿Me lo escribes en un mensaje, porfa?");
  return null;
}

/**
 * Descarga y describe una imagen entrante con el modelo de visión. Devuelve la
 * descripción, o null si la visión está apagada, no hay OpenRouter o falla (en
 * ese caso el handler decide el fallback).
 */
async function describeIncomingImage(sock: WASocket, msg: WAMessage): Promise<string | null> {
  if (getSetting("vision_enabled") === "0" || !visionConfigured()) return null;
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )) as Buffer;
    const mimetype = msg.message?.imageMessage?.mimetype ?? "image/jpeg";
    const caption = msg.message?.imageMessage?.caption ?? undefined;
    return await describeImage(buffer, mimetype, caption);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[bot] error interpretando imagen"
    );
    return null;
  }
}
