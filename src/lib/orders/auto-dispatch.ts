// ============================================================
// AUTO-DESPACHO TRAS COOLDOWN (07-09-2026) — docs/AUTO-DESPACHO-COOLDOWN.md
//
// Al confirmarse un pedido se programa un temporizador (AUTO_DISPATCH_DEFAULT_HOURS = 6 h, confirmado por Pedro). Al
// vencer, el scheduler despacha por el canal del PRODUCTO (Beeping O Dropea,
// nunca ambos: tabla dispatch_channels que rellena Pedro) SOLO si se cumplen
// TODAS las condiciones:
//   · ninguna escalada a persona abierta para ese pedido (work_items sin
//     resolver: cancelación en texto libre, duda no reconocida, media…);
//   · ninguna solicitud de cancelación del cliente sin resolver;
//   · ninguna ALERTA_DIRECCION abierta;
//   · el pedido sigue confirmado y no está cerrado/cancelado por otra vía.
// Si falla una, NO se despacha: queda 'blocked' con el motivo, visible en el
// panel, y una persona lo dispara a mano cuando lo resuelva (dispatchNow).
// Nunca se despacha "por defecto" ante la duda.
//
// Interruptor: AUTO_DISPATCH_COOLDOWN_ENABLED=1 (default 0). Con 0, confirmar
// sigue lanzando el hook inmediato de siempre (suppliers/beeping.ts), que a
// su vez solo actúa con BEEPING_INTEGRATION_ENABLED=1.
// ============================================================

import { getOrderById, isActionResolved, systemDbHandle, type OrderRow } from "../db";
import { logIntegrationEvent } from "../system/repo";
import { markOrderToSend, type BeepingMarkToSendResult } from "../suppliers/beeping";
import { getOpenAddressAlert } from "./address-validation";
import { resolveDispatchChannel, type DispatchChannel } from "./dispatch-channel";
import { confirmDropeaOrder, type CreateOrderOutcome } from "../suppliers/dropea/create-order";
import { notifyDispatchExecuted, type DispatchNoticeDeps } from "./dispatch-notice";

/** Cooldown confirmado por Pedro (07-09-2026): 6 horas. Única fuente; env AUTO_DISPATCH_COOLDOWN_HOURS lo sobreescribe. */
export const AUTO_DISPATCH_DEFAULT_HOURS = 6;

export interface DispatchCooldownRow {
  order_id: number;
  status: "scheduled" | "executed" | "blocked" | "cancelled";
  scheduled_at: number;
  due_at: number;
  evaluated_at: number | null;
  executed_at: number | null;
  executed_via: string | null;
  blocked_reason: string | null;
  outcome: string | null;
  channel?: string | null;
}

export function autoDispatchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AUTO_DISPATCH_COOLDOWN_ENABLED ?? "0").trim() === "1";
}

export function autoDispatchCooldownSec(env: Record<string, string | undefined> = process.env): number {
  const h = Number(env.AUTO_DISPATCH_COOLDOWN_HOURS ?? "");
  return Math.round((Number.isFinite(h) && h > 0 && h <= 168 ? h : AUTO_DISPATCH_DEFAULT_HOURS) * 3600);
}

export function getDispatchCooldown(orderId: number): DispatchCooldownRow | null {
  return (systemDbHandle().prepare("SELECT * FROM dispatch_cooldowns WHERE order_id = ?").get(orderId) as DispatchCooldownRow | undefined) ?? null;
}

/** Programa el cooldown (idempotente: si ya existe, no se reprograma). */
export function scheduleDispatchCooldown(order: Pick<OrderRow, "id" | "shopify_order_number">, nowSec = Math.floor(Date.now() / 1000), env = process.env): DispatchCooldownRow {
  const existing = getDispatchCooldown(order.id);
  if (existing) return existing;
  const dueAt = nowSec + autoDispatchCooldownSec(env);
  systemDbHandle()
    .prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at) VALUES (?, 'scheduled', ?, ?)")
    .run(order.id, nowSec, dueAt);
  logIntegrationEvent("beeping", "auto_dispatch_scheduled", "info", `auto-despacho programado para ${new Date(dueAt * 1000).toISOString()} (${Math.round(autoDispatchCooldownSec(env) / 3600)} h)`, order.shopify_order_number);
  return getDispatchCooldown(order.id)!;
}

export interface DispatchConditions {
  ok: boolean;
  reasons: string[];
}

