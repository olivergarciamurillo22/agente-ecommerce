// ============================================================
// Watchdog · el sistema que audita al agente y avisa por WhatsApp.
//
// Vive en el MISMO proceso del bot (usa su conexión para enviar los avisos al
// número del dueño, ALERT_WHATSAPP). Tres niveles:
//   1. Vigilante en tiempo real: detecta bot mudo (leads sin respuesta) y saldo
//      bajo de OpenRouter, y avisa al instante (con anti-spam de 30 min).
//   2. Auditor diario con IA: una vez al día lee las conversaciones y manda un
//      parte (leads a rescatar, fallos del agente).
//   3. Sugerencias: el mismo parte propone mejoras concretas del guion para que
//      TÚ las apruebes (nunca se aplican solas — el prompt es crítico).
//
// TODO es best-effort: nunca debe romper el bot. Si no hay ALERT_WHATSAPP, corre
// igual pero solo registra en el log (no envía). Para el caso "el contenedor
// entero se cae" (donde WhatsApp no puede avisar) está /api/health + ping externo.
// ============================================================

import type { WASocket } from "@whiskeysockets/baileys";
import pino from "pino";
import {
  getUnansweredConversations,
  listConversations,
  getMessages,
  getSetting,
  setSetting,
} from "./db";
import { completeText } from "./openrouter";
import { canSendRealWhatsApp } from "./safety";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const ALERT_JID = process.env.ALERT_WHATSAPP
  ? `${process.env.ALERT_WHATSAPP.replace(/\D/g, "")}@s.whatsapp.net`
  : null;

const TICK_MS = 5 * 60 * 1000; // cada 5 minutos
const MUTE_MIN_SEC = 180; // sin responder > 3 min = sospechoso
const MUTE_MAX_SEC = 2 * 60 * 60; // pero no rescatar conversaciones de > 2h
const BALANCE_MIN_USD = 2; // avisar si el saldo de OpenRouter baja de esto
const REALERT_SEC = 30 * 60; // no repetir la misma alerta antes de 30 min
const DAILY_EVERY_SEC = 20 * 60 * 60; // auditoría diaria si han pasado > 20h
const FALLBACK_WINDOW_SEC = 15 * 60; // ventana para contar mensajes de emergencia
const FALLBACK_THRESHOLD = 3; // nº de mensajes de emergencia en la ventana que dispara la alarma

let currentSock: WASocket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// --- Anti-spam: la marca se pone SOLO tras un envío correcto ---
function enCooldown(clave: string): boolean {
  const last = Number(getSetting(`wd_${clave}`) || 0);
  return Math.floor(Date.now() / 1000) - last < REALERT_SEC;
}
function marcarAlerta(clave: string): void {
  try {
    setSetting(`wd_${clave}`, String(Math.floor(Date.now() / 1000)));
  } catch {
    /* settings best-effort */
  }
}

async function sendAlert(text: string): Promise<boolean> {
  if (!ALERT_JID) {
    logger.warn(`[watchdog] (sin ALERT_WHATSAPP) aviso no enviado: ${text.slice(0, 90)}`);
    return false;
  }
  // SAFETY GATE: incluso los avisos al dueño pasan por los gates (en safe
  // mode quedan solo en el log; en test mode, su número debe estar en la allowlist).
  const alertPhone = (process.env.ALERT_WHATSAPP ?? "").replace(/\D/g, "");
  if (!canSendRealWhatsApp(alertPhone)) {
    logger.warn(`[SAFE MODE] aviso del watchdog RETENIDO (gates cerrados): ${text.slice(0, 90)}`);
    return false;
  }
  if (!currentSock) return false;
  try {
    await currentSock.sendMessage(ALERT_JID, { text });
    logger.info("[watchdog] aviso enviado al dueño");
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[watchdog] no pude enviar el aviso");
    return false;
  }
}

