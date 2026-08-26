// ============================================================
// RETENCIÓN Y PRIVACIDAD — que SQLite no crezca eternamente y que la PII no
// viva más de lo que hace falta.
//
// Principio que ordena todo lo de aquí abajo:
//
//   NUNCA se borra estado de NEGOCIO. Se borra o se anonimiza el
//   ACOMPAÑAMIENTO: los cuerpos crudos, los mensajes viejos, los logs.
//
// Un pedido, su eje de cierre, su histórico de estados y su enlace con el
// proveedor son para siempre: son la contabilidad. Lo que no puede ser para
// siempre es el payload íntegro de Shopify con nombre, teléfono, email y
// dirección de un cliente al que se le entregó hace ocho meses.
//
// ── POR QUÉ ANONIMIZAR EN VEZ DE BORRAR ────────────────────────
// `orders.raw_payload` no se borra a secas: se SUSTITUYE por una versión
// reducida que conserva lo que el sistema necesita releer (las líneas del
// pedido, para costes y routing) y tira lo que es PII. Así el histórico
// sigue siendo utilizable y el dato personal desaparece. Borrarlo entero
// dejaría a `lineItemsFromPayload` sin nada y rompería el costeo del
// histórico en silencio.
//
// ── TODO ES IDEMPOTENTE ────────────────────────────────────────
// Correr cualquiera de estos jobs dos o diez veces seguidas hace lo mismo
// que correrlo una: las condiciones son sobre el estado, no sobre un
// contador. Y todos son de "más viejo que N días", nunca "los últimos N".
// ============================================================

import pino from "pino";
import { systemDbHandle } from "../db";
import { logIntegrationEvent } from "./repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

