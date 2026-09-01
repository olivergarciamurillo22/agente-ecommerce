// ============================================================
// SAFETY GATES — el único lugar del código que decide si una acción EXTERNA
// (WhatsApp real, escritura en Shopify) está permitida.
//
// Principio: es preferible que el sistema NO haga nada a que actúe sobre un
// cliente equivocado. Todo por defecto BLOQUEADO; producción exige varias
// decisiones explícitas simultáneas:
//
//   WhatsApp real  = APP_MODE=production AND WHATSAPP_SEND_ENABLED=1
//                    AND EMERGENCY_STOP=0 AND teléfono permitido por TEST_MODE
//   Shopify write  = APP_MODE=production AND SHOPIFY_WRITE_ENABLED=1
//                    AND EMERGENCY_STOP=0
//
// Ninguna ruta (scheduler, handler, outbox, acciones manuales, scripts, tests)
// debe llamar a Baileys ni a la Admin API sin pasar por estas funciones.
// ============================================================

import pino from "pino";
import { normalizePhone } from "./orders/normalize";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export type AppMode = "safe" | "production";

/** APP_MODE con default y fallback SIEMPRE a "safe" (valor raro = safe). */
export function appMode(): AppMode {
  return process.env.APP_MODE === "production" ? "production" : "safe";
}

/** EMERGENCY_STOP: por defecto ACTIVADO. Solo "0" explícito lo desactiva. */
export function emergencyStop(): boolean {
  return process.env.EMERGENCY_STOP !== "0";
}

/** TEST_MODE: por defecto ACTIVADO. Solo "0" explícito lo desactiva. */
export function testMode(): boolean {
  return process.env.TEST_MODE !== "0";
}

/**
 * Allowlist de teléfonos de prueba, normalizada con la MISMA función que los
 * teléfonos de los pedidos (normalizePhone añade el prefijo de país a números
 * nacionales). Así "600111222", "+34 600 11 12 22" y "34600111222" son el
 * mismo teléfono: un fallo de formato jamás convierte un número no autorizado
 * en autorizado ni al revés.
 */
export function phoneAllowlist(): string[] {
  return (process.env.TEST_PHONE_ALLOWLIST ?? "")
    .split(",")
    .map((p) => normalizePhone(p))
    .filter(Boolean);
}

// ============================================================
// RAMPA DE ROLLOUT de WhatsApp automático (02-09).
//
// Pedro quiere pasar de "solo la allowlist" a "todos los clientes" SIN un
// salto al vacío (TEST_MODE=0 abre cinco sistemas a la vez). La rampa vive
// en settings (cambiable desde Ajustes sin desplegar):
//
//   whatsapp_rollout_percent = 'pilot' | '25' | '50' | '100'
//
//   pilot (default y cualquier valor raro) → comportamiento actual EXACTO:
//                                            solo allowlist. FAIL-CLOSED.
//   25/50/100 → además de la allowlist, entran los teléfonos cuyo bucket
//               DETERMINISTA (hash del número, 0-99) sea < N.
//
// Determinista a propósito: el mismo cliente siempre cae en el mismo lado
// de la rampa — subir de 25 a 50 AÑADE clientes, nunca cambia los que ya
// estaban dentro. Nada de Math.random().
// ============================================================

