// ============================================================
// AI Winner Radar — DECISIONES, VIGILANCIA Y ALERTAS.
//
// Cada decisión de Pedro se guarda CON LA FOTO DE LAS SEÑALES DE ESE
// MOMENTO. Es la diferencia entre un registro y un dataset: dentro de seis
// meses, saber que descartó algo no enseña nada; saber QUÉ VEÍA cuando lo
// descartó, y qué pasó después, sí.
//
// Las alertas se quedan DENTRO del panel. Nada de WhatsApp ni correo desde
// aquí: ese canal es del cliente y meter avisos internos por ahí es como se
// acaba mandando un "momentum alto" a un comprador.
// ============================================================

import { systemDbHandle } from "../db";
import { logIntegrationEvent } from "../system/repo";
import * as repo from "./repo";
import type { OpportunityStatus, ProductOpportunity } from "./types";

export type DecisionKind = "save" | "watch" | "discard" | "test" | "winner" | "loser";

const DECISION_TO_STATUS: Record<DecisionKind, OpportunityStatus> = {
  save: "saved",
  watch: "watching",
  discard: "discarded",
  test: "testing",
  winner: "winner",
  loser: "loser",
};

export interface RecordDecisionInput {
  productId: string;
  decision: DecisionKind;
  reason?: string | null;
  note?: string | null;
  searchId?: string | null;
  decidedBy?: string | null;
}

export function recordDecision(input: RecordDecisionInput): ProductOpportunity | null {
  const op = repo.getProduct(input.productId);
  if (!op) return null;

  const db = systemDbHandle();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO hunter_decisions (product_id, search_id, decision, reason, note,
         signals_at_decision_json, scores_at_decision_json, decided_by)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      input.productId,
      input.searchId ?? null,
      input.decision,
      input.reason ?? null,
      input.note ?? null,
      // La foto del momento: sin esto la decisión no se puede aprender.
      JSON.stringify(op.signals),
      JSON.stringify(op.scores),
      input.decidedBy ?? null
    );
    repo.setProductStatus(input.productId, DECISION_TO_STATUS[input.decision]);
    if (input.decision === "watch") {
      db.prepare("INSERT OR IGNORE INTO hunter_watchlist (product_id) VALUES (?)").run(input.productId);
    }
    if (input.decision === "discard") {
      db.prepare("DELETE FROM hunter_watchlist WHERE product_id = ?").run(input.productId);
    }
  });
  tx();

  logIntegrationEvent("hunter", "hunter_decision", "info",
    `${input.decision} sobre ${op.canonicalName}${input.reason ? ` (${input.reason})` : ""}`);
  return repo.getProduct(input.productId);
}

export interface WatchlistEntry {
  product: ProductOpportunity;
  addedAt: number;
  lastCheckedAt: number | null;
}

export function listWatchlist(): WatchlistEntry[] {
  const rows = systemDbHandle()
    .prepare("SELECT product_id, added_at, last_checked_at FROM hunter_watchlist ORDER BY added_at DESC")
    .all() as Array<{ product_id: string; added_at: number; last_checked_at: number | null }>;
  return rows
    .map((r) => {
      const product = repo.getProduct(r.product_id);
      return product ? { product, addedAt: r.added_at, lastCheckedAt: r.last_checked_at } : null;
    })
    .filter((x): x is WatchlistEntry => x !== null);
}

// --- Alertas -------------------------------------------------------------

export type AlertKind =
  | "momentum_spike"
  | "advertiser_spike"
  | "creative_spike"
  | "saturation_rise"
  | "trend_reversal"
  | "supplier_out_of_stock"
  | "price_change";

export interface AlertInput {
  productId: string;
  kind: AlertKind;
  severity: "info" | "warning" | "critical";
  message: string;
  /** Parte estable de la clave: evita repetir el mismo aviso cada tick. */
  dedupeSuffix: string;
}

