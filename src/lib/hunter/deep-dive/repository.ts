// Persistencia del nivel 2 (hunter_deep_dives, migración 32). Un informe por
// ejecución y candidato; se conservan todos para comparar pasadas.

import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import type { AdLibraryAd } from "../discovery/types";
import type { DeepDiveReport, DeepDiveVerdict, Recommendation, Opportunity } from "./deep-dive";
import type { AccountXray } from "./account";

export interface DeepDiveRow {
  id: number;
  cruceId: number | null;
  variantId: number | null;
  adlibCandidateKey: string | null;
  adId: string | null;
  keywords: string[];
  domain: string | null;
  catalogStatus: string | null;
  matchedTitle: string | null;
  matchedUrl: string | null;
  matchCoverage: number | null;
  priceEur: number | null;
  costEur: number | null;
  marginEur: number | null;
  marginPct: number | null;
  creativeStatus: string;
  activeAds: number | null;
  daysActive: number | null;
  verdict: DeepDiveVerdict;
  reasoning: string;
  incomplete: Array<{ part: string; reason: string }>;
  capturedAt: number;
  /** Radiografía de la cuenta anunciante (paso 0), si se hizo. */
  account: AccountXray | null;
  adLink: string | null;
  recommendation: Recommendation | null;
  recommendationReason: string | null;
  competitors: number | null;
  otherProducts: number | null;
  videoStatus: string | null;
  priceCoherence: string | null;
  summary: string | null;
  country: string | null;
  /** Búsqueda 2: anuncios activos en España con match (null = país ES o no comprobado). */
  spainActiveAds: number | null;
  opportunity: Opportunity | null;
  /** «gate_producto» = corte temprano por coste, no un veredicto completo (en la base el veredicto queda como no_verificable por la CHECK de la tabla; aquí se reconstruye como skip_no_match). */
  earlyExit: string | null;
  /** El informe entero (report_json), tal cual se imprimió. */
  report: DeepDiveReport | null;
}

const parse = <T>(v: unknown, fallback: T): T => { if (typeof v !== "string") return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } };

