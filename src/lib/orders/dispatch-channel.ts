// ============================================================
// CANAL DE DESPACHO POR PRODUCTO (07-09-2026) — docs/AUTO-DESPACHO-COOLDOWN.md
//
// Aclaración explícita de Pedro: cada producto se despacha por Beeping O por
// Dropea, NUNCA por los dos. Quién decide el canal de cada producto es Pedro
// (tabla dispatch_channels, vacía por defecto; se rellena con
// `npm run dispatch:channels`). El sistema no adivina.
//
// Resolución para un pedido: todas sus líneas de producto físico tienen que
// resolver al MISMO canal. Sin fila para alguna línea, o con líneas que
// apuntan a canales distintos → null (fail-closed: el auto-despacho no se
// ejecuta y el pedido queda "pendiente de configurar canal").
// ============================================================

import { systemDbHandle, type OrderRow } from "../db";
import { lineItemsFromPayload, type OrderLineItem } from "./line-items";

export type DispatchChannel = "beeping" | "dropea";

export interface DispatchChannelRow {
  id: number;
  shopify_sku: string | null;
  shopify_variant_id: string | null;
  shopify_product_id: string | null;
  channel: DispatchChannel;
  note: string | null;
  updated_at: number;
}

export interface DispatchChannelResolution {
  channel: DispatchChannel | null;
  /** En cristiano, para el panel y la auditoría. */
  reason: string;
  lines: Array<{ title: string; sku: string | null; channel: DispatchChannel | null }>;
}

export function listDispatchChannels(): DispatchChannelRow[] {
  return systemDbHandle().prepare("SELECT * FROM dispatch_channels ORDER BY id").all() as DispatchChannelRow[];
}

/** Prioridad: variante > SKU > producto (lo más específico manda). */
export function matchLineToChannel(line: OrderLineItem, rows: DispatchChannelRow[]): DispatchChannelRow | null {
  const sku = (line.sku ?? "").trim().toLowerCase();
  if (line.variantId) {
    const byVariant = rows.find((r) => r.shopify_variant_id && r.shopify_variant_id === line.variantId);
    if (byVariant) return byVariant;
  }
  if (sku) {
    const bySku = rows.find((r) => r.shopify_sku && r.shopify_sku.trim().toLowerCase() === sku);
    if (bySku) return bySku;
  }
  if (line.productId) {
    const byProduct = rows.find((r) => r.shopify_product_id && r.shopify_product_id === line.productId);
    if (byProduct) return byProduct;
  }
  return null;
}

export function resolveDispatchChannelWith(order: Pick<OrderRow, "raw_payload">, rows: DispatchChannelRow[]): DispatchChannelResolution {
  let items: OrderLineItem[] = [];
  try {
    items = order.raw_payload ? lineItemsFromPayload(JSON.parse(order.raw_payload)) : [];
  } catch {
    items = [];
  }
  const productos = items.filter((i) => !i.isService);
  if (productos.length === 0) {
    return { channel: null, reason: "el pedido no tiene líneas de producto legibles: canal sin resolver", lines: [] };
  }
  const lines = productos.map((l) => ({ title: l.title, sku: l.sku, channel: matchLineToChannel(l, rows)?.channel ?? null }));
  const sinCanal = lines.filter((l) => l.channel === null);
  if (sinCanal.length > 0) {
    return {
      channel: null,
      reason: `canal de despacho sin configurar para: ${sinCanal.map((l) => l.sku ?? l.title).join(", ")} (npm run dispatch:channels)`,
      lines,
    };
  }
  const canales = new Set(lines.map((l) => l.channel as DispatchChannel));
  if (canales.size > 1) {
    return {
      channel: null,
      reason: `líneas con canales distintos en el mismo pedido (${[...canales].join(" y ")}): nunca se despacha por dos canales; decisión humana`,
      lines,
    };
  }
  const channel = [...canales][0];
  return { channel, reason: `todas las líneas → ${channel}`, lines };
}

export function resolveDispatchChannel(order: Pick<OrderRow, "raw_payload">): DispatchChannelResolution {
  return resolveDispatchChannelWith(order, listDispatchChannels());
}

/** Alta/actualización de una regla. Exactamente una clave (sku | variant | product). */
export function upsertDispatchChannel(input: { sku?: string | null; variantId?: string | null; productId?: string | null; channel: DispatchChannel; note?: string | null }): DispatchChannelRow {
  const sku = (input.sku ?? "").trim() || null;
  const variantId = (input.variantId ?? "").trim() || null;
  const productId = (input.productId ?? "").trim() || null;
  const keys = [sku, variantId, productId].filter(Boolean).length;
  if (keys !== 1) throw new Error("indica exactamente una clave: --sku, --variant o --product");
  if (input.channel !== "beeping" && input.channel !== "dropea") throw new Error("canal inválido: beeping | dropea");
  const db = systemDbHandle();
  const col = sku ? "shopify_sku" : variantId ? "shopify_variant_id" : "shopify_product_id";
  const key = sku ?? variantId ?? productId;
  // Los índices únicos son parciales (WHERE col IS NOT NULL) y SQLite no los
  // acepta como objetivo de ON CONFLICT: se resuelve a mano en transacción.
  db.transaction(() => {
    const updated = db.prepare(`UPDATE dispatch_channels SET channel = ?, note = ?, updated_at = unixepoch() WHERE ${col} = ?`).run(input.channel, input.note ?? null, key);
    if (updated.changes === 0) db.prepare(`INSERT INTO dispatch_channels (${col}, channel, note) VALUES (?, ?, ?)`).run(key, input.channel, input.note ?? null);
  })();
  return db.prepare(`SELECT * FROM dispatch_channels WHERE ${col} = ?`).get(key) as DispatchChannelRow;
}

export function deleteDispatchChannel(input: { sku?: string | null; variantId?: string | null; productId?: string | null }): boolean {
  const sku = (input.sku ?? "").trim() || null;
  const variantId = (input.variantId ?? "").trim() || null;
  const productId = (input.productId ?? "").trim() || null;
  const col = sku ? "shopify_sku" : variantId ? "shopify_variant_id" : productId ? "shopify_product_id" : null;
  if (!col) return false;
  return systemDbHandle().prepare(`DELETE FROM dispatch_channels WHERE ${col} = ?`).run(sku ?? variantId ?? productId).changes > 0;
}
