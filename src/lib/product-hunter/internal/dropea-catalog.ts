// ============================================================
// CATÁLOGO DE DROPEA · copia local (08-09-2026) — docs/PRODUCT-HUNTER-BACKEND-PLAN.md §2c
//
// La API de Dropea (GET /dropshipper/products) solo pagina: no busca por
// texto ni por categoría, y el catálogo real tenía 4.142 productos. Buscar
// «en vivo» desde el panel serían 40+ peticiones por cada tecla. Así que:
//   · `syncDropeaCatalog` recorre el catálogo entero con el cliente que ya
//     existe (src/lib/suppliers/dropea) y lo guarda en `dropea_catalog`;
//   · el panel y el cruce (F6a) buscan en esa copia, y enseñan de cuándo es.
//
// Lo que Dropea expone por variante, según su contrato documentado: sku,
// name, price (lo que pagamos), recommended_sale_price, currency, stock.
// NI PESO NI MEDIDAS: se guardan como null y raw_json conserva la respuesta
// por si la API real trae más de lo documentado.
// ============================================================

import type Database from "better-sqlite3";
import { getSetting, setSetting, systemDbHandle } from "../../db";
import { listDropeaProducts } from "../../suppliers/dropea";
import { dropeaReadEnabled } from "../../suppliers/dropea/client";
import type { DropeaProduct } from "../../suppliers/dropea/types";

export const DROPEA_SYNC_PAGE_SIZE = 100;
/** Red de seguridad, no un límite real (20.000 productos). Si se alcanza, se dice. */
export const DROPEA_SYNC_MAX_PAGES = 200;

export interface DropeaCatalogRow {
  variantId: number;
  productId: number;
  sku: string | null;
  name: string | null;
  productName: string | null;
  costEur: number | null;
  recommendedPriceEur: number | null;
  currency: string | null;
  stock: number | null;
  status: string | null;
  syncedAt: number;
}

export interface DropeaSyncReport {
  ok: boolean;
  reason: string | null;
  pages: number;
  products: number;
  variants: number;
  truncated: boolean;
  syncedAt: number;
}

/**
 * Estado de la última sincronización, en settings. Si el sync se corta a
 * mitad (red, 5xx, Ctrl-C), la copia NO queda corrupta: cada página se
 * escribe en su propia transacción y las filas anteriores siguen ahí con su
 * synced_at anterior. Lo que sí queda es una copia MEZCLADA (parte nueva,
 * parte vieja), y eso hay que decirlo: aquí se guarda si la última pasada
 * terminó entera o no, y hasta qué página llegó.
 */
export interface DropeaSyncState {
  startedAt: number;
  finishedAt: number | null;
  complete: boolean;
  pages: number;
  variants: number;
  error: string | null;
}
const SYNC_STATE_KEY = "dropea_catalog_sync_json";

export function dropeaSyncState(): DropeaSyncState | null {
  const raw = getSetting(SYNC_STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as DropeaSyncState; } catch { return null; }
}

function writeSyncState(state: DropeaSyncState): void {
  setSetting(SYNC_STATE_KEY, JSON.stringify(state));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function rowOf(r: Record<string, unknown>): DropeaCatalogRow {
  return {
    variantId: Number(r.variant_id), productId: Number(r.product_id), sku: r.sku as string | null, name: r.name as string | null,
    productName: r.product_name as string | null, costEur: r.cost_eur as number | null, recommendedPriceEur: r.recommended_price_eur as number | null,
    currency: r.currency as string | null, stock: r.stock as number | null, status: r.status as string | null, syncedAt: Number(r.synced_at),
  };
}

/** Palabras con las que se busca: minúsculas, sin acentos, sin signos. */
export function tokens(text: string): string[] {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 2);
}

