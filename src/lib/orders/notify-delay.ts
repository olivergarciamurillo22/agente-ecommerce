// ============================================================
// Aviso de retraso de reposición ("Ultras"/"gafa") — UN solo camino de
// construcción del mensaje.
//
// sendDelayNotificationForOrder() e isDelayNotificationEligible() son la
// lógica REAL, extraída tal cual de la acción notify_delay
// (src/app/api/orders/[orderId]/action/route.ts, recuperada del trabajo sin
// commitear del NAS del 30-08) — el botón del panel y el script de campaña
// llaman a las MISMAS funciones, nada se ha reimplementado.
//
// Lo que SÍ es nuevo aquí es la parte de BATCH: selección de candidatos,
// idempotencia (notify_delay_sends) y la orquestación del lote entero
// (ritmo, aborto tras fallos seguidos, informe) — el botón del panel
// (un solo pedido, disparado a mano) no la necesita y no la usa.
// ============================================================

import {
  getNotifyDelaySentOrderIds,
  listOrdersForDelayNotification,
  recordNotifyDelaySend,
  wasDelayNotificationSent,
  type OrderRow,
} from "../db";
import { sendWhatsAppInteractive } from "../whatsapp";
import { buildTemplateMessage } from "../whatsapp/templates";
import { maskPhone } from "../safety";

// --- Lógica real, extraída de la acción notify_delay (sin tocar el comportamiento) ---

/** Mismo criterio que ya aplicaba route.ts: confirmado + "ultras" o "gafa" en el producto. */
export function isDelayNotificationEligible(order: OrderRow): boolean {
  const product = (order.product_summary ?? "").toLowerCase();
  return order.status === "confirmed" && (product.includes("ultras") || product.includes("gafa"));
}

export interface DelayNotificationOutcome {
  ok: boolean;
  error?: string;
  /** Código HTTP equivalente al que ya devolvía route.ts para cada motivo. */
  status?: number;
}

/**
 * Construye y envía el aviso de retraso a UN pedido. Copia EXACTA de lo que
 * hacía la rama `action === "notify_delay"` de route.ts: mismo nombre de
 * producto fijo en la plantilla ("Limpiador Ultrasónico Multiusos" — así
 * está en producción, no se ha "corregido" a dinámico), mismo formato de
 * número de pedido, mismo texto de fallback, mismos payloads de botón.
 */
export function sendDelayNotificationForOrder(
  order: OrderRow,
  replenishmentDate: string
): DelayNotificationOutcome {
  if (!isDelayNotificationEligible(order)) {
    return {
      ok: false,
      status: 409,
      error: "el aviso de retraso solo está habilitado para limpiadores ultrasónicos confirmados",
    };
  }
  if (!order.phone) {
    return { ok: false, status: 409, error: "el pedido no tiene teléfono" };
  }
  const date = replenishmentDate.trim();
  if (!date) {
    return { ok: false, status: 400, error: "falta la fecha de reposición" };
  }

  const name = (order.customer_name ?? "").trim().split(/\s+/)[0] || "cliente";
  const orderNumber = String(order.shopify_order_number).startsWith("#")
    ? String(order.shopify_order_number)
    : `#${order.shopify_order_number}`;

  const message = buildTemplateMessage("retraso_pedido", [name, orderNumber, "Limpiador Ultrasónico Multiusos", date]);
  message.buttonPayloads = [`delay_ok:${order.id}`, `delay_cancel:${order.id}`];

  const fallbackText =
    `Hola ${name}, te escribimos de Casamable por tu pedido ${orderNumber}.\n\n` +
    `Debido a una rotura puntual de stock de Limpiador Ultrasónico Multiusos, ` +
    `la reposición está prevista para ${date}.\n\n` +
    `Hemos reservado las unidades correspondientes a tu pedido y lo despacharemos ` +
    `en cuanto recibamos la reposición.\n\n` +
    `Sentimos las molestias y gracias por tu paciencia.`;

  const queued = sendWhatsAppInteractive(
    order.phone,
    { message, fallbackText },
    { name: order.customer_name ?? undefined, orderAuthorized: order.pilot_authorized === 1 }
  );

  if (!queued) {
    return { ok: false, status: 409, error: "envío bloqueado por los safety gates actuales" };
  }
  return { ok: true };
}

// --- Batch: selección, idempotencia y orquestación (esto sí es nuevo) ---

export interface DelayNotificationPlanItem {
  order: OrderRow;
  /** true si ya hay un envío 'sent' registrado para este pedido — se omite. */
  alreadySent: boolean;
  /** Números de OTROS pedidos de este lote que comparten el mismo teléfono. */
  phoneSharedWith: string[];
}

export interface DelayNotificationPlan {
  items: DelayNotificationPlanItem[];
  /** Solo para el aviso del informe: no se excluye a nadie por esto, decide Pedro. */
  phoneCollisions: Array<{ phone: string; orderNumbers: string[] }>;
}

/**
 * Candidatos: confirmados con teléfono, sin cierre cancelado, sin pedidos
 * de prueba — el mismo filtro amplio de listOrdersForDelayNotification
 * (más --only/excludeOrderIds), filtrados aquí por isDelayNotificationEligible
 * para que el criterio de "quién puede recibir esto" tenga una única fuente
 * de verdad, compartida con el botón del panel.
 */
