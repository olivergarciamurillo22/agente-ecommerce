// ============================================================
// VALIDACIÓN DE DIRECCIONES — orquestación de las dos capas, auditoría,
// caché y la incidencia ALERTA_DIRECCION (07-09-2026).
// docs/VALIDACION-DIRECCION-IA.md
//
// Flujo de negocio (leer antes de tocar):
//  · La confirmación por WhatsApp se envía IGUAL, sea cual sea el veredicto.
//    Esto nunca añade fricción al cliente ni retrasa el mensaje: la capa 1 es
//    síncrona y de coste cero; la capa 2 corre en el scheduler, aparte.
//  · "dudosa" o "incorrecta" → ALERTA_DIRECCION: fila en address_alerts +
//    trabajo en la bandeja de atención (work_items) + integration_event.
//    Mientras esté abierta, el mark-to-send AUTOMÁTICO a Beeping NO sale,
//    aunque el cliente confirme. Solo la cierra una persona
//    (resolveAddressAlert), porque el cliente puede no ver que su propia
//    dirección está incompleta.
//  · La IA no corrige nada: solo señala. El dato del cliente no se toca.
//  · Todo veredicto queda auditado (address_validations), con la respuesta
//    cruda del modelo y qué capa lo detectó.
// ============================================================

import { createHash } from "node:crypto";
import { getOrCreateConversation, systemDbHandle, type OrderRow } from "../db";
import { logIntegrationEvent } from "../system/repo";
import { addressLimitFallback, aiBudget, recordAiCall } from "../system/ai-budget";
import { assessOrderAddressLayer1, type AddressLayer1Result, type AddressVerdict } from "./address-assessment";
import { addressAiEnabled, addressAiModel, evaluateAddressWithAi, type AddressAiCompleter, type AddressAiResult } from "./address-ai";

export const ADDRESS_ALERT_REASON = "ALERTA_DIRECCION";

export type AddressOrder = Pick<OrderRow, "id" | "shopify_order_number" | "phone" | "customer_name" | "proposed_address" | "address_line1" | "address_line2" | "city" | "province" | "postal_code">;

export interface AddressValidationRow {
  id: number;
  order_id: number;
  address_hash: string;
  layer: 1 | 2;
  verdict: AddressVerdict;
  problems_json: string;
  confidence: number | null;
  model: string | null;
  raw_response: string | null;
  created_at: number;
}