export class DropeaCatalogRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}

  /** Guarda (o actualiza) las variantes de una página. Devuelve cuántas. */
  upsertProducts(products: DropeaProduct[], syncedAt: number): number {
    const stmt = this.db.prepare(`INSERT INTO dropea_catalog(variant_id,product_id,sku,name,product_name,cost_eur,recommended_price_eur,currency,stock,status,raw_json,search_text,synced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(variant_id) DO UPDATE SET product_id=excluded.product_id,sku=excluded.sku,name=excluded.name,product_name=excluded.product_name,
        cost_eur=excluded.cost_eur,recommended_price_eur=excluded.recommended_price_eur,currency=excluded.currency,stock=excluded.stock,status=excluded.status,raw_json=excluded.raw_json,search_text=excluded.search_text,synced_at=excluded.synced_at`);
    let n = 0;
    const tx = this.db.transaction(() => {
      for (const p of products) {
        const productId = num(p.id);
        if (productId === null) continue;
        for (const v of p.variants ?? []) {
          const variantId = num(v.variant_id);
          if (variantId === null) continue;
          const raw = v as unknown as Record<string, unknown>;
          stmt.run(variantId, productId, str(v.sku), str(v.name), str(p.name), num(v.price), num(v.recommended_sale_price), str(v.currency), num(v.stock), str(p.status), JSON.stringify({ product: { id: p.id, name: p.name ?? null, status: p.status ?? null }, variant: raw }), tokens(`${v.name ?? ""} ${p.name ?? ""}`).join(" "), syncedAt);
          n++;
        }
      }
    });
    tx();
    return n;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM dropea_catalog").get() as { n: number }).n;
  }

  /** Fecha de la última sincronización (unixepoch) o null si nunca. Puede ser de una pasada PARCIAL: ver dropeaSyncState(). */
  lastSyncedAt(): number | null {
    const r = this.db.prepare("SELECT MAX(synced_at) AS t FROM dropea_catalog").get() as { t: number | null };
    return r.t ?? null;
  }

  /** Filas que la última pasada (aunque fuera parcial) NO volvió a ver: pueden haber desaparecido de Dropea. */
  staleCount(sinceSyncedAt: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM dropea_catalog WHERE synced_at < ?").get(sinceSyncedAt) as { n: number }).n;
  }

  byVariantId(variantId: number): DropeaCatalogRow | null {
    const r = this.db.prepare("SELECT * FROM dropea_catalog WHERE variant_id=?").get(variantId) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }

  /**
   * Búsqueda por texto en la copia local: todas las palabras del término
   * deben aparecer en el nombre (variante o producto), sin acentos ni
   * mayúsculas (search_text). Paginada.
   */
  search(term: string, opts: { page?: number; pageSize?: number; category?: string | null } = {}): { rows: DropeaCatalogRow[]; total: number } {
    const words = tokens(term);
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 12));
    const where: string[] = [];
    const params: unknown[] = [];
    for (const w of words) { where.push("search_text LIKE ?"); params.push(`%${w}%`); }
    // «Categoría» en Dropea no existe como campo: se acepta como una palabra más del nombre.
    for (const w of tokens(opts.category ?? "")) { where.push("search_text LIKE ?"); params.push(`%${w}%`); }
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM dropea_catalog ${sql}`).get(...params) as { n: number }).n;
    const rows = (this.db.prepare(`SELECT * FROM dropea_catalog ${sql} ORDER BY product_id, variant_id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>).map(rowOf);
    return { rows, total };
  }

  /** Para el cruce (F6a): un lote de variantes, una por producto (la primera), en orden estable. */
  batchForCross(opts: { limit: number; offset?: number; category?: string | null }): DropeaCatalogRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const w of tokens(opts.category ?? "")) { where.push("search_text LIKE ?"); params.push(`%${w}%`); }
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM dropea_catalog ${sql} GROUP BY product_id ORDER BY product_id LIMIT ? OFFSET ?`).all(...params, opts.limit, opts.offset ?? 0) as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }
}

/**
 * Recorre el catálogo entero y lo guarda. Usa el cliente de Dropea existente
 * (autenticación, timeouts y errores ya resueltos allí). Con la lectura
 * deshabilitada no llama a nada y lo dice.
 */
export async function syncDropeaCatalog(opts: { repo?: DropeaCatalogRepository; list?: typeof listDropeaProducts; now?: number; onPage?: (page: number, items: number) => void; /** false en tests con base ajena a settings */ persistState?: boolean } = {}): Promise<DropeaSyncReport> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!opts.list && !dropeaReadEnabled()) {
    return { ok: false, reason: "lectura de Dropea deshabilitada: hacen falta DROPEA_API_KEY y DROPEA_API_ENABLED=1", pages: 0, products: 0, variants: 0, truncated: false, syncedAt: now };
  }
  const repo = opts.repo ?? new DropeaCatalogRepository();
  const list = opts.list ?? listDropeaProducts;
  let pages = 0, products = 0, variants = 0, truncated = false;
  const state: DropeaSyncState = { startedAt: now, finishedAt: null, complete: false, pages: 0, variants: 0, error: null };
  if (opts.persistState !== false) writeSyncState(state);
  try {
    for (let page = 1; page <= DROPEA_SYNC_MAX_PAGES; page++) {
      const res = await list(page, DROPEA_SYNC_PAGE_SIZE);
      const items = res?.items ?? [];
      pages = page;
      products += items.length;
      variants += repo.upsertProducts(items, now); // una transacción por página: o entra entera o no entra
      state.pages = pages; state.variants = variants;
      if (opts.persistState !== false) writeSyncState(state);
      opts.onPage?.(page, items.length);
      if (items.length < DROPEA_SYNC_PAGE_SIZE) break;
      if (page === DROPEA_SYNC_MAX_PAGES) truncated = true;
    }
  } catch (err) {
    // Corte a mitad: lo guardado se queda (por página, consistente); la copia
    // queda MEZCLADA y el estado lo dice. Nunca se borra lo anterior.
    const message = err instanceof Error ? err.message : String(err);
    state.finishedAt = Math.floor(Date.now() / 1000); state.complete = false; state.error = message;
    if (opts.persistState !== false) writeSyncState(state);
    return { ok: false, reason: `sincronización cortada en la página ${pages + 1} (${message}): ${variants} variante(s) de ${pages} página(s) guardadas; el resto de la copia es de la pasada anterior. Vuelve a lanzar hunter:dropea:sync`, pages, products, variants, truncated: false, syncedAt: now };
  }
  state.finishedAt = Math.floor(Date.now() / 1000); state.complete = !truncated;
  if (opts.persistState !== false) writeSyncState(state);
  return { ok: true, reason: truncated ? `se alcanzó el tope de ${DROPEA_SYNC_MAX_PAGES} páginas: la copia puede estar INCOMPLETA` : null, pages, products, variants, truncated, syncedAt: now };
}
