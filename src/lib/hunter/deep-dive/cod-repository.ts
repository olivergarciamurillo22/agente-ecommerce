// Persistencia de la búsqueda 3 (hunter_cod_sweeps, hunter_cod_stores; migración 32, aditiva).

import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import type { SweepResult, StoreAudit } from "./cod-hunt";

const parse = <T>(v: unknown, fallback: T): T => { if (typeof v !== "string") return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } };

export interface CodSweepRow { id: number; country: string; phrases: string[]; days: number; maxPages: number; requests: number; adsTotal: number; stores: number; result: SweepResult | null; capturedAt: number }
export interface CodStoreRow { id: number; sweepId: number | null; pageId: string; pageName: string | null; country: string; priority: number | null; products: number; inDropea: number; strongWithoutSupplier: number; diversity: string | null; codGeneric: boolean; siteProducts: number | null; summary: string; audit: StoreAudit | null; requests: number; capturedAt: number }

export class CodHuntRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}

  insertSweep(r: SweepResult): number {
    const info = this.db.prepare("INSERT INTO hunter_cod_sweeps(country,phrases_json,days,max_pages,requests,ads_total,stores,result_json,captured_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(r.country, JSON.stringify(r.phrases), r.days, r.maxPages, r.requests, r.adsTotal, r.stores.length, JSON.stringify(r), r.capturedAt);
    return Number(info.lastInsertRowid);
  }

  /** El último barrido de un país (o el que se pida por id). */
  sweep(opts: { id?: number; country?: string } = {}): CodSweepRow | null {
    const r = (opts.id
      ? this.db.prepare("SELECT * FROM hunter_cod_sweeps WHERE id=?").get(opts.id)
      : this.db.prepare("SELECT * FROM hunter_cod_sweeps WHERE country=? ORDER BY captured_at DESC, id DESC LIMIT 1").get((opts.country ?? "ES").toUpperCase())) as Record<string, unknown> | undefined;
    return r ? { id: Number(r.id), country: String(r.country), phrases: parse<string[]>(r.phrases_json, []), days: Number(r.days), maxPages: Number(r.max_pages), requests: Number(r.requests), adsTotal: Number(r.ads_total), stores: Number(r.stores), result: parse<SweepResult | null>(r.result_json, null), capturedAt: Number(r.captured_at) } : null;
  }

  insertStore(a: StoreAudit, sweepId: number | null): number {
    const info = this.db.prepare("INSERT INTO hunter_cod_stores(sweep_id,page_id,page_name,country,priority,products,in_dropea,strong_without_supplier,diversity,summary,audit_json,requests,captured_at,cod_generic,site_products) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(sweepId, a.pageId, a.pageName, a.country, a.sweep?.priority ?? null, a.products.length, a.products.filter((p) => p.dropea.match).length, a.products.filter((p) => p.signal?.verdict === "senal_fuerte_sin_proveedor").length, a.profile?.diversity ?? a.account?.diversity.level ?? null, a.summary, JSON.stringify(a), a.requests, a.capturedAt, a.profile?.codGenerica ? 1 : 0, a.siteCatalog?.status === "ok" ? a.siteCatalog.products : null);
    return Number(info.lastInsertRowid);
  }

  stores(opts: { limit?: number } = {}): CodStoreRow[] {
    const rows = this.db.prepare(`SELECT s.* FROM hunter_cod_stores s WHERE s.id = (SELECT x.id FROM hunter_cod_stores x WHERE x.page_id = s.page_id ORDER BY x.captured_at DESC, x.id DESC LIMIT 1) ORDER BY (COALESCE(s.cod_generic,0) = 1 OR s.in_dropea > 0 OR s.strong_without_supplier > 0) DESC, COALESCE(s.cod_generic,0) DESC, s.in_dropea DESC, s.strong_without_supplier DESC, s.priority DESC, s.captured_at DESC LIMIT ?`).all(opts.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  storeById(id: number): CodStoreRow | null {
    const r = this.db.prepare("SELECT * FROM hunter_cod_stores WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }

  auditedPageIds(): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT page_id FROM hunter_cod_stores").all() as Array<{ page_id: string }>).map((r) => r.page_id));
  }
}

function rowOf(r: Record<string, unknown>): CodStoreRow {
  return { id: Number(r.id), sweepId: r.sweep_id === null ? null : Number(r.sweep_id), pageId: String(r.page_id), pageName: (r.page_name as string | null) ?? null, country: String(r.country), priority: r.priority === null ? null : Number(r.priority), products: Number(r.products), inDropea: Number(r.in_dropea), strongWithoutSupplier: Number(r.strong_without_supplier), diversity: (r.diversity as string | null) ?? null, codGeneric: Number(r.cod_generic ?? 0) === 1, siteProducts: r.site_products === null || r.site_products === undefined ? null : Number(r.site_products), summary: String(r.summary), audit: parse<StoreAudit | null>(r.audit_json, null), requests: Number(r.requests), capturedAt: Number(r.captured_at) };
}
