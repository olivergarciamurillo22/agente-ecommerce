// ============================================================
// Reconciliación READ-ONLY con Beeping (polling incremental).
//
// Beeping no documenta webhooks: el estado se trae con GET /api/get_orders
// filtrado por from_date, usando date_tracking_update como base del
// incremento. Todo lo que escribe esta pieza es LOCAL:
//   tracking (carrier, número, estado crudo y normalizado) → vía
//   processSupplierUpdate, que ya trae las guardas de terminales
//   eje de cierre → solo delivered/cancelled, con la fecha DE LA FUENTE
//   foto beeping_* del pedido
// Mientras BEEPING_NOTIFICATIONS_ENABLED != 1, NO se encola ningún
// WhatsApp (suppressNotifications), ni siquiera con los gates abiertos.
//
// Checkpoint en settings (beeping_sync_checkpoint, epoch) con margen de
// 2 días: reanudable y tolerante a relojes.
// ============================================================

import pino from "pino";
import {
  getOrderByShopifyId,
  getOrderByShopifyOrderNumber,
  getSetting,
  setOrderClosure,
  setOrderSupplierReview,
  setSetting,
  type OrderRow,
} from "../db";
import { logIntegrationEvent, recordSchedulerRun } from "../system/repo";
import { processSupplierUpdate } from "../tracking/service";
import { listOrders, listShops } from "./client";
import { beepingEnabled, beepingNotificationsEnabled, cacheBeepingShop, cachedBeepingShopId } from "./config";
import { beepingCourierName, beepingRawStatusLabel, mapBeepingOrder } from "./mapper";
import { updateBeepingSnapshot } from "./repo";
import type { BeepingOrder, BeepingShop } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const CHECKPOINT_KEY = "beeping_sync_checkpoint";
const PER_PAGE = 100;
const MAX_PAGES = 50;
/** Margen del incremento: relojes y actualizaciones tardías. */
const CHECKPOINT_MARGIN_S = 2 * 86400;
const DEFAULT_LOOKBACK_S = 30 * 86400;

export interface BeepingSyncDeps {
  listOrders: typeof listOrders;
  listShops: typeof listShops;
  now: () => Date;
}

const defaultDeps: BeepingSyncDeps = { listOrders, listShops, now: () => new Date() };

