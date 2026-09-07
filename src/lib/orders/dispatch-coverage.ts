// ============================================================
// COBERTURA DEL ROUTER DE CANAL (07-09-2026) — docs/deploy/PREDESPLIEGUE.md
//
// Responde a una pregunta del pre-despliegue: ¿tiene `dispatch_channels` una
// fila para CADA producto que se vende de verdad? Sin eso, activar
// AUTO_DISPATCH_COOLDOWN_ENABLED deja los pedidos RETENIDOS uno a uno.
//
// QUÉ ES "UN PRODUCTO ACTIVO", y por qué: no hay catálogo de Shopify en la
// base (no existe tal tabla), así que la única fuente offline fiel son las
// LÍNEAS DE PEDIDOS REALES (`orders.raw_payload` → `line_items`). Es además
// exactamente la misma fuente que mira el router al despachar
// (`resolveDispatchChannelWith`), así que esta comprobación no puede dar un
// verde falso por mirar otro universo. Precedente del repo: `listCodProducts`
// (cod-calculator/auto-inputs.ts) enumera igual los SKUs vendidos.
//
// La comparación usa `matchLineToChannel` TAL CUAL (no una reimplementación):
// misma prioridad variante > SKU > producto y mismo trato de mayúsculas.
// ============================================================

import { systemDbHandle } from "../db";
import { listDispatchChannels, matchLineToChannel, type DispatchChannel, type DispatchChannelRow } from "./dispatch-channel";
import { orderLineItems, type OrderLineItem } from "./line-items";

/** Ventana por defecto. 90 días cubre de sobra el ciclo de un producto COD. */
export const COVERAGE_WINDOW_DAYS = 90;

export interface CoverageProduct {
  /** Clave de agrupación: la más específica que tenga la línea. */
  key: string;
  sku: string | null;
  variantId: string | null;
  productId: string | null;
  title: string;
  /** En cuántos pedidos distintos aparece dentro de la ventana. */
  orders: number;
  /** Último pedido en que apareció (unixepoch). */
  lastSeenAt: number;
  channel: DispatchChannel | null;
  matchedBy: "variante" | "sku" | "producto" | null;
}

export interface DispatchCoverageReport {
  windowDays: number;
  since: number;
  ordersScanned: number;
  /** Pedidos de la ventana sin raw_payload legible: puntos ciegos de esta comprobación. */
  ordersWithoutPayload: number;
  products: CoverageProduct[];
  uncovered: CoverageProduct[];
  channels: { total: number; beeping: number; dropea: number };
  /** true solo si hay productos y TODOS tienen canal. */
  ok: boolean;
  problems: string[];
}

/** Cómo casó la línea, para explicarlo en el informe. */
function matchedBy(line: OrderLineItem, row: DispatchChannelRow): "variante" | "sku" | "producto" {
  if (row.shopify_variant_id && row.shopify_variant_id === line.variantId) return "variante";
  if (row.shopify_sku && line.sku && row.shopify_sku.trim().toLowerCase() === line.sku.trim().toLowerCase()) return "sku";
  return "producto";
}

/** Clave de agrupación estable: lo más específico manda, igual que el router. */
function productKey(line: OrderLineItem): string {
  if (line.variantId) return `variante:${line.variantId}`;
  if (line.sku) return `sku:${line.sku.trim().toLowerCase()}`;
  if (line.productId) return `producto:${line.productId}`;
  return `titulo:${line.title.trim().toLowerCase()}`;
}

interface CoverageRow {
  id: number;
  raw_payload: string | null;
  ts: number;
}

/**
 * Lee la base ABIERTA POR `systemDbHandle()` (en el pre-despliegue eso es una
 * COPIA ya migrada, nunca la base de producción: el script la abre con
 * DATA_DIR apuntando al temporal).
 */
export function dispatchCoverage(windowDays = COVERAGE_WINDOW_DAYS, nowSec = Math.floor(Date.now() / 1000)): DispatchCoverageReport {
  const db = systemDbHandle();
  const since = nowSec - Math.max(1, windowDays) * 86400;
  const rows = db
    .prepare(
      `SELECT id, raw_payload, COALESCE(ordered_at, created_at) AS ts
         FROM orders
        WHERE COALESCE(ordered_at, created_at) >= ?
          AND status <> 'ignored_old'
          AND shopify_order_id NOT LIKE 'TEST-%'
        ORDER BY ts DESC`
    )
    .all(since) as CoverageRow[];

  const channels = listDispatchChannels();
  const byKey = new Map<string, CoverageProduct>();
  let sinPayload = 0;

  for (const row of rows) {
    const lines = orderLineItems(row);
    if (lines.length === 0) {
      sinPayload++;
      continue;
    }
    for (const line of lines) {
      if (line.isService) continue;
      const key = productKey(line);
      const found = matchLineToChannel(line, channels);
      const previo = byKey.get(key);
      if (previo) {
        previo.orders += 1;
        previo.lastSeenAt = Math.max(previo.lastSeenAt, row.ts);
        continue;
      }
      byKey.set(key, {
        key,
        sku: line.sku,
        variantId: line.variantId,
        productId: line.productId,
        title: line.title,
        orders: 1,
        lastSeenAt: row.ts,
        channel: found?.channel ?? null,
        matchedBy: found ? matchedBy(line, found) : null,
      });
    }
  }

  const products = [...byKey.values()].sort((a, b) => b.orders - a.orders || b.lastSeenAt - a.lastSeenAt);
  const uncovered = products.filter((p) => p.channel === null);
  const problems: string[] = [];
  if (products.length === 0) {
    problems.push(`no hay ninguna línea de producto en los últimos ${windowDays} días: la cobertura no se puede afirmar`);
  }
  if (uncovered.length > 0) {
    problems.push(`${uncovered.length} producto(s) activo(s) sin canal en dispatch_channels: ${uncovered.slice(0, 12).map((p) => p.sku ?? p.title).join(", ")}${uncovered.length > 12 ? "…" : ""}`);
  }
  if (rows.length > 0 && sinPayload / rows.length > 0.5) {
    problems.push(`${sinPayload} de ${rows.length} pedidos de la ventana no tienen raw_payload legible: la cobertura es parcial (punto ciego)`);
  }

  return {
    windowDays,
    since,
    ordersScanned: rows.length,
    ordersWithoutPayload: sinPayload,
    products,
    uncovered,
    channels: {
      total: channels.length,
      beeping: channels.filter((c) => c.channel === "beeping").length,
      dropea: channels.filter((c) => c.channel === "dropea").length,
    },
    ok: products.length > 0 && uncovered.length === 0,
    problems,
  };
}
