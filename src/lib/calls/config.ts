// ============================================================
// Configuración OPERATIVA del orquestador de llamadas.
//
// Vive en la tabla `settings` (SQLite) para poder cambiarse desde el panel
// SIN desplegar. Los SECRETOS (API key de Retell, número saliente) viven en
// el .env y NUNCA aquí ni en ninguna respuesta del panel.
//
// Cuatro conceptos, cuatro llaves — no se mezclan:
//   AI_CALLS_ENABLED   kill switch. '0' por defecto: tras un deploy NUNCA
//                      sale una llamada hasta activarlo a propósito.
//   CALLS_SHADOW_MODE  '1' por defecto: el scheduler calcula quién/cuándo/
//                      payload y lo registra, pero NO contacta al proveedor.
//   CALLS_ALLOWLIST    csv de teléfonos E.164-sin-+ permitidos. Vacío = sin
//                      restricción de allowlist (pero siguen el resto de gates).
//   CALLS_DAILY_CAP    tope de llamadas reales por día.
// ============================================================

import { getSetting, setSetting } from "../db";

/** Clave en settings (minúsculas) + fallback env (mayúsculas) + default. */
function cfg(key: string, envName: string, def: string): string {
  const db = getSetting(key);
  if (db !== null && db !== "") return db;
  const env = (process.env[envName] ?? "").trim();
  return env !== "" ? env : def;
}

export function aiCallsEnabled(): boolean {
  return cfg("ai_calls_enabled", "AI_CALLS_ENABLED", "0") === "1";
}

export function callsShadowMode(): boolean {
  return cfg("calls_shadow_mode", "CALLS_SHADOW_MODE", "1") === "1";
}

export function callsDailyCap(): number {
  const v = parseInt(cfg("calls_daily_cap", "CALLS_DAILY_CAP", "30"), 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

/** Teléfonos permitidos (dígitos internacionales). Vacío = sin allowlist. */
export function callsAllowlist(): string[] {
  return cfg("calls_allowlist", "CALLS_ALLOWLIST", "")
    .split(",")
    .map((t) => t.replace(/[^\d]/g, ""))
    .filter(Boolean);
}

/**
 * MODO PILOTO DE LLAMADAS — interruptor PROPIO, desacoplado de TEST_MODE.
 *
 * Decisión del 26-08 (noche, con Pedro): el fail-closed original colgaba de
 * TEST_MODE, pero TEST_MODE gobierna además WhatsApp, las escrituras en
 * Shopify y qué pedidos son operativos. Con las llamadas YA en producción
 * real (TEST_MODE=1 en el NAS), desbloquearlas habría exigido TEST_MODE=0:
 * cambiar cinco cosas para arreglar una. Las llamadas tienen su propia llave.
 *
 *   '1' o SIN DEFINIR = piloto (fail-closed): allowlist vacía = NADIE.
 *   '0' EXPLÍCITO     = producción de llamadas: vacía = sin restricción
 *                       (kill switch, cap diario y franja SIEMPRE delante).
 *
 * Prioridad settings.calls_pilot_mode (cambiable sin desplegar, npm run
 * calls:mode) sobre la variable CALLS_PILOT_MODE del .env.
 */
export function callsPilotMode(): boolean {
  return cfg("calls_pilot_mode", "CALLS_PILOT_MODE", "1") !== "0";
}

export function callAllowedByAllowlist(phoneDigits: string): boolean {
  const lista = callsAllowlist();
  if (lista.length === 0) {
    // FAIL-CLOSED EN PILOTO (26-08): allowlist vacía significaba "sin
    // restricción" — lo contrario que TEST_PHONE_ALLOWLIST — y abrir el
    // kill switch con la lista sin rellenar habría llamado a TODOS. En modo
    // piloto (el default; sin definir cuenta como ACTIVO), vacía BLOQUEA a
    // todos. Salir del piloto es una decisión EXPLÍCITA
    // (calls_pilot_mode='0'), no un efecto colateral de TEST_MODE.
    return !callsPilotMode();
  }
  return lista.includes(phoneDigits.replace(/[^\d]/g, ""));
}

/** Minutos sin respuesta al WhatsApp antes de entrar en la cola de llamadas. */
export function callTriggerMinutes(): number {
  const v = parseFloat(cfg("call_trigger_minutes", "CALL_TRIGGER_MINUTES", "15"));
  return Number.isFinite(v) && v > 0 ? v : 15;
}

/** Máximo de CONTACTOS consumibles (inicial + reintentos). */
export function callMaxContacts(): number {
  const v = parseInt(cfg("call_max_contacts", "CALL_MAX_CONTACTS", "5"), 10);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

/**
 * Cadencia de reintentos (decisión de negocio, 24-08-2026): el primer
 * reintento es "pronto" (mínimo estos minutos después, encajado en la
 * franja legal — normalmente el mismo día). Del segundo al cuarto
 * reintento la cadencia es por DÍA DE CALENDARIO, no por delta de minutos
 * — mañana y tarde del día siguiente al primer reintento, y mañana del día
 * después de ese — y vive fija en `planNextAfterResult` (scheduler.ts): no
 * es un ajuste de panel, es la secuencia legal acordada, igual que las
 * franjas horarias.
 */
export function callFirstRetryMinutes(): number {
  const v = parseInt(cfg("call_first_retry_minutes", "CALL_FIRST_RETRY_MINUTES", "120"), 10);
  return Number.isFinite(v) && v > 0 ? v : 120;
}

/** Los ajustes que el panel puede leer y escribir (nunca secretos). */
export const PANEL_EDITABLE_KEYS = [
  "ai_calls_enabled",
  "calls_shadow_mode",
  "calls_daily_cap",
  "calls_allowlist",
  "call_trigger_minutes",
  "call_max_contacts",
  "call_first_retry_minutes",
] as const;

export type PanelCallKey = (typeof PANEL_EDITABLE_KEYS)[number];

export function setCallConfig(key: PanelCallKey, value: string): void {
  if (!PANEL_EDITABLE_KEYS.includes(key)) throw new Error(`clave no editable: ${key}`);
  setSetting(key, value.trim());
}

export interface CallConfigView {
  aiCallsEnabled: boolean;
  shadowMode: boolean;
  dailyCap: number;
  allowlist: string[];
  triggerMinutes: number;
  maxContacts: number;
  firstRetryMinutes: number;
  /** Solo configured/missing — jamás el valor. */
  retellApiKey: "configured" | "missing";
  retellFromNumber: "configured" | "missing";
  retellAgentId: "configured" | "missing";
}

export function getCallConfigView(): CallConfigView {
  return {
    aiCallsEnabled: aiCallsEnabled(),
    shadowMode: callsShadowMode(),
    dailyCap: callsDailyCap(),
    allowlist: callsAllowlist(),
    triggerMinutes: callTriggerMinutes(),
    maxContacts: callMaxContacts(),
    firstRetryMinutes: callFirstRetryMinutes(),
    retellApiKey: (process.env.RETELL_API_KEY ?? "").trim() ? "configured" : "missing",
    retellFromNumber: (process.env.RETELL_FROM_NUMBER ?? "").trim() ? "configured" : "missing",
    retellAgentId: (process.env.RETELL_AGENT_ID ?? "").trim() ? "configured" : "missing",
  };
}