// --- Nivel 1a · ¿el bot se ha quedado mudo? ---
async function checkMute(): Promise<void> {
  // Sin agente IA activo (doble opt-in), no responder chats es lo esperado.
  if (!process.env.OPENROUTER_API_KEY || process.env.AI_AGENT_ENABLED !== "1") return;
  if (getSetting("paused") === "1") return; // en pausa global es normal no responder
  const pendientes = getUnansweredConversations(MUTE_MIN_SEC, MUTE_MAX_SEC);
  if (pendientes.length === 0 || enCooldown("mute")) return;

  const quien = pendientes
    .slice(0, 5)
    .map((c) => `- ${c.name || c.phone}`)
    .join("\n");
  const extra = pendientes.length > 5 ? `\n(y ${pendientes.length - 5} más)` : "";
  const ok = await sendAlert(
    `⚠️ El agente lleva sin responder a ${pendientes.length} lead(s):\n${quien}${extra}\n\n` +
      `Míralo en el panel. Suele ser: saldo de OpenRouter agotado, error del modelo o desconexión de WhatsApp.`
  );
  if (ok) marcarAlerta("mute");
}

// --- Nivel 1b · ¿queda saldo en OpenRouter? ---
async function checkBalance(): Promise<void> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || enCooldown("balance")) return;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return;
    const j = (await r.json()) as { data?: { total_credits?: number; total_usage?: number } };
    const total = j?.data?.total_credits;
    const usage = j?.data?.total_usage;
    if (typeof total !== "number" || typeof usage !== "number") return;
    const restante = total - usage;
    if (restante < BALANCE_MIN_USD) {
      const ok = await sendAlert(
        `💳 Saldo de OpenRouter bajo: quedan ~$${restante.toFixed(2)}.\n\n` +
          `Recarga para que el agente siga respondiendo. Y activa el auto-topup en openrouter.ai para no depender de esto.`
      );
      if (ok) marcarAlerta("balance");
    }
  } catch {
    /* silencioso: la comprobación de saldo nunca debe romper nada */
  }
}

// --- Nivel 1c · ¿el bot suelta el mensaje de emergencia en bucle? ---
// Marcas (en segundos) de cada vez que el bot mandó el aviso de emergencia
// (respuesta vacía o error del LLM). Vive en memoria del proceso del bot y se
// poda sola a la ventana; si el proceso reinicia, se resetea (solo importan los
// picos recientes). El handler la alimenta llamando a registrarFallback().
const fallbackHits: { t: number; conv: number }[] = [];

/** Lo llama el handler cada vez que manda el mensaje de emergencia. Sin I/O. */
export function registrarFallback(conversationId: number): void {
  const now = Math.floor(Date.now() / 1000);
  fallbackHits.push({ t: now, conv: conversationId });
  const corte = now - FALLBACK_WINDOW_SEC;
  while (fallbackHits.length && fallbackHits[0].t < corte) fallbackHits.shift();
}

// El bot "responde" (manda el aviso de emergencia), así que checkMute NO lo pilla.
// Esta alarma sí: si el aviso salta varias veces en pocos minutos, algo va mal de
// verdad (saldo, error del modelo, una tool rota) aunque el bot no esté mudo.
async function checkFallbackSpike(): Promise<void> {
  const corte = Math.floor(Date.now() / 1000) - FALLBACK_WINDOW_SEC;
  const recientes = fallbackHits.filter((h) => h.t >= corte);
  if (recientes.length < FALLBACK_THRESHOLD || enCooldown("fallback")) return;

  const leads = new Set(recientes.map((h) => h.conv)).size;
  const mins = Math.round(FALLBACK_WINDOW_SEC / 60);
  const ok = await sendAlert(
    `🚨 El agente está mandando el mensaje de emergencia en bucle: ${recientes.length} veces en ${mins} min (a ${leads} lead${leads === 1 ? "" : "s"}).\n\n` +
      `Significa que NO está respondiendo de verdad. Suele ser: saldo de OpenRouter agotado, error del modelo o una herramienta rota. ` +
      `Míralo YA en el panel; si hace falta, pasa las conversaciones a modo Humano mientras se arregla.`
  );
  if (ok) marcarAlerta("fallback");
}