export function raiseAlert(a: AlertInput): boolean {
  try {
    const r = systemDbHandle()
      .prepare(
        `INSERT OR IGNORE INTO hunter_alerts (product_id, kind, severity, message, dedupe_key)
         VALUES (?,?,?,?,?)`
      )
      .run(a.productId, a.kind, a.severity, a.message, `${a.productId}:${a.kind}:${a.dedupeSuffix}`);
    return r.changes > 0;
  } catch {
    return false;
  }
}

export interface HunterAlert {
  id: number;
  productId: string;
  productName: string | null;
  kind: string;
  severity: string;
  message: string;
  createdAt: number;
  readAt: number | null;
}

export function listAlerts(onlyUnread = true, limit = 50): HunterAlert[] {
  const rows = systemDbHandle()
    .prepare(
      `SELECT a.id, a.product_id, p.canonical_name, a.kind, a.severity, a.message, a.created_at, a.read_at
         FROM hunter_alerts a
         LEFT JOIN hunter_products p ON p.id = a.product_id
        ${onlyUnread ? "WHERE a.read_at IS NULL" : ""}
        ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    productId: String(r.product_id),
    productName: (r.canonical_name as string) ?? null,
    kind: String(r.kind),
    severity: String(r.severity),
    message: String(r.message),
    createdAt: Number(r.created_at),
    readAt: r.read_at === null ? null : Number(r.read_at),
  }));
}

export function markAlertsRead(ids: number[]): void {
  if (ids.length === 0) return;
  const marcas = ids.map(() => "?").join(",");
  systemDbHandle().prepare(`UPDATE hunter_alerts SET read_at = unixepoch() WHERE id IN (${marcas})`).run(...ids);
}

/**
 * Compara la foto de hoy con la de hace 7 días y levanta avisos. Los umbrales
 * son deliberadamente ALTOS: una bandeja con un aviso por producto y día no
 * la lee nadie, y entonces no sirve para nada.
 */
export function evaluateWatchlistAlerts(): number {
  let levantadas = 0;
  const hoy = new Date().toISOString().slice(0, 10);

  for (const entry of listWatchlist()) {
    const op = entry.product;
    const antes = repo.getSnapshotAround(op.id, 7);
    if (!antes) continue;

    const nuevosAnunciantes = op.signals.advertiserCount - antes.advertiserCount;
    if (nuevosAnunciantes >= 3) {
      if (raiseAlert({
        productId: op.id, kind: "advertiser_spike", severity: "warning",
        message: `${op.canonicalName}: ${nuevosAnunciantes} anunciantes nuevos en 7 días (${antes.advertiserCount} → ${op.signals.advertiserCount})`,
        dedupeSuffix: hoy,
      })) levantadas += 1;
    }

    if (antes.activeAds > 0 && op.signals.activeAds >= antes.activeAds * 1.6 && op.signals.activeAds - antes.activeAds >= 5) {
      if (raiseAlert({
        productId: op.id, kind: "momentum_spike", severity: "info",
        message: `${op.canonicalName}: los anuncios activos han pasado de ${antes.activeAds} a ${op.signals.activeAds}`,
        dedupeSuffix: hoy,
      })) levantadas += 1;
    }

    const sat = op.scores.saturation.score;
    if (sat !== null && sat >= 80) {
      if (raiseAlert({
        productId: op.id, kind: "saturation_rise", severity: "warning",
        message: `${op.canonicalName}: saturación ${sat}/100 — el mercado se está llenando`,
        dedupeSuffix: hoy,
      })) levantadas += 1;
    }

    // Que el mercado se apague también es información accionable.
    if (antes.activeAds >= 8 && op.signals.activeAds <= antes.activeAds * 0.5) {
      if (raiseAlert({
        productId: op.id, kind: "trend_reversal", severity: "warning",
        message: `${op.canonicalName}: los anuncios activos han caído de ${antes.activeAds} a ${op.signals.activeAds}`,
        dedupeSuffix: hoy,
      })) levantadas += 1;
    }
  }
  return levantadas;
}