function envDays(nombre: string, def: number): number {
  const v = parseInt(process.env[nombre] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** Días tras los que el payload crudo de Shopify se reduce (PII fuera). */
export function rawPayloadRetentionDays(): number {
  return envDays("RAW_PAYLOAD_RETENTION_DAYS", 90);
}

/** Días tras los que se borran los mensajes de WhatsApp de una conversación. */
export function messagesRetentionDays(): number {
  return envDays("MESSAGES_RETENTION_DAYS", 180);
}

/** Días de histórico de entregas de webhook (solo dedupe, no negocio). */
export function webhookEventsRetentionDays(): number {
  return envDays("WEBHOOK_EVENTS_RETENTION_DAYS", 30);
}

export interface RetentionReport {
  rawPayloadsReduced: number;
  messagesDeleted: number;
  webhookEventsDeleted: number;
  errors: string[];
}

/**
 * Reduce `raw_payload` de los pedidos más viejos que la retención.
 *
 * QUÉ SE CONSERVA (lo que el sistema relee de verdad):
 *   id · order_number · created_at · currency · total_price · financial_status
 *   fulfillment_status · tags · line_items SIN precio de cliente ni notas
 *
 * QUÉ DESAPARECE:
 *   customer · shipping_address · billing_address · email · phone · note ·
 *   note_attributes (los formularios de Releasit llevan texto libre del
 *   cliente) y cualquier otra clave no listada.
 *
 * Es una lista BLANCA a propósito: si Shopify añade un campo nuevo con datos
 * personales, no se cuela por omisión.
 */
const CLAVES_QUE_SOBREVIVEN = [
  "id",
  "order_number",
  "name",
  "created_at",
  "updated_at",
  "cancelled_at",
  "currency",
  "total_price",
  "financial_status",
  "fulfillment_status",
  "gateway",
  "payment_gateway_names",
  "tags",
] as const;

const CLAVES_DE_LINEA_QUE_SOBREVIVEN = [
  "title",
  "quantity",
  "price",
  "sku",
  "product_id",
  "variant_id",
  "requires_shipping",
  "gift_card",
  "fulfillment_service",
  "fulfillment_status",
  "fulfillable_quantity",
] as const;

/** Versión sin PII de un payload de Shopify. Devuelve `null` si no hay nada útil. */
export function anonymizeShopifyPayload(raw: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // ilegible: no se puede reducir, se borra entero
  }
  const out: Record<string, unknown> = {};
  for (const k of CLAVES_QUE_SOBREVIVEN) {
    if (parsed[k] !== undefined) out[k] = parsed[k];
  }
  const lineas = Array.isArray(parsed.line_items) ? (parsed.line_items as Array<Record<string, unknown>>) : [];
  out.line_items = lineas.map((li) => {
    const l: Record<string, unknown> = {};
    for (const k of CLAVES_DE_LINEA_QUE_SOBREVIVEN) {
      if (li[k] !== undefined) l[k] = li[k];
    }
    return l;
  });
  // Marca para que se vea que este payload está reducido y no es el original.
  out._pii_removed = true;
  return JSON.stringify(out);
}

/**
 * Aplica la retención de payloads. Solo toca pedidos con `closure_status`
 * TERMINAL: un pedido todavía vivo puede necesitar sus datos de contacto
 * para una corrección de dirección o una llamada.
 */
export function reduceOldRawPayloads(opts: { dryRun?: boolean; nowSec?: number } = {}): number {
  const dryRun = opts.dryRun ?? false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const limite = now - rawPayloadRetentionDays() * 86400;
  const db = systemDbHandle();

  const filas = db
    .prepare(
      `SELECT id, raw_payload FROM orders
        WHERE raw_payload IS NOT NULL
          AND raw_payload NOT LIKE '%"_pii_removed":true%'
          AND closure_status IN ('delivered','refused','cancelled')
          AND COALESCE(closure_at, updated_at) < ?`
    )
    .all(limite) as Array<{ id: number; raw_payload: string }>;

  if (dryRun) return filas.length;

  const update = db.prepare("UPDATE orders SET raw_payload = ? WHERE id = ?");
  let n = 0;
  for (const f of filas) {
    update.run(anonymizeShopifyPayload(f.raw_payload), f.id);
    n++;
  }
  return n;
}

/**
 * Borra mensajes de WhatsApp viejos. Los mensajes son la conversación, no el
 * estado del pedido: el pedido guarda aparte su `status`, su cierre y sus
 * sellos de aviso, así que borrar el chat de hace medio año no pierde nada
 * de negocio — solo deja de tener el texto literal.
 */
export function deleteOldMessages(opts: { dryRun?: boolean; nowSec?: number } = {}): number {
  const dryRun = opts.dryRun ?? false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const limite = now - messagesRetentionDays() * 86400;
  const db = systemDbHandle();

  if (dryRun) {
    return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at < ?").get(limite) as { n: number }).n;
  }
  return db.prepare("DELETE FROM messages WHERE created_at < ?").run(limite).changes;
}

/** Entregas de webhook: solo sirven para deduplicar reintentos recientes. */
export function deleteOldWebhookEvents(opts: { dryRun?: boolean; nowSec?: number } = {}): number {
  const dryRun = opts.dryRun ?? false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const limite = now - webhookEventsRetentionDays() * 86400;
  const db = systemDbHandle();
  if (dryRun) {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM supplier_webhook_events WHERE received_at < ?").get(limite) as {
        n: number;
      }
    ).n;
  }
  return db.prepare("DELETE FROM supplier_webhook_events WHERE received_at < ?").run(limite).changes;
}

/**
 * Pasada completa. Idempotente: correrla dos veces seguidas no hace nada la
 * segunda vez. Cada parte falla por separado sin tumbar las demás.
 */
export function runRetention(opts: { dryRun?: boolean; nowSec?: number } = {}): RetentionReport {
  const report: RetentionReport = {
    rawPayloadsReduced: 0,
    messagesDeleted: 0,
    webhookEventsDeleted: 0,
    errors: [],
  };
  const partes: Array<[keyof RetentionReport, () => number]> = [
    ["rawPayloadsReduced", () => reduceOldRawPayloads(opts)],
    ["messagesDeleted", () => deleteOldMessages(opts)],
    ["webhookEventsDeleted", () => deleteOldWebhookEvents(opts)],
  ];
  for (const [clave, fn] of partes) {
    try {
      (report[clave] as number) = fn();
    } catch (err) {
      report.errors.push(`${String(clave)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const total = report.rawPayloadsReduced + report.messagesDeleted + report.webhookEventsDeleted;
  if (total > 0 && !opts.dryRun) {
    logger.info(
      `[RETENTION] payloads reducidos=${report.rawPayloadsReduced} mensajes=${report.messagesDeleted} webhooks=${report.webhookEventsDeleted}`
    );
    logIntegrationEvent(
      "system",
      "retention_applied",
      "info",
      `retención aplicada: ${report.rawPayloadsReduced} payload(s) sin PII, ${report.messagesDeleted} mensaje(s) y ${report.webhookEventsDeleted} entrega(s) de webhook borradas`
    );
  }
  return report;
}