export class DeepDiveRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}

  insert(input: { cruceId: number | null; variantId: number | null; adlibCandidateKey: string | null; adId: string | null; keywords: string[]; report: DeepDiveReport; capturedAt: number }): number {
    const r = input.report;
    const info = this.db.prepare(`INSERT INTO hunter_deep_dives(cruce_id,variant_id,adlib_candidate_key,ad_id,keywords_json,domain,domain_source,catalog_status,catalog_products,matched_title,matched_url,match_coverage,match_verdict,price_eur,price_max_eur,cost_eur,margin_eur,margin_pct,angles_json,creative_json,creative_status,active_ads,days_active,verdict,reasoning,incomplete_json,requests,captured_at,account_json,ad_link,recommendation,recommendation_reason,competitors,other_products,video_status,price_coherence,summary,report_json,country,spain_active_ads,opportunity,early_exit)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.cruceId, input.variantId, input.adlibCandidateKey, input.adId, JSON.stringify(input.keywords), r.domain, r.domainSource, r.catalog?.status ?? null, r.catalog?.products ?? null,
      r.match?.product.title ?? null, r.match?.product.url ?? null, r.match?.coverage ?? null, r.match?.verdict ?? null, r.priceEur, r.priceMaxEur, r.costEur, r.marginEur, r.marginPct,
      r.angles ? JSON.stringify(r.angles) : null, r.creative ? JSON.stringify(r.creative) : null, r.creativeStatus, r.activeAds, r.daysActive, r.verdict === "skip_no_match" ? "no_verificable" : r.verdict, r.reasoning, JSON.stringify(r.incomplete), r.requests, input.capturedAt, r.account ? JSON.stringify(r.account) : null,
      r.adLink, r.recommendation.action, r.recommendation.reason, r.competitors?.count ?? null, r.otherProducts.length, r.videoStatus, r.priceCoherence.status, r.summary, JSON.stringify(r), r.country, r.spainCheck && r.spainCheck.verified ? r.spainCheck.activeAds : null, r.opportunity, r.earlyExit?.stage ?? null);
    return Number(info.lastInsertRowid);
  }

  byId(id: number): DeepDiveRow | null {
    const r = this.db.prepare("SELECT * FROM hunter_deep_dives WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }

  /** El último informe de cada candidato (por variante o clave), los mejores primero. */
  latest(opts: { limit?: number; verdict?: DeepDiveVerdict } = {}): DeepDiveRow[] {
    const where = opts.verdict ? "WHERE d.verdict = ?" : "";
    const params: unknown[] = opts.verdict ? [opts.verdict] : [];
    params.push(opts.limit ?? 50);
    const rows = this.db.prepare(`SELECT d.* FROM hunter_deep_dives d
      WHERE d.id = (SELECT x.id FROM hunter_deep_dives x WHERE COALESCE(x.variant_id, -1) = COALESCE(d.variant_id, -1) AND COALESCE(x.adlib_candidate_key,'') = COALESCE(d.adlib_candidate_key,'') ORDER BY x.captured_at DESC, x.id DESC LIMIT 1)
      ${where ? "AND " + where.slice(6) : ""}
      ORDER BY CASE d.verdict WHEN 'ganador_probable' THEN 0 WHEN 'senal_debil' THEN 1 WHEN 'no_verificable' THEN 2 ELSE 3 END, d.margin_pct DESC, d.captured_at DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  /** Los anuncios del último snapshot de un candidato del discovery (para reconstruir captions/bodies). */
  adsForCandidateKey(candidateKey: string): AdLibraryAd[] {
    const r = this.db.prepare(`SELECT s.ads_json FROM adlib_candidate_snapshots s JOIN adlib_candidates c ON c.id = s.candidate_id WHERE c.candidate_key = ? ORDER BY s.captured_at DESC, s.id DESC LIMIT 1`).get(candidateKey) as { ads_json: string } | undefined;
    return r ? parse<AdLibraryAd[]>(r.ads_json, []) : [];
  }
}

function rowOf(r: Record<string, unknown>): DeepDiveRow {
  return {
    id: Number(r.id), cruceId: r.cruce_id === null ? null : Number(r.cruce_id), variantId: r.variant_id === null ? null : Number(r.variant_id),
    adlibCandidateKey: (r.adlib_candidate_key as string | null) ?? null, adId: (r.ad_id as string | null) ?? null, keywords: parse<string[]>(r.keywords_json, []),
    domain: (r.domain as string | null) ?? null, catalogStatus: (r.catalog_status as string | null) ?? null, matchedTitle: (r.matched_title as string | null) ?? null, matchedUrl: (r.matched_url as string | null) ?? null,
    matchCoverage: r.match_coverage === null ? null : Number(r.match_coverage), priceEur: r.price_eur === null ? null : Number(r.price_eur), costEur: r.cost_eur === null ? null : Number(r.cost_eur),
    marginEur: r.margin_eur === null ? null : Number(r.margin_eur), marginPct: r.margin_pct === null ? null : Number(r.margin_pct), creativeStatus: String(r.creative_status),
    activeAds: r.active_ads === null ? null : Number(r.active_ads), daysActive: r.days_active === null ? null : Number(r.days_active), verdict: r.early_exit === "gate_producto" ? "skip_no_match" : (r.verdict as DeepDiveVerdict), reasoning: String(r.reasoning),
    incomplete: parse<Array<{ part: string; reason: string }>>(r.incomplete_json, []), capturedAt: Number(r.captured_at), account: parse<AccountXray | null>(r.account_json, null),
    adLink: (r.ad_link as string | null) ?? null, recommendation: (r.recommendation as Recommendation | null) ?? null, recommendationReason: (r.recommendation_reason as string | null) ?? null,
    competitors: r.competitors === null || r.competitors === undefined ? null : Number(r.competitors), otherProducts: r.other_products === null || r.other_products === undefined ? null : Number(r.other_products),
    videoStatus: (r.video_status as string | null) ?? null, priceCoherence: (r.price_coherence as string | null) ?? null, summary: (r.summary as string | null) ?? null,
    country: (r.country as string | null) ?? null, spainActiveAds: r.spain_active_ads === null || r.spain_active_ads === undefined ? null : Number(r.spain_active_ads), opportunity: (r.opportunity as Opportunity | null) ?? null, earlyExit: (r.early_exit as string | null) ?? null,
    report: parse<DeepDiveReport | null>(r.report_json, null),
  };
}
