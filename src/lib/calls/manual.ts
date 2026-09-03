// ============================================================
// Llamada MANUAL de confirmación ("Llamar ahora" del panel).
//
// TODA la política de "¿puede salir esta llamada?" vive en ./gates.ts y es
// la misma que promete la interfaz. Antes este camino comprobaba solo una
// parte y se saltaba el kill switch propio, el modo sombra y la allowlist
// del piloto (incidente P3 del 03-09).
// ============================================================

import {
  claimCallAttempt,
  countCallsStartedSince,
  countConsumedContacts,
  getActiveCallAttemptForOrder,
  getOrderById,
  insertCallAttempt,
  isDncPhone,
  transitionCallAttempt,
} from "../db";
import { logIntegrationEvent } from "../system/repo";
import { defaultHolidayCalendar } from "./calendar";
import { checkManualCallGates } from "./gates";
import { buildCallPayload } from "./payload";
import { type CallProvider } from "./provider";
import { handleProviderCreateError, noteAgentVersionDrift } from "./scheduler";
import { retellProvider } from "./retell";
import { insideCallWindow, madridDate, madridParts } from "./schedule";

export interface ManualCallResult {
  ok: boolean;
  error?: string;
  providerCallId?: string;
}

const toS = (d: Date) => Math.floor(d.getTime() / 1000);

function startOfMadridDay(now: Date): number {
  const p = madridParts(now);
  return toS(madridDate(p.year, p.month, p.day, 0, 0));
}

export async function manualDialOrder(
  orderId: number,
  now = new Date(),
  provider: CallProvider = retellProvider
): Promise<ManualCallResult> {
  const order = getOrderById(orderId);
  if (!order) return { ok: false, error: "pedido no encontrado" };

  // TODAS las puertas, en un solo sitio y en el mismo orden para todos.
  const gate = checkManualCallGates(order, now, defaultHolidayCalendar);
  if (!gate.allowed) {
    return { ok: false, error: gate.reason ?? "no se puede llamar ahora" };
  }

  const payload = buildCallPayload(order, now);
  if (!payload.ok) {
    return { ok: false, error: `faltan datos para llamar: ${payload.missing.join(", ")}` };
  }

  if (!provider.isConfigured()) {
    return { ok: false, error: `${provider.name} no está configurado` };
  }

  const contactNumber = countConsumedContacts(order.id) + 1;
  const nowS = toS(now);
  const attemptId = insertCallAttempt(order.id, contactNumber, nowS);

  if (attemptId === null) {
    return { ok: false, error: "no se pudo crear el intento: ya existe uno activo" };
  }

  if (!claimCallAttempt(attemptId)) {
    return { ok: false, error: "otro proceso reclamó el intento" };
  }

  if (isDncPhone(order.phone)) {
    transitionCallAttempt(attemptId, ["reserved"], "cancelled", {
      reason: "dnc (carrera manual)",
    });
    return { ok: false, error: "teléfono añadido a NO LLAMAR antes de marcar" };
  }

  if (!transitionCallAttempt(attemptId, ["reserved"], "dialing", {
    reason: "manual_button",
  })) {
    return { ok: false, error: "no se pudo bloquear el intento para marcación" };
  }

  try {
    const accepted = await provider.createOutboundCall({
      toNumber: payload.toNumber!,
      fromNumber: provider.name === "retell" ? (process.env.RETELL_FROM_NUMBER ?? "").trim() : "",
      dynamicVariables: payload.variables!,
      metadata: {
        attempt_id: String(attemptId),
        order_number: order.shopify_order_number,
        trigger: "manual_button",
      },
    });

    transitionCallAttempt(attemptId, ["dialing"], "in_flight", {
      provider_call_id: accepted.providerCallId,
      agent_id: accepted.agentId ?? null,
      agent_version: accepted.agentVersion ?? null,
      started_at: nowS,
    });
    noteAgentVersionDrift(accepted.requestedAgentVersion ?? null, accepted.agentVersion ?? null, order.shopify_order_number);

    logIntegrationEvent(
      "system",
      "manual_call_started",
      "info",
      `llamada MANUAL iniciada para pedido #${order.shopify_order_number}`,
      order.shopify_order_number
    );

    return { ok: true, providerCallId: accepted.providerCallId };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    const attempt = getActiveCallAttemptForOrder(order.id);
    // Misma política que el orquestador: ambiguo → revisión manual (nunca
    // segunda llamada); 401/402 → bloqueo global; 429 → fallo técnico.
    const r = attempt
      ? handleProviderCreateError(attempt, order, err, now, defaultHolidayCalendar, { manual: true })
      : { retried: false, kind: "unknown" };
    logIntegrationEvent("system", "manual_call_failed", "warning", `falló llamada MANUAL (${r.kind}): ${msg}`, order.shopify_order_number);
    return {
      ok: false,
      error:
        r.kind === "ambiguous"
          ? `Retell no confirmó ni rechazó la llamada (${msg}). NO vuelvas a pulsar: comprueba en el dashboard de Retell si salió (attempt_id=${attemptId}).`
          : `Retell rechazó la llamada (${r.kind}): ${msg}`,
    };
  }
}
