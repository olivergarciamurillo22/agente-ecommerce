// ============================================================
// Aviso masivo de retraso de reposición (campaña "Ultras" y el botón manual
// del panel — MISMA construcción del mensaje y MISMO chokepoint para las
// dos, así no pueden desincronizarse).
//
// Este módulo decide "quién entra", "qué se manda por cada pedido" Y
// orquesta el lote entero (ritmo, aborto tras fallos seguidos, informe) —
// scripts/notify-delay-ultras.ts es solo un envoltorio de línea de comandos
// que imprime lo que esto devuelve, para poder probar la orquestación sin
// lanzar el proceso. La acción notify_delay de /api/orders/[orderId]/action
// usa sendDelayNotification directamente, para UN pedido.
// ============================================================

import {
  getNotifyDelaySentOrderIds,
  listOrdersForDelayNotification,
  recordNotifyDelaySend,
  wasDelayNotificationSent,
  type OrderRow,
} from "../db";
import { sendWhatsAppInteractive } from "../whatsapp";
import { buildDelayNotificationSpec } from "../whatsapp/interactive";
import { maskPhone } from "../safety";

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
 * Selección + detección de colisiones de teléfono. Lectura pura, no envía
 * ni escribe nada — es lo que el script imprime ANTES de tocar nada, en
 * dry-run y en --execute por igual.
 */
export function planDelayNotificationBatch(opts: {
  productLike: string;
  excludeOrderIds?: number[];
}): DelayNotificationPlan {
  const orders = listOrdersForDelayNotification(opts);
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

export type DelayNotificationOutcome = "sent" | "blocked" | "already_sent" | "would_send" | "error";

export interface DelayNotificationResult {
  orderId: number;
  orderNumber: string;
  phoneMasked: string;
  outcome: DelayNotificationOutcome;
  error?: string;
}

/**
 * Envía (o simula, si dryRun) el aviso a UN pedido. Chokepoint compartido
 * por el botón del panel y el script de campaña.
 *
 * Los safety gates (TEST_MODE, allowlist, pilot_authorized, EMERGENCY_STOP)
 * los aplica sendWhatsAppInteractive → canSendRealWhatsApp; este módulo no
 * los duplica ni los puentea.
 */
export function sendDelayNotification(
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
    const spec = buildDelayNotificationSpec(order, replenishmentDate);
    const ok = sendWhatsAppInteractive(order.phone, spec, { orderAuthorized: order.pilot_authorized === 1 });
    recordNotifyDelaySend(order.id, batchId, ok ? "sent" : "blocked");
    return { ...base, outcome: ok ? "sent" : "blocked" };
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
  productLike: string;
  excludeOrderIds?: number[];
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
  sendFn?: typeof sendDelayNotification;
}

/**
 * Orquesta el lote entero: selección (planDelayNotificationBatch) → un
 * sendDelayNotification por pedido, con ritmo entre envíos reales y aborto
 * si se encadenan demasiados errores. Es lo único que necesita el script —
 * y lo que prueban los tests, sin depender de temporizadores reales.
 */
export async function runDelayNotificationBatch(
  opts: RunDelayNotificationBatchOptions
): Promise<DelayNotificationBatchReport> {
  const plan = planDelayNotificationBatch({ productLike: opts.productLike, excludeOrderIds: opts.excludeOrderIds });
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rateLimitMs = opts.rateLimitMs ?? 3_000;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
  const send = opts.sendFn ?? sendDelayNotification;

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
    } else if (result.outcome === "already_sent" || result.outcome === "blocked") {
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

    // Ritmo: solo tiene sentido esperar cuando de verdad se ha intentado un
    // envío. El dry-run no espera; un "already_sent" tampoco intentó nada.
    if (!opts.dryRun && result.outcome !== "already_sent") {
      await sleepFn(rateLimitMs);
    }
  }

  return { results, sent, skipped, failed, aborted, phoneCollisions: plan.phoneCollisions };
}