export interface AddressAlertRow {
  id: number;
  order_id: number;
  detected_by_layer: 1 | 2;
  verdict: "dudosa" | "incorrecta";
  problems_json: string;
  opened_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

/** Hash estable de la dirección evaluada: si no cambia, no se vuelve a llamar a la IA. */
export function addressHash(order: AddressOrder): string {
  const proposed = (order.proposed_address ?? "").trim();
  const line = proposed || [order.address_line1, order.address_line2].filter(Boolean).join(" ");
  const key = [line, order.city ?? "", order.province ?? "", order.postal_code ?? ""].map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")).join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function getAddressValidation(orderId: number, hash: string, layer: 1 | 2): AddressValidationRow | null {
  return (systemDbHandle()
    .prepare("SELECT * FROM address_validations WHERE order_id = ? AND address_hash = ? AND layer = ?")
    .get(orderId, hash, layer) as AddressValidationRow | undefined) ?? null;
}

export function listAddressValidations(orderId: number): AddressValidationRow[] {
  return systemDbHandle().prepare("SELECT * FROM address_validations WHERE order_id = ? ORDER BY created_at DESC, id DESC").all(orderId) as AddressValidationRow[];
}

function recordValidation(orderId: number, hash: string, layer: 1 | 2, verdict: AddressVerdict, problems: string[], confidence: number | null, model: string | null, raw: string | null): void {
  systemDbHandle()
    .prepare(
      `INSERT INTO address_validations (order_id, address_hash, layer, verdict, problems_json, confidence, model, raw_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id, address_hash, layer) DO UPDATE SET
         verdict = excluded.verdict, problems_json = excluded.problems_json, confidence = excluded.confidence,
         model = excluded.model, raw_response = excluded.raw_response, created_at = unixepoch()`
    )
    .run(orderId, hash, layer, verdict, JSON.stringify(problems), confidence, model, raw);
}

// ----------------------------------------------------------------
// ALERTA_DIRECCION
// ----------------------------------------------------------------

export function getOpenAddressAlert(orderId: number): AddressAlertRow | null {
  return (systemDbHandle()
    .prepare("SELECT * FROM address_alerts WHERE order_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(orderId) as AddressAlertRow | undefined) ?? null;
}

export function hasOpenAddressAlert(orderId: number): boolean {
  return getOpenAddressAlert(orderId) !== null;
}

/** Para pintar el panel de una vez: ids de pedido con alerta abierta. */
export function listOpenAddressAlertOrderIds(): Set<number> {
  const rows = systemDbHandle().prepare("SELECT DISTINCT order_id FROM address_alerts WHERE resolved_at IS NULL").all() as Array<{ order_id: number }>;
  return new Set(rows.map((r) => r.order_id));
}

export function listAddressAlerts(orderId: number): AddressAlertRow[] {
  return systemDbHandle().prepare("SELECT * FROM address_alerts WHERE order_id = ? ORDER BY id DESC").all(orderId) as AddressAlertRow[];
}

/**
 * Abre la incidencia (idempotente: si ya hay una abierta no duplica). Crea el
 * trabajo en la bandeja de atención SIN silenciar el bot (la conversación
 * sigue en modo automático: el cliente debe poder confirmar con normalidad).
 */
export function openAddressAlert(order: AddressOrder, layer: 1 | 2, verdict: "dudosa" | "incorrecta", problems: string[]): AddressAlertRow {
  const existing = getOpenAddressAlert(order.id);
  if (existing) return existing;
  const db = systemDbHandle();
  const info = db
    .prepare("INSERT INTO address_alerts (order_id, detected_by_layer, verdict, problems_json) VALUES (?, ?, ?, ?)")
    .run(order.id, layer, verdict, JSON.stringify(problems));
  try {
    const convo = getOrCreateConversation(order.phone, order.customer_name ?? undefined);
    db.prepare(
      `INSERT INTO work_items(conversation_id, order_id, reason, owner_only)
       SELECT ?, ?, ?, 0
       WHERE NOT EXISTS (SELECT 1 FROM work_items WHERE conversation_id = ? AND order_id = ? AND reason = ? AND resolved_at IS NULL)`
    ).run(convo.id, order.id, ADDRESS_ALERT_REASON, convo.id, order.id, ADDRESS_ALERT_REASON);
  } catch {
    /* sin teléfono válido no hay conversación: la alerta existe igual en address_alerts */
  }
  logIntegrationEvent(
    "whatsapp",
    "address_alert_opened",
    verdict === "incorrecta" ? "critical" : "warning",
    `ALERTA_DIRECCION (capa ${layer}, ${verdict}): ${problems.slice(0, 4).join(", ")} — mark-to-send automático bloqueado hasta revisión humana`,
    order.shopify_order_number
  );
  return db.prepare("SELECT * FROM address_alerts WHERE id = ?").get(Number(info.lastInsertRowid)) as AddressAlertRow;
}

/** Solo una persona cierra la alerta. Devuelve false si no había ninguna abierta. */
export function resolveAddressAlert(orderId: number, resolvedBy: string, note: string | null = null): boolean {
  const db = systemDbHandle();
  const info = db
    .prepare("UPDATE address_alerts SET resolved_at = unixepoch(), resolved_by = ?, resolution_note = ? WHERE order_id = ? AND resolved_at IS NULL")
    .run(resolvedBy.slice(0, 120), note ? note.slice(0, 500) : null, orderId);
  if (info.changes === 0) return false;
  db.prepare("UPDATE work_items SET resolved_at = unixepoch(), resolution_note = COALESCE(?, resolution_note) WHERE order_id = ? AND reason = ? AND resolved_at IS NULL")
    .run(note ? note.slice(0, 500) : null, orderId, ADDRESS_ALERT_REASON);
  const order = db.prepare("SELECT shopify_order_number FROM orders WHERE id = ?").get(orderId) as { shopify_order_number: string } | undefined;
  logIntegrationEvent("whatsapp", "address_alert_resolved", "info", `ALERTA_DIRECCION cerrada por ${resolvedBy}${note ? `: ${note.slice(0, 120)}` : ""}`, order?.shopify_order_number ?? null);
  return true;
}

// ----------------------------------------------------------------
// Capas
// ----------------------------------------------------------------

export interface Layer1Outcome extends AddressLayer1Result {
  hash: string;
  alert: AddressAlertRow | null;
}

/** Capa 1: síncrona y sin coste. Se ejecuta al entrar el pedido y cuando cambia la dirección. */
export function runAddressValidationLayer1(order: AddressOrder): Layer1Outcome {
  const hash = addressHash(order);
  const result = assessOrderAddressLayer1(order);
  recordValidation(order.id, hash, 1, result.verdict, result.problems, null, null, null);
  const alert = result.verdict === "correcta" ? null : openAddressAlert(order, 1, result.verdict, result.problems);
  return { ...result, hash, alert };
}

export type Layer2Outcome =
  | { status: "no_ejecutada"; reason: "ia_desactivada" | "capa1_ya_detecto_problema" | "limite_diario" }
  | { status: "cache"; hash: string; row: AddressValidationRow }
  | { status: "evaluada"; hash: string; result: AddressAiResult; alert: AddressAlertRow | null };

export interface Layer2Deps {
  complete?: AddressAiCompleter;
  env?: Record<string, string | undefined>;
}

/**
 * Capa 2: una llamada por pedido y dirección. Con la IA desactivada
 * (ADDRESS_AI_VALIDATION_ENABLED≠1 o sin OPENAI_API_KEY) NO se ejecuta y se
 * dice explícitamente — no se inventa un veredicto. Con la IA activada, todo
 * fallo es "dudosa" (fail-closed) y abre alerta.
 */
export async function runAddressValidationLayer2(order: AddressOrder, deps: Layer2Deps = {}): Promise<Layer2Outcome> {
  const env = deps.env ?? process.env;
  if (!addressAiEnabled(env)) return { status: "no_ejecutada", reason: "ia_desactivada" };
  const hash = addressHash(order);
  const cached = getAddressValidation(order.id, hash, 2);
  if (cached) return { status: "cache", hash, row: cached };
  const layer1 = getAddressValidation(order.id, hash, 1) ?? (() => { runAddressValidationLayer1(order); return getAddressValidation(order.id, hash, 1); })();
  if (layer1 && layer1.verdict !== "correcta") return { status: "no_ejecutada", reason: "capa1_ya_detecto_problema" };

  // TOPE DIARIO (docs/COSTE-IA.md): al agotarse NO se llama a la API.
  const presupuesto = aiBudget("address", env);
  if (presupuesto.exhausted) {
    logIntegrationEvent("whatsapp", "ai_daily_limit_reached", "warning", `${presupuesto.reason}; capa 2 de direcciones sin llamar (modo '${addressLimitFallback(env)}')`, order.shopify_order_number);
    if (addressLimitFallback(env) === "omitir") return { status: "no_ejecutada", reason: "limite_diario" };
    // Fail-closed estricto: nunca "correcta" sin haberla podido validar.
    const sinCuota: AddressAiResult = {
      layer: 2, verdict: "dudosa", problems: ["sin_confirmar:limite_diario_ia"], confidence: null,
      model: addressAiModel(env), raw: presupuesto.reason ?? "", fromModel: false,
    };
    recordValidation(order.id, hash, 2, sinCuota.verdict, sinCuota.problems, null, sinCuota.model, sinCuota.raw);
    const alerta = openAddressAlert(order, 2, "dudosa", sinCuota.problems);
    return { status: "evaluada", hash, result: sinCuota, alert: alerta };
  }
  recordAiCall("address", order.id);

  const l1 = assessOrderAddressLayer1(order);
  const result = await evaluateAddressWithAi(
    { address: l1.address, city: order.city, province: order.province, postalCode: order.postal_code, provinceFromCp: l1.postalCode.provinceFromCp },
    { complete: deps.complete, env }
  );
  recordValidation(order.id, hash, 2, result.verdict, result.problems, result.confidence, result.model, result.raw);
  logIntegrationEvent(
    "whatsapp",
    "address_ai_verdict",
    result.verdict === "correcta" ? "info" : "warning",
    `capa 2 (${result.model}): ${result.verdict}${result.confidence !== null ? ` · confianza ${result.confidence.toFixed(2)}` : ""}${result.fromModel ? "" : " · fail-closed"}`,
    order.shopify_order_number
  );
  const alert = result.verdict === "correcta" ? null : openAddressAlert(order, 2, result.verdict, result.problems);
  return { status: "evaluada", hash, result, alert };
}

/** Ambas capas en orden. La 2 solo si la 1 no encontró un problema evidente. */
export async function validateOrderAddress(order: AddressOrder, deps: Layer2Deps = {}): Promise<{ layer1: Layer1Outcome; layer2: Layer2Outcome }> {
  const layer1 = runAddressValidationLayer1(order);
  if (layer1.verdict !== "correcta") return { layer1, layer2: { status: "no_ejecutada", reason: "capa1_ya_detecto_problema" } };
  return { layer1, layer2: await runAddressValidationLayer2(order, deps) };
}

/**
 * Para el scheduler: pedidos recientes que todavía no tienen veredicto de la
 * capa 2 para su dirección actual. Acotado (una llamada por pedido, `limit`
 * por tick) para que el coste sea predecible y nunca retrase el envío de la
 * confirmación, que va por su propio carril.
 */
export function listOrdersPendingAiValidation(limit = 5, maxAgeSec = 3 * 86400): OrderRow[] {
  const rows = systemDbHandle()
    .prepare(
      `SELECT o.* FROM orders o
       WHERE o.created_at >= unixepoch() - ?
         AND o.status NOT IN ('cancelled','ignored_old','error')
       ORDER BY o.created_at DESC LIMIT 200`
    )
    .all(maxAgeSec) as OrderRow[];
  const pending: OrderRow[] = [];
  for (const order of rows) {
    const hash = addressHash(order);
    if (getAddressValidation(order.id, hash, 2)) continue;
    const l1 = getAddressValidation(order.id, hash, 1);
    if (l1 && l1.verdict !== "correcta") continue;
    pending.push(order);
    if (pending.length >= limit) break;
  }
  return pending;
}

export async function runPendingAddressAiValidations(limit = 5, deps: Layer2Deps = {}): Promise<number> {
  if (!addressAiEnabled(deps.env ?? process.env)) return 0;
  let done = 0;
  for (const order of listOrdersPendingAiValidation(limit)) {
    const outcome = await runAddressValidationLayer2(order, deps);
    if (outcome.status === "evaluada") done++;
  }
  return done;
}
