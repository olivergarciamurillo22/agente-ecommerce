// ============================================================
// Persistencia del eje Beeping (columnas beeping_* de orders, v12).
//
// La máquina de liberación es deliberadamente pequeña y ATÓMICA:
//
//   not_released ──claim──▶ releasing ──ok──▶ released        (TERMINAL)
//        ▲                      │
//        │                      ├──error──▶ release_failed ──claim──▶ …
//        └──resolver────────────┴──timeout─▶ release_unknown
//
// El claim es un UPDATE condicional: de dos dobles clics, EXACTAMENTE uno
// gana. release_unknown NUNCA vuelve a la cola solo: se resuelve
// consultando Beeping (release.ts#resolveAmbiguousRelease).
// ============================================================

import { getOrderById, insertOrderStatusHistory, systemDbHandle, type OrderRow } from "../db";
import { logIntegrationEvent } from "../system/repo";

export type BeepingSyncStatus = "not_released" | "releasing" | "released" | "release_failed" | "release_unknown";

export const BEEPING_SYNC_STATUSES: BeepingSyncStatus[] = [
  "not_released",
  "releasing",
  "released",
  "release_failed",
  "release_unknown",
];

/** Registra la transición en el histórico auditable (eje propio). */
function auditar(order: OrderRow, from: string, to: string, actor: string, reason: string | null): void {
  insertOrderStatusHistory({
    orderId: order.id,
    shopifyOrderId: order.shopify_order_id,
    supplierPlatform: "beeping",
    carrier: null,
    previousStatus: from,
    newStatus: to,
    rawStatus: reason,
    rawSubStatus: actor,
    source: "manual",
    statusAxis: "beeping_release",
  });
}

/**
 * Reclama la liberación. true = ESTE llamador la ganó y debe continuar;
 * false = otro proceso la tiene (o ya está liberada): no hacer nada.
 */
export function claimBeepingRelease(orderId: number, actor: string): boolean {
  const antes = getOrderById(orderId);
  if (!antes) return false;
  const res = systemDbHandle()
    .prepare(
      `UPDATE orders SET beeping_sync_status = 'releasing', updated_at = unixepoch()
       WHERE id = ? AND beeping_sync_status IN ('not_released', 'release_failed')`
    )
    .run(orderId);
  if (res.changes === 0) return false;
  auditar(antes, antes.beeping_sync_status, "releasing", actor, null);
  return true;
}

export function markBeepingReleased(orderId: number, externalId: string, actor: string): void {
  const antes = getOrderById(orderId);
  systemDbHandle()
    .prepare(
      `UPDATE orders SET beeping_sync_status = 'released', beeping_external_id = ?,
              beeping_released_at = unixepoch(), beeping_last_error = NULL, updated_at = unixepoch()
       WHERE id = ? AND beeping_sync_status = 'releasing'`
    )
    .run(externalId, orderId);
  if (antes) auditar(antes, "releasing", "released", actor, null);
  logIntegrationEvent("beeping", "order_released", "info", `pedido liberado a preparación (mark-to-send)`, antes?.shopify_order_number ?? String(orderId));
}

export function markBeepingReleaseFailed(orderId: number, error: string, actor: string): void {
  const antes = getOrderById(orderId);
  systemDbHandle()
    .prepare(
      `UPDATE orders SET beeping_sync_status = 'release_failed', beeping_last_error = ?, updated_at = unixepoch()
       WHERE id = ? AND beeping_sync_status = 'releasing'`
    )
    .run(error.slice(0, 300), orderId);
  if (antes) auditar(antes, "releasing", "release_failed", actor, error.slice(0, 200));
  logIntegrationEvent("beeping", "release_failed", "warning", `liberación fallida: ${error.slice(0, 200)}`, antes?.shopify_order_number ?? String(orderId));
}

/** Timeout ambiguo: NO se sabe si Beeping aplicó el mark-to-send. */
export function markBeepingReleaseUnknown(orderId: number, error: string, actor: string): void {
  const antes = getOrderById(orderId);
  systemDbHandle()
    .prepare(
      `UPDATE orders SET beeping_sync_status = 'release_unknown', beeping_last_error = ?, updated_at = unixepoch()
       WHERE id = ? AND beeping_sync_status = 'releasing'`
    )
    .run(error.slice(0, 300), orderId);
  if (antes) auditar(antes, "releasing", "release_unknown", actor, error.slice(0, 200));
  logIntegrationEvent(
    "beeping",
    "release_ambiguous",
    "warning",
    "mark-to-send sin respuesta: NO reintentar a ciegas, consultar Beeping",
    antes?.shopify_order_number ?? String(orderId)
  );
}

/** Resolución de una liberación ambigua tras CONSULTAR el estado remoto. */
export function resolveBeepingReleaseUnknown(
  orderId: number,
  resolution: "released" | "not_released",
  externalId: string | null,
  actor: string
): void {
  const antes = getOrderById(orderId);
  if (resolution === "released") {
    systemDbHandle()
      .prepare(
        `UPDATE orders SET beeping_sync_status = 'released', beeping_external_id = COALESCE(?, beeping_external_id),
                beeping_released_at = COALESCE(beeping_released_at, unixepoch()),
                beeping_last_error = NULL, updated_at = unixepoch()
         WHERE id = ? AND beeping_sync_status = 'release_unknown'`
      )
      .run(externalId, orderId);
  } else {
    systemDbHandle()
      .prepare(
        `UPDATE orders SET beeping_sync_status = 'not_released', updated_at = unixepoch()
         WHERE id = ? AND beeping_sync_status = 'release_unknown'`
      )
      .run(orderId);
  }
  if (antes) auditar(antes, "release_unknown", resolution, actor, "resuelto consultando Beeping");
}

/** Foto del pedido en Beeping vista por la reconciliación (solo lectura remota). */
export function updateBeepingSnapshot(orderId: number, snapshot: { orderStatus: number | null; externalId: string | null }): void {
  systemDbHandle()
    .prepare(
      `UPDATE orders SET beeping_order_status = ?, beeping_external_id = COALESCE(?, beeping_external_id),
              beeping_last_sync_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ?`
    )
    .run(snapshot.orderStatus, snapshot.externalId, orderId);
}

/** Confirmados por el cliente y todavía sin liberar (la cola de Pedro). */
export function listOrdersAwaitingBeepingRelease(): OrderRow[] {
  return systemDbHandle()
    .prepare(
      `SELECT * FROM orders
       WHERE status = 'confirmed'
         AND beeping_sync_status IN ('not_released', 'release_failed')
         AND closure_status NOT IN ('cancelled', 'delivered', 'refused')
       ORDER BY confirmed_at ASC`
    )
    .all() as OrderRow[];
}

/** Liberaciones en estado ambiguo (para el Action Center y el doctor). */
export function listAmbiguousBeepingReleases(): OrderRow[] {
  return systemDbHandle()
    .prepare("SELECT * FROM orders WHERE beeping_sync_status = 'release_unknown' ORDER BY updated_at ASC")
    .all() as OrderRow[];
}
