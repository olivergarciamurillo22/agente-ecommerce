// ============================================================
// AUTO-DESPACHO TRAS COOLDOWN (07-09-2026) — docs/AUTO-DESPACHO-COOLDOWN.md
//
// Al confirmarse un pedido se programa un temporizador (default 8 h). Al
// vencer, el scheduler dispara el mark-to-send de Beeping SOLO si se cumplen
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

export const AUTO_DISPATCH_DEFAULT_HOURS = 8;

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
  result?: BeepingMarkToSendResult;
}

export interface DispatchDeps {
  markToSend?: (externalId: string | number) => Promise<BeepingMarkToSendResult>;
}

/** Evalúa y, si procede, despacha. `via` queda en la auditoría. */
export async function executeDispatch(orderId: number, via: "cooldown" | "manual", nowSec = Math.floor(Date.now() / 1000), deps: DispatchDeps = {}): Promise<DispatchExecution> {
  const db = systemDbHandle();
  const order = getOrderById(orderId);
  const row = getDispatchCooldown(orderId);
  if (!order) return { status: "skipped", reasons: ["pedido inexistente"] };
  if (row && row.status === "executed") return { status: "skipped", reasons: ["ya despachado"] };
  const conditions = evaluateDispatchConditions(order);
  if (!conditions.ok) {
    db.prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at, evaluated_at, blocked_reason) VALUES (?, 'blocked', ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET status = 'blocked', evaluated_at = excluded.evaluated_at, blocked_reason = excluded.blocked_reason")
      .run(orderId, nowSec, nowSec, nowSec, conditions.reasons.join(" · "));
    logIntegrationEvent("beeping", "auto_dispatch_blocked", "warning", `despacho ${via} RETENIDO: ${conditions.reasons.join(" · ")} — pendiente de revisión manual`, order.shopify_order_number);
    return { status: "blocked", reasons: conditions.reasons };
  }
  const markToSend = deps.markToSend ?? markOrderToSend;
  const result = await markToSend(order.shopify_order_number);
  const executed = result.outcome === "sent" || result.outcome === "simulated";
  if (!executed) {
    // Beeping no aceptó el pedido: no es un bloqueo de negocio, es un fallo
    // técnico. Queda 'blocked' con el motivo para que una persona lo mire.
    db.prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at, evaluated_at, blocked_reason) VALUES (?, 'blocked', ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET status = 'blocked', evaluated_at = excluded.evaluated_at, blocked_reason = excluded.blocked_reason")
      .run(orderId, nowSec, nowSec, nowSec, `Beeping: ${result.outcome}${"status" in result && result.status ? ` (HTTP ${result.status})` : ""}`);
    logIntegrationEvent("beeping", "auto_dispatch_blocked", "warning", `despacho ${via}: Beeping devolvió ${result.outcome}`, order.shopify_order_number);
    return { status: "blocked", reasons: [`Beeping: ${result.outcome}`], result };
  }
  db.prepare("INSERT INTO dispatch_cooldowns (order_id, status, scheduled_at, due_at, evaluated_at, executed_at, executed_via, outcome) VALUES (?, 'executed', ?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO UPDATE SET status = 'executed', evaluated_at = excluded.evaluated_at, executed_at = excluded.executed_at, executed_via = excluded.executed_via, outcome = excluded.outcome, blocked_reason = NULL")
    .run(orderId, nowSec, nowSec, nowSec, nowSec, via, result.outcome);
  logIntegrationEvent("beeping", "auto_dispatch_executed", "info", `despacho ${via}: mark-to-send ${result.outcome}`, order.shopify_order_number);
  return { status: "executed", reasons: [], result };
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
