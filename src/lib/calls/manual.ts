// ============================================================
// Llamada MANUAL de confirmación.
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
import { isConfirmationEligible } from "../orders/eligibility";
import { logIntegrationEvent } from "../system/repo";
import { defaultHolidayCalendar } from "./calendar";
import { callsDailyCap } from "./config";
import { buildCallPayload } from "./payload";
import { ProviderRequestError, type CallProvider } from "./provider";
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

  const elig = isConfirmationEligible(order);
  if (!elig.eligible) {
    return {
      ok: false,
      error: `pedido no elegible para llamada: ${elig.detail ?? elig.reason ?? "estado no permitido"}`,
    };
  }

  if (isDncPhone(order.phone)) {
    return { ok: false, error: "este teléfono está en la lista NO LLAMAR" };
  }

  if (getActiveCallAttemptForOrder(order.id)) {
    return { ok: false, error: "este pedido ya tiene una llamada activa o pendiente" };
  }

  if (!insideCallWindow(now, defaultHolidayCalendar)) {
    return { ok: false, error: "fuera de la franja permitida de llamadas" };
  }

  if (countCallsStartedSince(startOfMadridDay(now)) >= callsDailyCap()) {
    return { ok: false, error: `tope diario de llamadas (${callsDailyCap()}) alcanzado` };
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
      started_at: nowS,
    });

    logIntegrationEvent(
      "system",
      "manual_call_started",
      "info",
      `llamada MANUAL iniciada para pedido #${order.shopify_order_number}`,
      order.shopify_order_number
    );

    return { ok: true, providerCallId: accepted.providerCallId };
  } catch (err) {
    const msg = err instanceof ProviderRequestError ? err.message : String(err);

    transitionCallAttempt(attemptId, ["dialing"], "completed", {
      result: "fallo_tecnico",
      retry_consumed: 0,
      reason: `manual_provider_failed: ${msg.slice(0, 200)}`,
      ended_at: nowS,
    });

    logIntegrationEvent(
      "system",
      "manual_call_failed",
      "warning",
      `falló llamada MANUAL: ${msg.slice(0, 200)}`,
      order.shopify_order_number
    );

    return { ok: false, error: `Retell rechazó la llamada: ${msg.slice(0, 200)}` };
  }
}
