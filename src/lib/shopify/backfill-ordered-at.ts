// ============================================================
// T1 — Backfill de `ordered_at` en filas YA EXISTENTES.
//
// La migración (migrateOrderedAt, src/lib/db.ts) añade la columna vacía
// (NULL) a todas las filas que ya había en la tabla. El webhook y el
// backfill de Shopify (E3) la rellenan solos para todo pedido NUEVO a
// partir de ahora. Este módulo es el que rellena las filas VIEJAS,
// reconstruyendo la fecha a partir del `raw_payload` que ya se había
// guardado en su momento — sin llamar a la API de Shopify ni inventar nada.
//
// Si una fila no tiene `raw_payload` (STORE_RAW_PAYLOAD=0 en su momento, o
// es de antes de que esa columna existiera), `ordered_at` se queda en NULL:
// eso NO es un fallo de este script, es información real que falta. Se
// cuenta y se informa, no se rellena con una fecha inventada.
// ============================================================

import { systemDbHandle } from "../db";

export type OrderedAtResolution =
  | { kind: "resolved"; orderedAt: number }
  | { kind: "unresolved_no_payload" }
  | { kind: "unresolved_unparseable" }
  | { kind: "unresolved_no_date" };

/** ISO 8601 → epoch en segundos. `null` si falta o no es parseable. */
function toEpochSeconds(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Decisión PURA: a partir del `raw_payload` guardado (JSON crudo del webhook
 * o del backfill de Shopify), intenta recuperar `created_at`. No toca la DB.
 */
export function resolveOrderedAtFromRawPayload(rawPayload: string | null | undefined): OrderedAtResolution {
  if (!rawPayload || !rawPayload.trim()) return { kind: "unresolved_no_payload" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return { kind: "unresolved_unparseable" };
  }

  const createdAt =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).created_at : undefined;
  const orderedAt = toEpochSeconds(createdAt);
  if (orderedAt === null) return { kind: "unresolved_no_date" };
  return { kind: "resolved", orderedAt };
}

interface CandidateRow {
  id: number;
  shopify_order_id: string;
  shopify_order_number: string;
  raw_payload: string | null;
}

export interface BackfillOrderedAtItem {
  id: number;
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  resolution: OrderedAtResolution;
}

export interface BackfillOrderedAtReport {
  total: number;
  resolved: number;
  unresolvedNoPayload: number;
  unresolvedUnparseable: number;
  unresolvedNoDate: number;
}

export interface RunBackfillOrderedAtOptions {
  /** true (por defecto): decide todo, no escribe nada. */
  dryRun: boolean;
  onItem?: (item: BackfillOrderedAtItem) => void;
}

/**
 * Recorre TODAS las filas con `ordered_at IS NULL`, decide su resolución con
 * `resolveOrderedAtFromRawPayload` y, si `dryRun` es false, escribe el
 * resultado resuelto. Las no resueltas nunca se tocan (se quedan NULL).
 */
export function runBackfillOrderedAt(opts: RunBackfillOrderedAtOptions): BackfillOrderedAtReport {
  const db = systemDbHandle();
  const rows = db
    .prepare(
      "SELECT id, shopify_order_id, shopify_order_number, raw_payload FROM orders WHERE ordered_at IS NULL"
    )
    .all() as CandidateRow[];

  const report: BackfillOrderedAtReport = {
    total: rows.length,
    resolved: 0,
    unresolvedNoPayload: 0,
    unresolvedUnparseable: 0,
    unresolvedNoDate: 0,
  };

  const update = db.prepare("UPDATE orders SET ordered_at = ? WHERE id = ?");

  for (const row of rows) {
    const resolution = resolveOrderedAtFromRawPayload(row.raw_payload);
    switch (resolution.kind) {
      case "resolved":
        report.resolved++;
        if (!opts.dryRun) update.run(resolution.orderedAt, row.id);
        break;
      case "unresolved_no_payload":
        report.unresolvedNoPayload++;
        break;
      case "unresolved_unparseable":
        report.unresolvedUnparseable++;
        break;
      case "unresolved_no_date":
        report.unresolvedNoDate++;
        break;
    }
    opts.onItem?.({
      id: row.id,
      shopifyOrderId: row.shopify_order_id,
      shopifyOrderNumber: row.shopify_order_number,
      resolution,
    });
  }

  return report;
}
