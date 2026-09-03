// ============================================================
// LAS PUERTAS DE UNA LLAMADA, EN UN SOLO SITIO.
//
// Incidente 03-09 (P3): `manualDialOrder` ("Llamar ahora" del panel)
// comprobaba EMERGENCY_STOP, elegibilidad, DNC, bloqueo global, franja y
// tope diario… pero NO el kill switch propio (`ai_calls_enabled`), NI el
// modo sombra, NI la allowlist del piloto. Es decir: con las llamadas
// apagadas, en sombra y con el piloto puesto, el botón podía llamar a
// CUALQUIER cliente. La interfaz prometía una cosa y el botón hacía otra.
//
// Aquí vive la política completa, evaluada en el mismo orden para todos los
// caminos. El orquestador comparte los mismos predicados de `config.ts`;
// esto compone la decisión para el disparo MANUAL, que es el que carecía
// de ellos.
// ============================================================

import { countCallsStartedSince, getActiveCallAttemptForOrder, isDncPhone, type OrderRow } from "../db";
import { externalActionsLocked } from "../safety";
import { isConfirmationEligible } from "../orders/eligibility";
import { defaultHolidayCalendar, type HolidayCalendar } from "./calendar";
import { insideCallWindow, madridDate, madridParts } from "./schedule";
import {
  aiCallsEnabled,
  callAllowedByAllowlist,
  callsAllowlist,
  callsBlockedReason,
  callsDailyCap,
  callsPilotMode,
  callsShadowMode,
} from "./config";

/** Motivo canónico del bloqueo (para tests, panel y registro). */
export type CallGateCode =
  | "emergency_stop"
  | "not_eligible"
  | "dnc"
  | "calls_blocked"
  | "kill_switch_off"
  | "shadow_mode"
  | "pilot_allowlist_empty"
  | "pilot_not_allowlisted"
  | "already_active"
  | "outside_window"
  | "daily_cap";

export interface CallGateVerdict {
  allowed: boolean;
  code: CallGateCode | null;
  /** Frase completa en español, lista para enseñar en el panel. */
  reason: string | null;
}

/** Inicio del día natural en Madrid (mismo cálculo que usa el orquestador). */
function startOfMadridDay(now: Date): number {
  const p = madridParts(now);
  return Math.floor(madridDate(p.year, p.month, p.day, 0, 0).getTime() / 1000);
}

const ALLOW: CallGateVerdict = { allowed: true, code: null, reason: null };
const block = (code: CallGateCode, reason: string): CallGateVerdict => ({ allowed: false, code, reason });

/**
 * ¿Puede salir AHORA una llamada MANUAL para este pedido?
 *
 * El orden es deliberado: primero lo que apaga el sistema entero, después
 * lo que depende del pedido, y al final los límites de volumen.
 */
export function checkManualCallGates(
  order: OrderRow,
  now: Date = new Date(),
  isHoliday: HolidayCalendar = defaultHolidayCalendar
): CallGateVerdict {
  // 1 · Freno de emergencia de TODO el sistema.
  if (externalActionsLocked()) {
    return block("emergency_stop", "EMERGENCY_STOP activo o modo safe: no se puede llamar");
  }

  // 2 · Bloqueo global puesto por el propio sistema (auth/billing/deriva).
  const bloqueo = callsBlockedReason();
  if (bloqueo) {
    return block("calls_blocked", `llamadas bloqueadas: ${bloqueo} (retell:doctor --unblock cuando esté resuelto)`);
  }

  // 3 · Kill switch propio de llamadas. Si está apagado, no sale ninguna
  //     llamada real: tampoco a mano. Antes el botón se lo saltaba.
  if (!aiCallsEnabled()) {
    return block("kill_switch_off", "las llamadas están apagadas (interruptor general en Ajustes → Llamadas)");
  }

  // 4 · Modo sombra: el sistema simula sin contactar al proveedor. Un botón
  //     que llamase de verdad en sombra haría inútil la validación previa.
  if (callsShadowMode()) {
    return block("shadow_mode", "modo sombra activo: se simulan llamadas sin marcarlas. Desactívalo para llamar de verdad");
  }

  // 5 · Piloto: la allowlist es obligatoria y vacía significa NADIE.
  if (callsPilotMode()) {
    if (callsAllowlist().length === 0) {
      return block("pilot_allowlist_empty", "modo piloto sin teléfonos autorizados: añade el número a la lista de llamadas permitidas");
    }
    if (!callAllowedByAllowlist(order.phone)) {
      return block("pilot_not_allowlisted", "en modo piloto solo se llama a los teléfonos autorizados, y este no lo está");
    }
  } else if (!callAllowedByAllowlist(order.phone)) {
    // Fuera del piloto la lista sigue restringiendo SI está rellena
    // (misma semántica que usa el orquestador).
    return block("pilot_not_allowlisted", "este teléfono no está en la lista de llamadas permitidas");
  }

  // 6 · Estado del pedido.
  const elig = isConfirmationEligible(order);
  if (!elig.eligible) {
    return block("not_eligible", `pedido no elegible para llamada: ${elig.detail ?? elig.reason ?? "estado no permitido"}`);
  }
  if (isDncPhone(order.phone)) {
    return block("dnc", "este teléfono está en la lista NO LLAMAR");
  }
  if (getActiveCallAttemptForOrder(order.id)) {
    return block("already_active", "este pedido ya tiene una llamada activa o pendiente");
  }

  // 7 · Límites de volumen y horario legal.
  if (!insideCallWindow(now, isHoliday)) {
    return block("outside_window", "fuera de la franja permitida de llamadas (L–S 9–13 y 17–20, sin festivos)");
  }
  if (countCallsStartedSince(startOfMadridDay(now)) >= callsDailyCap()) {
    return block("daily_cap", `tope diario de llamadas (${callsDailyCap()}) alcanzado`);
  }

  return ALLOW;
}