// --- Nivel 2 + 3 · auditoría diaria con IA + sugerencias ---
const AUDITOR_SYSTEM = `Eres el auditor de calidad de un agente de IA que atiende y vende por WhatsApp para un negocio. Te paso las conversaciones de las últimas 24h. Analízalas y escribe un PARTE BREVE para el dueño del negocio, en TEXTO PLANO para WhatsApp: sin markdown, sin asteriscos, sin guiones largos. Usa este formato exacto:

📊 PARTE DIARIO

Resumen: (nº de conversaciones y de leads nuevos).

🔥 Leads a rescatar: (los que mostraron interés real pero se fueron sin dar el email o sin cerrar — pon nombre o teléfono y en una línea por qué; si no hay, "sin novedad").

⚠️ Fallos o cosas raras: (preguntas que no supo responder, objeciones mal llevadas, respuestas vacías o incoherentes, posibles bugs; si no hay, "sin novedad").

💡 Mejoras sugeridas: (1 a 3 cambios CONCRETOS al guion o datos que le faltan, para vender mejor. Si sugieres añadir info, di exactamente qué. Estas mejoras las revisa el dueño antes de aplicarlas).

Sé concreto y breve (tiene que caber cómodo en un WhatsApp). No inventes nada: básate SOLO en las conversaciones que te paso.`;

async function runDailyAudit(): Promise<void> {
  // Solo con el agente IA activo (doble opt-in) tiene sentido el parte diario.
  if (!process.env.OPENROUTER_API_KEY || process.env.AI_AGENT_ENABLED !== "1") return;
  const now = Math.floor(Date.now() / 1000);
  const last = Number(getSetting("wd_last_daily") || 0);
  if (now - last < DAILY_EVERY_SEC) return;

  const since = now - 24 * 60 * 60;
  const convos = listConversations()
    .filter((c) => (c.last_message_at ?? c.created_at ?? 0) >= since)
    .slice(0, 40);

  if (convos.length === 0) {
    setSetting("wd_last_daily", String(now)); // no hay nada que auditar hoy
    return;
  }

  const transcripts = convos
    .map((c) => {
      const msgs = getMessages(c.id, 30);
      const lineas = msgs
        .map((m) => `${m.role === "user" ? "Lead" : "Agente"}: ${m.content.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      return `### ${c.name || c.phone}\n${lineas}`;
    })
    .join("\n\n");

  let parte = "";
  try {
    parte = await completeText(AUDITOR_SYSTEM, `Conversaciones de las últimas 24h:\n\n${transcripts.slice(0, 24000)}`, {
      maxTokens: 900,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[watchdog] falló la auditoría diaria");
    return; // reintenta en el próximo tick (no marcamos wd_last_daily)
  }
  if (!parte.trim()) return;

  // Marcamos la fecha ANTES de enviar para no repetir la auditoría cara si el
  // envío falla; el parte queda guardado para el panel igualmente.
  setSetting("wd_last_daily", String(now));
  setSetting("wd_last_report", parte);
  await sendAlert(parte);
}

async function tick(): Promise<void> {
  try {
    await checkMute();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[watchdog] checkMute");
  }
  try {
    await checkBalance();
  } catch {
    /* ya es silencioso dentro */
  }
  try {
    await checkFallbackSpike();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[watchdog] checkFallbackSpike");
  }
  try {
    await runDailyAudit();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[watchdog] auditoría");
  }
}

/** Arranca el watchdog con el socket actual (se llama al conectar). */
export function startWatchdog(sock: WASocket): void {
  currentSock = sock;
  if (timer) return; // ya estaba corriendo
  logger.info(`[watchdog] activo${ALERT_JID ? "" : " (sin ALERT_WHATSAPP: solo registra en el log)"}`);
  timer = setInterval(() => void tick(), TICK_MS);
}

/** Para el watchdog (se llama al desconectar). */
export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  currentSock = null;
}