/** Las condiciones, en cristiano. Se evalúan al vencer y al pulsar "despachar ahora". */
export function evaluateDispatchConditions(order: OrderRow): DispatchConditions {
  const reasons: string[] = [];
  if (order.status !== "confirmed") reasons.push(`el pedido ya no está confirmado (estado ${order.status})`);
  if (order.closure_status === "cancelled") reasons.push("el pedido está cancelado en Shopify");
  if (order.closure_status === "delivered" || order.closure_status === "refused") reasons.push(`el pedido ya está cerrado (${order.closure_status})`);
  if (order.cancellation_requested_at && !isActionResolved(order.id, "CANCEL_REQUEST")) reasons.push("hay una solicitud de cancelación del cliente sin resolver");
  const openWork = systemDbHandle()
    .prepare("SELECT reason FROM work_items WHERE order_id = ? AND resolved_at IS NULL ORDER BY id DESC")
    .all(order.id) as Array<{ reason: string }>;
  const escalations = openWork.filter((w) => w.reason !== "ALERTA_DIRECCION");
  if (escalations.length > 0) reasons.push(`escalada a persona abierta sin resolver: ${escalations.map((w) => w.reason).join(", ")}`);
  const alert = getOpenAddressAlert(order.id);
  if (alert) reasons.push(`ALERTA_DIRECCION abierta (capa ${alert.detected_by_layer}, ${alert.verdict})`);
  return { ok: reasons.length === 0, reasons };
}

export interface DispatchExecution {
  status: "executed" | "blocked" | "skipped";
  reasons: string[];
  /** Canal por el que salió (o iba a salir) el pedido; null si no se resolvió. */
  channel: DispatchChannel | null;
  result?: BeepingMarkToSendResult;
  dropea?: CreateOrderOutcome;
}

/** Adaptadores inyectables (tests y simulación sin red). NUNCA se llaman los dos para el mismo pedido. */
export interface DispatchDeps {
  /** Aviso de despacho al cliente (apagado por defecto; docs/WHATSAPP-TEMPLATES.md). */
  notice?: DispatchNoticeDeps;
  /** Adaptador Beeping: PUT /api/order/mark-to-send/{external_id} (feat/beeping-mark-to-send). */
  markToSend?: (externalId: string | number) => Promise<BeepingMarkToSendResult>;
  /** Adaptador Dropea: POST /dropshipper/orders/{id}/confirm (segundo paso del contrato; exige DROPEA_WRITE_ENABLED=1). */
  confirmDropea?: (orderId: number) => Promise<CreateOrderOutcome>;
}

function blockDispatch(db: ReturnType<typeof systemDbHandle>, order: OrderRow, via: string, nowSec: number, channel: DispatchChannel | null, reasons: string[], eventDetail: string): DispatchExecution {
  db.prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at, evaluated_at, blocked_reason, channel) VALUES (?, 'blocked', ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET status = 'blocked', evaluated_at = excluded.evaluated_at, blocked_reason = excluded.blocked_reason, channel = excluded.channel")
    .run(order.id, nowSec, nowSec, nowSec, reasons.join(" · "), channel);
  logIntegrationEvent("beeping", "auto_dispatch_blocked", "warning", `despacho ${via} RETENIDO: ${eventDetail}`, order.shopify_order_number);
  return { status: "blocked", reasons, channel };
}