/** dd-mm-yyyy, el formato que documenta el filtro from_date de Beeping. */
export function toBeepingDate(epochS: number): string {
  const d = new Date(epochS * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/**
 * Fecha de Beeping → epoch. El formato real no está documentado: se acepta
 * ISO y dd-mm-yyyy[ hh:mm[:ss]]. Si no se entiende, null (JAMÁS inventar
 * un now() como fecha del hecho).
 */
export function parseBeepingDate(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  const iso = Date.parse(v);
  if (Number.isFinite(iso)) return Math.floor(iso / 1000);
  const m = /^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) {
    const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  return null;
}

export interface ShopDiscovery {
  shopId: number | null;
  shops: BeepingShop[];
  outcome: "cached" | "autodetected" | "multiple" | "none" | "error";
  error?: string;
}

/**
 * Autodetección de tienda: cero configuración manual si solo hay una.
 * Con varias, NO se adivina — el selector de Ajustes escribe el setting.
 */
export async function ensureBeepingShop(deps: BeepingSyncDeps = defaultDeps): Promise<ShopDiscovery> {
  const cached = cachedBeepingShopId();
  if (cached !== null) return { shopId: cached, shops: [], outcome: "cached" };
  let shops: BeepingShop[];
  try {
    shops = await deps.listShops();
  } catch (err) {
    return { shopId: null, shops: [], outcome: "error", error: err instanceof Error ? err.message : "error" };
  }
  if (shops.length === 1) {
    cacheBeepingShop(shops[0].id, shops[0].name);
    logIntegrationEvent("beeping", "shop_autodetected", "info", `tienda detectada: ${shops[0].name} (id ${shops[0].id})`);
    return { shopId: shops[0].id, shops, outcome: "autodetected" };
  }
  if (shops.length === 0) return { shopId: null, shops, outcome: "none" };
  logIntegrationEvent("beeping", "shop_selection_needed", "warning", `${shops.length} tiendas en Beeping: elegir una en Ajustes`);
  return { shopId: null, shops, outcome: "multiple" };
}

export interface BeepingSyncReport {
  skipped: boolean;
  skippedReason?: string;
  pages: number;
  remoteOrders: number;
  matched: number;
  updated: number;
  closureUpdates: number;
  reviewsMarked: number;
  unmatchedRemote: number;
  skippedOtherSupplier: number;
  errors: string[];
}

function matchLocal(remote: BeepingOrder): OrderRow | null {
  // Mismo criterio que el reconciliador de Dropea (E8): el external_id puede
  // ser el id largo de Shopify o el número corto; no se asume cuál.
  return getOrderByShopifyId(remote.external_id) ?? getOrderByShopifyOrderNumber(remote.external_id);
}

/** Aplica UN pedido remoto a la base local. Exportada para tests/simulación. */
export function applyBeepingOrderLocally(remote: BeepingOrder): {
  matched: boolean;
  updated: boolean;
  closureUpdated: boolean;
  reviewMarked: boolean;
  skippedOtherSupplier: boolean;
} {
  const local = matchLocal(remote);
  if (!local) return { matched: false, updated: false, closureUpdated: false, reviewMarked: false, skippedOtherSupplier: false };

  // Un pedido enrutado a otro proveedor no se toca: dos fuentes escribiendo
  // el mismo eje logístico es exactamente el lío que no queremos.
  if (local.supplier_platform === "dropea" || local.supplier_platform === "dropi") {
    updateBeepingSnapshot(local.id, { orderStatus: remote.status, externalId: remote.external_id });
    return { matched: true, updated: false, closureUpdated: false, reviewMarked: false, skippedOtherSupplier: true };
  }

  updateBeepingSnapshot(local.id, { orderStatus: remote.status, externalId: remote.external_id });

  const mapping = mapBeepingOrder(remote.status, remote.tracking_stage);
  const occurredAt = parseBeepingDate(remote.date_tracking_update) ?? parseBeepingDate(remote.date);

  let updated = false;
  // "To be confirmed" no aporta nada al eje logístico: no hay envío aún.
  if (!(remote.status === 6 && mapping.tracking === "unknown")) {
    const res = processSupplierUpdate(local, {
      rawStatus: beepingRawStatusLabel(remote.status, remote.tracking_stage),
      normalizedOverride: mapping.tracking,
      trackingNumber: remote.tracking_number,
      carrier: beepingCourierName(remote.courier_id),
      source: "reconciliation",
      occurredAt,
      suppressNotifications: !beepingNotificationsEnabled(),
    });
    updated = res.newStatus !== res.previousStatus || res.trackingAppeared;
  }

  // Cierre de negocio: SOLO los estados que lo determinan por sí solos, con
  // la fecha de la fuente (nunca now()). canTransitionClosure protege los
  // terminales ya fijados por Shopify o manual.
  let closureUpdated = false;
  if (mapping.closure && occurredAt !== null) {
    closureUpdated = setOrderClosure(local.id, mapping.closure, "beeping", occurredAt) && local.closure_status !== mapping.closure;
  } else if (mapping.closure && occurredAt === null) {
    // Sin fecha legible de la fuente no se estampa el cierre: mejor un hueco
    // visible que una métrica de tiempos corrompida.
    logIntegrationEvent(
      "beeping",
      "closure_without_date",
      "warning",
      `Beeping reporta ${mapping.closure} pero sin fecha legible: cierre NO estampado, revisar`,
      local.shopify_order_number
    );
  }

  let reviewMarked = false;
  if (mapping.needsReview) {
    setOrderSupplierReview(local.id, `Beeping reporta "${beepingRawStatusLabel(remote.status, remote.tracking_stage)}": decidir a mano`);
    reviewMarked = true;
  }

  return { matched: true, updated, closureUpdated, reviewMarked, skippedOtherSupplier: false };
}

/** La pasada completa de reconciliación. READ-ONLY hacia Beeping. */
export async function reconcileBeepingOrders(deps: BeepingSyncDeps = defaultDeps): Promise<BeepingSyncReport> {
  const report: BeepingSyncReport = {
    skipped: false,
    pages: 0,
    remoteOrders: 0,
    matched: 0,
    updated: 0,
    closureUpdates: 0,
    reviewsMarked: 0,
    unmatchedRemote: 0,
    skippedOtherSupplier: 0,
    errors: [],
  };

  if (!beepingEnabled()) {
    return { ...report, skipped: true, skippedReason: "BEEPING_ENABLED != 1 o sin credencial" };
  }

  const startedAt = Math.floor(deps.now().getTime() / 1000);
  const shop = await ensureBeepingShop(deps);
  if (shop.outcome === "error") {
    return { ...report, skipped: true, skippedReason: `no se pudo hablar con Beeping: ${shop.error}` };
  }

  const checkpoint = parseInt(getSetting(CHECKPOINT_KEY) ?? "", 10);
  const fromEpoch = Number.isFinite(checkpoint) ? checkpoint - CHECKPOINT_MARGIN_S : startedAt - DEFAULT_LOOKBACK_S;

  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    let lote: BeepingOrder[];
    try {
      lote = await deps.listOrders({
        fromDate: toBeepingDate(fromEpoch),
        shopId: shop.shopId ?? undefined,
        perPage: PER_PAGE,
        page,
      });
    } catch (err) {
      report.errors.push(err instanceof Error ? err.message : "error listando pedidos");
      break;
    }
    report.pages = page;
    report.remoteOrders += lote.length;
    for (const remote of lote) {
      const r = applyBeepingOrderLocally(remote);
      if (!r.matched) report.unmatchedRemote++;
      else {
        report.matched++;
        if (r.updated) report.updated++;
        if (r.closureUpdated) report.closureUpdates++;
        if (r.reviewMarked) report.reviewsMarked++;
        if (r.skippedOtherSupplier) report.skippedOtherSupplier++;
      }
    }
    if (lote.length < PER_PAGE) break;
  }

  if (report.errors.length === 0) {
    setSetting(CHECKPOINT_KEY, String(startedAt));
  }

  recordSchedulerRun("beeping-sync", {
    startedAt,
    finishedAt: Math.floor(deps.now().getTime() / 1000),
    status: report.errors.length === 0 ? "ok" : "error",
    processedCount: report.matched,
    errorCount: report.errors.length,
    lastError: report.errors[0] ?? null,
  });
  logger.info(
    `[BEEPING] sync: ${report.remoteOrders} remotos, ${report.matched} emparejados, ${report.updated} actualizados, ${report.closureUpdates} cierres`
  );
  return report;
}
