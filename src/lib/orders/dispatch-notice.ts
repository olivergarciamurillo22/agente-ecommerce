// ============================================================
// AVISO DE DESPACHO ("recordatorio de envío", 07-09-2026)
// docs/WHATSAPP-TEMPLATES.md § Plantillas de recordatorio (propuesta)
//
// Se dispara cuando el pedido pasa a despachado por el router de canal
// (executeDispatch → executed, Beeping o Dropea). En ese instante el
// almacén acaba de recibir la orden de preparar: NO hay número de
// seguimiento todavía (Beeping lo da al pasar a status 4 "Enviado"), así que
// esta plantilla NO lleva enlace. El enlace de seguimiento lo lleva el aviso
// ya existente `tracking_available` (pedido_confirmado_casamable) cuando el
// número aparece por polling.
//
// Reglas (las mismas que tracking/notifications.ts):
//  - APAGADO por defecto (DISPATCH_NOTICE_WHATSAPP_ENABLED=0).
//  - Plantilla REAL aprobada por Meta y verificada por el doctor; el mapping
//    `dispatch_notice` nace DESHABILITADO (propuesta pendiente de Pedro):
//    sin eso, el aviso queda retenido con motivo visible y sin consumir sello.
//  - Gates de seguridad ANTES del claim; claim atómico del sello
//    `orders.dispatch_notice_sent_at` (migración 26) ANTES de encolar; todo
//    por el outbox. Un pedido se avisa una sola vez.
// ============================================================

import pino from "pino";
import { getOrderById, systemDbHandle, type OrderRow } from "../db";
import { logIntegrationEvent } from "../system/repo";
import { canSendRealWhatsApp } from "../safety";
import { sendWhatsAppInteractive } from "../whatsapp";
import { buildApprovedTemplateMessage, getTemplateReadiness, type TemplateReadiness } from "../whatsapp/templates";
import { formatMoney } from "./messages";
import type { DispatchChannel } from "./dispatch-channel";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export const DISPATCH_NOTICE_TEMPLATE_KEY = "dispatch_notice";

export function dispatchNoticeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DISPATCH_NOTICE_WHATSAPP_ENABLED === "1";
}

function firstName(order: OrderRow): string {
  const raw = (order.customer_name ?? "").trim().split(/\s+/)[0] || "";
  if (!raw) return "";
  const uniforme = raw === raw.toLowerCase() || raw === raw.toUpperCase();
  return uniforme ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : raw;
}

function orderNumber(order: OrderRow): string {
  const value = String(order.shopify_order_number ?? "").trim();
  if (!value) return "pedido";
  return value.startsWith("#") ? value : `#${value}`;
}

/** Texto de respaldo (dentro de ventana / Baileys). El texto REAL vive en Meta. */
export function buildDispatchNoticeMessage(order: OrderRow): string {
  const nombre = firstName(order);
  return (
    `Hola${nombre ? ` ${nombre}` : ""}, tu pedido ${orderNumber(order)} de Casamable ya está en preparación y saldrá del almacén en las próximas horas 📦\n\n` +
    `En cuanto el transportista lo recoja te enviaremos por aquí el número de seguimiento.\n\n` +
    `Recuerda que es contra reembolso: pagarás ${formatMoney(order.total_price, order.currency)} en efectivo al repartidor.`
  );
}

export type DispatchNoticeOutcome =
  | { status: "queued" }
  | { status: "skipped"; reason: string };

export interface DispatchNoticeDeps {
  env?: Record<string, string | undefined>;
  readiness?: (logicalKey: string) => TemplateReadiness;
  send?: (order: OrderRow) => boolean;
}

/** Claim atómico del sello: de dos procesos con la misma transición, uno. */
export function claimDispatchNotice(orderId: number): boolean {
  return systemDbHandle().prepare("UPDATE orders SET dispatch_notice_sent_at = unixepoch() WHERE id = ? AND dispatch_notice_sent_at IS NULL").run(orderId).changes > 0;
}