/** Bucket estable 0-99 por teléfono (FNV-1a sobre los dígitos). */
export function rolloutBucket(phone: string): number {
  const digits = normalizePhone(phone ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < digits.length; i++) {
    h ^= digits.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

/** La rampa configurada. Cualquier cosa que no sea 25/50/100 = 'pilot'. */
export function whatsappRolloutPercent(): number {
  try {
    // Import perezoso inevitable: safety.ts se carga antes que la DB en
    // algunos scripts; sin DB, la rampa es 'pilot' (fail-closed).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSetting } = require("./db") as typeof import("./db");
    const v = (getSetting("whatsapp_rollout_percent") ?? "").trim();
    if (v === "25" || v === "50" || v === "100") return parseInt(v, 10);
    return 0;
  } catch {
    return 0;
  }
}

/** ¿La rampa deja pasar a este teléfono? (0/'pilot' → nunca amplía nada). */
export function rolloutAllows(phone: string): boolean {
  const pct = whatsappRolloutPercent();
  if (pct <= 0) return false;
  const normalized = normalizePhone(phone ?? "");
  if (!normalized) return false;
  return rolloutBucket(normalized) < pct;
}

/**
 * ¿Puede el sistema actuar sobre este teléfono?
 * Con TEST_MODE=1 (default) SOLO los de TEST_PHONE_ALLOWLIST son elegibles
 * — más los que entren por la RAMPA de rollout si Pedro la ha subido desde
 * Ajustes (whatsapp_rollout_percent; default 'pilot' = sin cambio alguno).
 */
export function phoneAllowed(phone: string): boolean {
  if (!testMode()) return true;
  const normalized = normalizePhone(phone ?? "");
  if (!normalized) return false; // sin teléfono válido, jamás elegible
  if (phoneAllowlist().includes(normalized)) return true;
  return rolloutAllows(normalized);
}

/**
 * Acciones MANUALES del dashboard con efecto externo (confirmar → tag Shopify,
 * reenviar → WhatsApp): en TEST_MODE solo sobre pedidos de la allowlist.
 */
export function canOperateOnOrderManually(phone: string): { ok: boolean; reason?: string } {
  if (!testMode()) return { ok: true };
  if (phoneAllowed(phone)) return { ok: true };
  return {
    ok: false,
    reason:
      "TEST_MODE activo: este pedido no está en TEST_PHONE_ALLOWLIST. " +
      "Las acciones con efecto externo solo se permiten sobre teléfonos de prueba.",
  };
}

/** ¿Los interruptores generales permiten CUALQUIER acción externa? */
export function externalActionsLocked(): boolean {
  return emergencyStop();
}

/** Opciones de los gates. `orderAuthorized` SOLO relaja la comprobación de
 *  allowlist de TEST_MODE (autorización manual por pedido). NUNCA salta el
 *  kill switch, el APP_MODE ni los flags de envío/escritura. */
export interface GateOptions {
  orderAuthorized?: boolean;
}

/**
 * GATE CENTRAL de WhatsApp: solo envía de verdad si TODAS las llaves están
 * abiertas Y el destinatario es elegible (allowlist, o pedido autorizado a
 * mano para el piloto). Cualquier otra combinación → NO SEND.
 */
export function canSendRealWhatsApp(phone: string, opts: GateOptions = {}): boolean {
  if (emergencyStop()) return false;
  if (appMode() !== "production") return false;
  if (process.env.WHATSAPP_SEND_ENABLED !== "1") return false;
  if (!phoneAllowed(phone) && !opts.orderAuthorized) return false;
  // Un pedido autorizado sigue necesitando un teléfono real.
  if (opts.orderAuthorized && !normalizePhone(phone)) return false;
  return true;
}

// ============================================================
// Ventana horaria de envío (hora de España)
//
// Fuera de ella los pedidos se guardan con normalidad, pero el mensaje
// INICIAL espera a la siguiente apertura. Nadie recibe un WhatsApp de
// madrugada. Las RESPUESTAS al cliente no se retienen: si escribe a las 2
// de la mañana, se le contesta — sería peor dejarlo colgado.
// ============================================================

/** Convierte "HH:MM" a minutos desde medianoche. Inválido → fallback. */
function parseHhMm(value: string | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

export function windowStartMinutes(): number {
  return parseHhMm(process.env.WHATSAPP_WINDOW_START, 9 * 60);
}
export function windowEndMinutes(): number {
  return parseHhMm(process.env.WHATSAPP_WINDOW_END, 21 * 60);
}

/** ¿Está desactivada la ventana horaria? (WHATSAPP_WINDOW_ENABLED=0) */
export function windowDisabled(): boolean {
  return process.env.WHATSAPP_WINDOW_ENABLED === "0";
}

const TIMEZONE = () => process.env.WHATSAPP_TIMEZONE || "Europe/Madrid";

/** Minutos desde medianoche en la zona horaria configurada (por defecto España). */
export function localMinutesNow(nowMs?: number): number {
  const d = new Date(nowMs ?? Date.now());
  const parts = new Intl.DateTimeFormat("es-ES", {
    timeZone: TIMEZONE(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h % 24) * 60 + m;
}

/** ¿Estamos DENTRO de la ventana de envío? */
export function insideSendWindow(nowMs?: number): boolean {
  if (windowDisabled()) return true;
  const start = windowStartMinutes();
  const end = windowEndMinutes();
  const now = localMinutesNow(nowMs);
  // Ventana normal (09:00-21:00) o nocturna que cruza medianoche (22:00-06:00).
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Epoch (segundos) de la próxima apertura de la ventana. Si ya estamos
 * dentro, devuelve `now`. Se calcula por diferencia de minutos locales, así
 * que un salto de horario solo lo desvía una hora — y el envío real lo sigue
 * gobernando insideSendWindow(), no este valor.
 */
export function nextWindowOpen(nowMs?: number): number {
  const ms = nowMs ?? Date.now();
  const nowSec = Math.floor(ms / 1000);
  if (insideSendWindow(ms)) return nowSec;
  const start = windowStartMinutes();
  const now = localMinutesNow(ms);
  const minutesUntil = now < start ? start - now : 24 * 60 - now + start;
  return nowSec + minutesUntil * 60;
}

/** Texto legible de la ventana, para logs y dashboard. */
export function windowLabel(): string {
  if (windowDisabled()) return "sin restricción horaria";
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${fmt(windowStartMinutes())}–${fmt(windowEndMinutes())} (${TIMEZONE()})`;
}

/** GATE CENTRAL de escrituras Shopify (hoy solo tagsAdd WA_CONFIRMED). */
export function canWriteToShopify(): boolean {
  if (emergencyStop()) return false;
  if (appMode() !== "production") return false;
  if (process.env.SHOPIFY_WRITE_ENABLED !== "1") return false;
  return true;
}

/**
 * ¿Se puede actuar sobre ESTE pedido? Combina la allowlist de TEST_MODE con
 * la autorización manual de piloto, que es por pedido concreto: autorizar uno
 * jamás autoriza otros pedidos del mismo teléfono ni de otros clientes.
 */
export function orderActionAllowed(order: { phone: string; pilot_authorized?: number }): boolean {
  if (!testMode()) return true;
  if (phoneAllowed(order.phone)) return true;
  return order.pilot_authorized === 1 && Boolean(normalizePhone(order.phone));
}

/** Antigüedad máxima (min) de un pedido para iniciar acciones. Default 30. */
export function maxOrderAgeMinutes(): number {
  const v = parseFloat(process.env.MAX_ORDER_AGE_MINUTES ?? "");
  return Number.isFinite(v) && v > 0 ? v : 30;
}

/** ¿El pedido es demasiado antiguo para actuar (replay/backfill/restos dev)? */
export function orderTooOld(createdAtEpochSec: number, nowSec?: number): boolean {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  return now - createdAtEpochSec > maxOrderAgeMinutes() * 60;
}

/** Teléfono enmascarado para logs: 34644XXXXX17 → nunca el número completo. */
export function maskPhone(phone: string): string {
  const p = (phone ?? "").replace(/\D/g, "");
  if (p.length <= 5) return "***";
  return `${p.slice(0, 3)}${"X".repeat(p.length - 5)}${p.slice(-2)}`;
}

// --- Log sin spam: cada clave se registra UNA vez por proceso ---
const loggedOnce = new Set<string>();

export function logOnce(key: string, message: string): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  logger.info(message);
}

/** Solo para tests: resetea el antispam de logOnce. */
export function _resetLogOnce(): void {
  loggedOnce.clear();
}

/**
 * Registra la simulación de un envío bloqueado (formato pedido por Pedro).
 * Una sola vez por clave para no inundar el log en cada tick.
 */
export function logBlockedSend(key: string, phone: string, message: string): void {
  logOnce(
    key,
    `[SAFE MODE] WhatsApp NO enviado | Destino: ${maskPhone(phone)} | Mensaje preparado: "${message
      .replace(/\s+/g, " ")
      .slice(0, 90)}…"`
  );
}

export interface SafetyStatus {
  mode: AppMode;
  testMode: boolean;
  whatsappSendEnabled: boolean;
  shopifyWriteEnabled: boolean;
  emergencyStop: boolean;
  allowlistCount: number;
  maxOrderAgeMinutes: number;
  /** true si con la config actual ES posible un envío real (a algún teléfono) */
  realSendPossible: boolean;
  realShopifyWritePossible: boolean;
  /** Ventana horaria de envío */
  windowLabel: string;
  insideWindow: boolean;
}

export function safetyStatus(): SafetyStatus {
  const sendFlags =
    !emergencyStop() && appMode() === "production" && process.env.WHATSAPP_SEND_ENABLED === "1";
  return {
    mode: appMode(),
    testMode: testMode(),
    whatsappSendEnabled: process.env.WHATSAPP_SEND_ENABLED === "1",
    shopifyWriteEnabled: process.env.SHOPIFY_WRITE_ENABLED === "1",
    emergencyStop: emergencyStop(),
    allowlistCount: phoneAllowlist().length,
    maxOrderAgeMinutes: maxOrderAgeMinutes(),
    realSendPossible: sendFlags && (!testMode() || phoneAllowlist().length > 0),
    realShopifyWritePossible: canWriteToShopify(),
    windowLabel: windowLabel(),
    insideWindow: insideSendWindow(),
  };
}

/** Banner de arranque: que sea IMPOSIBLE no saber en qué modo estamos. */
export function printSafetyStatus(): void {
  const s = safetyStatus();
  const line = (l: string) => console.log(l);
  line("========================================");
  line("CASAMABLE SAFETY STATUS");
  line("");
  line(`APP_MODE: ${s.mode.toUpperCase()}`);
  line(`TEST_MODE: ${s.testMode ? "ON" : "OFF"}`);
  line(`WhatsApp real: ${s.realSendPossible ? "ENABLED ⚠️" : "BLOCKED"}`);
  line(`Shopify writes: ${s.realShopifyWritePossible ? "ENABLED ⚠️" : "BLOCKED"}`);
  line(`Emergency stop: ${s.emergencyStop ? "ON" : "OFF"}`);
  line(`Allowed test phones: ${s.allowlistCount}`);
  line("");
  if (!s.realSendPossible && !s.realShopifyWritePossible) {
    line("NO REAL CUSTOMER ACTIONS WILL OCCUR");
  } else if (s.testMode) {
    line("⚠️ ENVÍOS REALES ACTIVOS — limitados a la allowlist de prueba");
  } else {
    line("🚨🚨 PRODUCTION SIN TEST_MODE: CUALQUIER CLIENTE REAL PUEDE RECIBIR");
    line("🚨🚨 MENSAJES/CAMBIOS. Asegúrate de que esto es intencionado.");
  }
  line("========================================");
}