/** Evalúa condiciones, resuelve el canal del producto y, si procede, despacha por UN solo canal. */
export async function executeDispatch(orderId: number, via: "cooldown" | "manual", nowSec = Math.floor(Date.now() / 1000), deps: DispatchDeps = {}): Promise<DispatchExecution> {
  const db = systemDbHandle();
  const order = getOrderById(orderId);
  const row = getDispatchCooldown(orderId);
  if (!order) return { status: "skipped", reasons: ["pedido inexistente"], channel: null };
  if (row && row.status === "executed") return { status: "skipped", reasons: ["ya despachado"], channel: (row.channel as DispatchChannel | null) ?? null };
  const conditions = evaluateDispatchConditions(order);
  if (!conditions.ok) {
    return blockDispatch(db, order, via, nowSec, null, conditions.reasons, `${conditions.reasons.join(" · ")} — pendiente de revisión manual`);
  }

  // ROUTER DE CANAL (Pedro, 07-09): Beeping O Dropea según el producto,
  // nunca ambos. Sin canal configurado → no se despacha (fail-closed).
  const resolution = resolveDispatchChannel(order);
  if (!resolution.channel) {
    return blockDispatch(db, order, via, nowSec, null, [`pendiente de configurar canal de despacho: ${resolution.reason}`], `canal de despacho sin resolver (${resolution.reason})`);
  }

  if (resolution.channel === "beeping") {
    const markToSend = deps.markToSend ?? markOrderToSend;
    const result = await markToSend(order.shopify_order_number);
    const executed = result.outcome === "sent" || result.outcome === "simulated";
    if (!executed) {
      // Beeping no aceptó el pedido: fallo técnico, no de negocio. Una persona decide.
      const detail = `Beeping: ${result.outcome}${"status" in result && result.status ? ` (HTTP ${result.status})` : ""}`;
      return { ...blockDispatch(db, order, via, nowSec, "beeping", [detail], `Beeping devolvió ${result.outcome}`), result };
    }
    db.prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at, evaluated_at, executed_at, executed_via, outcome, channel) VALUES (?, 'executed', ?, ?, ?, ?, ?, ?, 'beeping') ON CONFLICT(order_id) DO UPDATE SET status = 'executed', evaluated_at = excluded.evaluated_at, executed_at = excluded.executed_at, executed_via = excluded.executed_via, outcome = excluded.outcome, channel = 'beeping', blocked_reason = NULL")
      .run(orderId, nowSec, nowSec, nowSec, nowSec, via, result.outcome);
    logIntegrationEvent("beeping", "auto_dispatch_executed", "info", `despacho ${via} por Beeping: mark-to-send ${result.outcome}`, order.shopify_order_number);
    // Aviso de despacho ("recordatorio de envío"): best-effort, apagado por defecto.
    try { notifyDispatchExecuted(order.id, "beeping", deps.notice); } catch { /* nunca rompe el despacho */ }
    return { status: "executed", reasons: [], channel: "beeping", result };
  }

  // Dropea: el contrato real es POST /dropshipper/orders/{id}/confirm, ya
  // implementado en confirmDropeaOrder (idempotente, con claim y gate). Solo
  // procede si el pedido ya existe en Dropea (adoptado desde su app) y las
  // escrituras están permitidas (DROPEA_WRITE_ENABLED=1, hoy 0 por política:
  // CLAUDE.md §2). Con la llave cerrada queda RETENIDO, nunca se salta.
  const confirmDropea = deps.confirmDropea ?? confirmDropeaOrder;
  const dropea = await confirmDropea(order.id);
  if (!dropea.ok) {
    const detail = `Dropea: ${dropea.detail}${dropea.blocker ? ` (${dropea.blocker})` : ""}`;
    return { ...blockDispatch(db, order, via, nowSec, "dropea", [detail], detail), dropea };
  }
  db.prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at, evaluated_at, executed_at, executed_via, outcome, channel) VALUES (?, 'executed', ?, ?, ?, ?, ?, ?, 'dropea') ON CONFLICT(order_id) DO UPDATE SET status = 'executed', evaluated_at = excluded.evaluated_at, executed_at = excluded.executed_at, executed_via = excluded.executed_via, outcome = excluded.outcome, channel = 'dropea', blocked_reason = NULL")
    .run(orderId, nowSec, nowSec, nowSec, nowSec, via, dropea.detail);
  logIntegrationEvent("dropea", "auto_dispatch_executed", "info", `despacho ${via} por Dropea: ${dropea.detail}`, order.shopify_order_number);
  try { notifyDispatchExecuted(order.id, "dropea", deps.notice); } catch { /* nunca rompe el despacho */ }
  return { status: "executed", reasons: [], channel: "dropea", dropea };
}

/** Para el scheduler: cooldowns vencidos. */
export function listDueDispatchCooldowns(nowSec = Math.floor(Date.now() / 1000), limit = 20): DispatchCooldownRow[] {
  return systemDbHandle()
    .prepare("SELECT * FROM dispatch_cooldowns WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at ASC LIMIT ?")
    .all(nowSec, limit) as DispatchCooldownRow[];
}

export async function runDueDispatchCooldowns(nowSec = Math.floor(Date.now() / 1000), deps: DispatchDeps = {}, env = process.env): Promise<{ executed: number; blocked: number }> {
  const out = { executed: 0, blocked: 0 };
  if (!autoDispatchEnabled(env)) return out;
  for (const row of listDueDispatchCooldowns(nowSec)) {
    const r = await executeDispatch(row.order_id, "cooldown", nowSec, deps);
    if (r.status === "executed") out.executed++;
    else if (r.status === "blocked") out.blocked++;
  }
  return out;
}

/** Botón "Despachar ahora": una persona ya revisó; se evalúan las condiciones igualmente. */
export async function dispatchNow(orderId: number, by: string, deps: DispatchDeps = {}): Promise<DispatchExecution> {
  const order = getOrderById(orderId);
  if (order) logIntegrationEvent("beeping", "auto_dispatch_manual", "info", `despacho manual solicitado por ${by}`, order.shopify_order_number);
  return executeDispatch(orderId, "manual", Math.floor(Date.now() / 1000), deps);
}

/** Ids con despacho retenido, para pintar el listado de una vez. */
export function listBlockedDispatchOrderIds(): Set<number> {
  const rows = systemDbHandle().prepare("SELECT order_id FROM dispatch_cooldowns WHERE status = 'blocked'").all() as Array<{ order_id: number }>;
  return new Set(rows.map((r) => r.order_id));
}