export function planDelayNotificationBatch(opts: {
  excludeOrderIds?: number[];
  onlyOrderIds?: number[];
}): DelayNotificationPlan {
  const candidatos = listOrdersForDelayNotification({ excludeOrderIds: opts.excludeOrderIds });
  const only = opts.onlyOrderIds && opts.onlyOrderIds.length > 0 ? new Set(opts.onlyOrderIds) : null;
  const orders = candidatos.filter((o) => isDelayNotificationEligible(o) && (!only || only.has(o.id)));
  const sentIds = getNotifyDelaySentOrderIds();

  const byPhone = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const arr = byPhone.get(o.phone) ?? [];
    arr.push(o);
    byPhone.set(o.phone, arr);
  }
  const phoneCollisions = [...byPhone.entries()]
    .filter(([, os]) => os.length > 1)
    .map(([phone, os]) => ({ phone: maskPhone(phone), orderNumbers: os.map((o) => o.shopify_order_number) }));

  const items: DelayNotificationPlanItem[] = orders.map((o) => ({
    order: o,
    alreadySent: sentIds.has(o.id),
    phoneSharedWith: (byPhone.get(o.phone) ?? [])
      .filter((x) => x.id !== o.id)
      .map((x) => x.shopify_order_number),
  }));

  return { items, phoneCollisions };
}

export type DelayNotificationResultOutcome = "sent" | "blocked" | "already_sent" | "would_send" | "ineligible" | "error";

export interface DelayNotificationResult {
  orderId: number;
  orderNumber: string;
  phoneMasked: string;
  outcome: DelayNotificationResultOutcome;
  error?: string;
}

/**
 * Envía (o simula, si dryRun) el aviso a UN pedido del lote, con
 * idempotencia (notify_delay_sends) por delante de sendDelayNotificationForOrder.
 */
export function sendDelayNotificationBatchItem(
  order: OrderRow,
  replenishmentDate: string,
  batchId: string,
  dryRun: boolean
): DelayNotificationResult {
  const base = {
    orderId: order.id,
    orderNumber: order.shopify_order_number,
    phoneMasked: maskPhone(order.phone),
  };

  if (wasDelayNotificationSent(order.id)) {
    return { ...base, outcome: "already_sent" };
  }

  if (dryRun) {
    return { ...base, outcome: "would_send" };
  }

  try {
    const result = sendDelayNotificationForOrder(order, replenishmentDate);
    if (!result.ok) {
      // "no elegible"/"sin teléfono" no deberían darse (el plan ya filtra),
      // pero si algo cambió justo entre plan y envío, se refleja aparte de
      // un 'blocked' real de safety gates para no confundir motivos.
      const outcome: DelayNotificationResultOutcome =
        result.error === "envío bloqueado por los safety gates actuales" ? "blocked" : "ineligible";
      return { ...base, outcome, error: result.error };
    }
    recordNotifyDelaySend(order.id, batchId, "sent");
    return { ...base, outcome: "sent" };
  } catch (err) {
    return { ...base, outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DelayNotificationBatchReport {
  results: DelayNotificationResult[];
  sent: number;
  skipped: number;
  failed: number;
  /** true si se paró por MAX_CONSECUTIVE_FAILURES fallos seguidos (no llegó a procesar todo el lote). */
  aborted: boolean;
  phoneCollisions: DelayNotificationPlan["phoneCollisions"];
}

export interface RunDelayNotificationBatchOptions {
  excludeOrderIds?: number[];
  onlyOrderIds?: number[];
  replenishmentDate: string;
  batchId: string;
  dryRun: boolean;
  /** Inyectable: en tests, una función que no espera de verdad. */
  sleep?: (ms: number) => Promise<void>;
  rateLimitMs?: number;
  maxConsecutiveFailures?: number;
  /** Se llama tras CADA pedido — para que el script imprima en vivo. */
  onItem?: (result: DelayNotificationResult) => void;
  /** Inyectable: en tests, para forzar 'error' en pedidos concretos sin depender de un fallo real. */
  sendFn?: typeof sendDelayNotificationBatchItem;
}

/**
 * Orquesta el lote entero: selección (planDelayNotificationBatch) → un
 * sendDelayNotificationBatchItem por pedido, con ritmo entre envíos reales
 * y aborto si se encadenan demasiados errores.
 */
export async function runDelayNotificationBatch(
  opts: RunDelayNotificationBatchOptions
): Promise<DelayNotificationBatchReport> {
  const plan = planDelayNotificationBatch({ excludeOrderIds: opts.excludeOrderIds, onlyOrderIds: opts.onlyOrderIds });
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rateLimitMs = opts.rateLimitMs ?? 3_000;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
  const send = opts.sendFn ?? sendDelayNotificationBatchItem;

  const results: DelayNotificationResult[] = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  for (const item of plan.items) {
    const result = send(item.order, opts.replenishmentDate, opts.batchId, opts.dryRun);
    results.push(result);
    opts.onItem?.(result);

    if (result.outcome === "sent" || result.outcome === "would_send") {
      sent++;
      consecutiveFailures = 0;
    } else if (result.outcome === "already_sent" || result.outcome === "blocked" || result.outcome === "ineligible") {
      skipped++;
      consecutiveFailures = 0;
    } else {
      failed++;
      consecutiveFailures++;
    }

    if (consecutiveFailures >= maxConsecutiveFailures) {
      aborted = true;
      break;
    }

    if (!opts.dryRun && result.outcome !== "already_sent") {
      await sleepFn(rateLimitMs);
    }
  }

  return { results, sent, skipped, failed, aborted, phoneCollisions: plan.phoneCollisions };
}