export function releaseDispatchNotice(orderId: number): void {
  systemDbHandle().prepare("UPDATE orders SET dispatch_notice_sent_at = NULL WHERE id = ?").run(orderId);
}

function defaultSend(order: OrderRow): boolean {
  return sendWhatsAppInteractive(
    order.phone,
    {
      message: buildApprovedTemplateMessage(DISPATCH_NOTICE_TEMPLATE_KEY, {
        nombre: firstName(order) || "cliente",
        numero_pedido: orderNumber(order),
        importe: formatMoney(order.total_price, order.currency),
      }),
      fallbackText: buildDispatchNoticeMessage(order),
    },
    { name: order.customer_name ?? undefined, orderAuthorized: order.pilot_authorized === 1 }
  );
}

/**
 * Encola el aviso de despacho si procede. Nunca lanza. Devuelve por qué no
 * salió cuando no sale; cada retención deja evento.
 */
export function notifyDispatchExecuted(orderId: number, channel: DispatchChannel, deps: DispatchNoticeDeps = {}): DispatchNoticeOutcome {
  const env = deps.env ?? process.env;
  const skip = (order: OrderRow | null, reason: string, event = "dispatch_notice_skipped"): DispatchNoticeOutcome => {
    if (order) logIntegrationEvent("whatsapp", event, "info", `aviso de despacho no enviado: ${reason}`, order.shopify_order_number);
    return { status: "skipped", reason };
  };
  if (!dispatchNoticeEnabled(env)) return { status: "skipped", reason: "DISPATCH_NOTICE_WHATSAPP_ENABLED=0" };
  const order = getOrderById(orderId);
  if (!order) return { status: "skipped", reason: "pedido inexistente" };
  if (order.status === "ignored_old") return skip(order, "pedido ignored_old (historial): jamás se le escribe");
  if (order.status !== "confirmed") return skip(order, `el pedido no está confirmado (estado ${order.status})`);
  if (order.dispatch_notice_sent_at) return skip(order, "ya se avisó (sello puesto)");
  // Gate ANTES del claim: un bloqueo deliberado no consume el sello.
  if (!canSendRealWhatsApp(order.phone, { orderAuthorized: order.pilot_authorized === 1 })) {
    return skip(order, "bloqueado por safety gates (sello NO consumido)", "notification_skipped_by_gate");
  }
  // Plantilla REAL verificada y APPROVED; si no, retenido con motivo visible.
  const r = (deps.readiness ?? getTemplateReadiness)(DISPATCH_NOTICE_TEMPLATE_KEY);
  if (!r.ready) {
    logIntegrationEvent("whatsapp", "template_not_ready", "warning", `aviso de despacho retenido (${r.blocker}): ${r.detail}`.slice(0, 300), order.shopify_order_number);
    return { status: "skipped", reason: `plantilla no lista: ${r.blocker}` };
  }
  if (!claimDispatchNotice(order.id)) return skip(order, "ya se avisó (claim perdido)");
  try {
    const encolado = (deps.send ?? defaultSend)(order);
    if (!encolado) {
      releaseDispatchNotice(order.id);
      return skip(order, "el outbox no aceptó el mensaje (gates): sello devuelto", "notification_skipped_by_gate");
    }
  } catch (err) {
    releaseDispatchNotice(order.id);
    const motivo = err instanceof Error ? err.message : String(err);
    logger.error(`[DESPACHO] #${order.shopify_order_number}: fallo al encolar el aviso — ${motivo} (sello devuelto)`);
    logIntegrationEvent("whatsapp", "notification_failed", "warning", `aviso de despacho falló al encolar: ${motivo}`, order.shopify_order_number);
    return { status: "skipped", reason: `fallo al encolar: ${motivo}` };
  }
  logIntegrationEvent("whatsapp", "dispatch_notice_sent", "info", `aviso de despacho encolado (canal ${channel})`, order.shopify_order_number);
  return { status: "queued" };
}
