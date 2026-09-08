// ============================================================
// FUENTES REALES DEL CAZADOR INTERNO (08-09-2026) — docs/PRODUCT-HUNTER-BACKEND-PLAN.md §2
//
// Cada fuente convierte lo que YA existe en SQLite en `AdLibraryResult`, el
// tipo que entiende el panel. Ids con prefijo para saber de dónde viene cada
// cosa y poder volver a ella:
//   adlib:<candidate_key>   grupo de anuncios del discovery (Competencia)
//   local:<id>              product_candidates (hunter:add / manual)
//   dropea:<variant_id>     copia local del catálogo de Dropea
//   cruce:<id>              cruce Dropea × Ad Library (F6a)
//
// Lo que la fuente no sabe viaja como null. Aquí no se estima nada.
// ============================================================

import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import { HunterRepository } from "../../hunter/repository";
import type { ProductCandidate } from "../../hunter/types";
import { creativeVariants, declaredDomains } from "../../hunter/discovery/signals";
import { computeMomentum } from "../../hunter/discovery/momentum";
import { DiscoveryRepository } from "../../hunter/discovery/repository";
import type { AdLibraryAd } from "../../hunter/discovery/types";
import type { AdLibraryResult, CandidateFactsView, HunterScoreView, WinnerScoreBreakdown, WinnerScoreSignal, WinnerSignalKey } from "../types";
import { WINNER_SIGNAL_KEYS, WINNER_SIGNAL_LABEL } from "../types";
import { DropeaCatalogRepository, tokens, type DropeaCatalogRow } from "./dropea-catalog";
import { detectPriceInText } from "./price-detect";

const DAY = 86_400;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

export type SourceId = { kind: "adlib"; key: string } | { kind: "local"; id: number } | { kind: "dropea"; variantId: number } | { kind: "cruce"; id: number };

export function parseSourceId(id: string): SourceId | null {
  const m = /^(adlib|local|dropea|cruce):(.+)$/.exec(id);
  if (!m) return null;
  if (m[1] === "adlib") return { kind: "adlib", key: m[2] };
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (m[1] === "local") return { kind: "local", id: n };
  if (m[1] === "dropea") return { kind: "dropea", variantId: n };
  return { kind: "cruce", id: n };
}

// ------------------------------------------------------------
// Score de un resultado de Ad Library (plan §3a): solo señales que existen.
// ------------------------------------------------------------
export const ADLIB_SCORE_WEIGHTS: Partial<Record<WinnerSignalKey, number>> = { ad_age: 40, creative_variations: 25, advertiser_similar_ads: 20, multi_country: 15 };

export function adlibWinnerScore(input: { activeDays: number | null; variations: number | null; activeAds: number | null; countriesSeen: number; momentumReason: string | null; analyzedAt: number }): WinnerScoreBreakdown {
  const medidas: Array<{ key: WinnerSignalKey; value: number; observed: string }> = [];
  if (input.activeDays !== null) medidas.push({ key: "ad_age", value: Math.min(100, (input.activeDays / 90) * 100), observed: `activo ${input.activeDays} días (el anuncio activo más antiguo)` });
  if (input.variations !== null) medidas.push({ key: "creative_variations", value: Math.min(100, (input.variations / 5) * 100), observed: `${input.variations} texto(s) creativo(s) distinto(s)` });
  if (input.activeAds !== null) medidas.push({ key: "advertiser_similar_ads", value: Math.min(100, (input.activeAds / 10) * 100), observed: `${input.activeAds} anuncio(s) activo(s) del mismo grupo` });
  medidas.push({ key: "multi_country", value: Math.min(100, (input.countriesSeen / 3) * 100), observed: `visto en ${input.countriesSeen} país(es) donde hemos buscado` });
  const byKey = new Map(medidas.map((m) => [m.key, m]));
  const signals: WinnerScoreSignal[] = WINNER_SIGNAL_KEYS.map((key) => {
    const m = byKey.get(key);
    if (m) return { key, label: WINNER_SIGNAL_LABEL[key], value: Math.round(m.value), weight: ADLIB_SCORE_WEIGHTS[key] ?? null, observed: m.observed, missing: false };
    return { key, label: WINNER_SIGNAL_LABEL[key], value: null, weight: null, observed: key === "active_continuity" ? input.momentumReason : null, missing: true };
  });
  const pesoTotal = medidas.reduce((s, m) => s + (ADLIB_SCORE_WEIGHTS[m.key] ?? 0), 0);
  const total = pesoTotal ? Math.round(medidas.reduce((s, m) => s + m.value * (ADLIB_SCORE_WEIGHTS[m.key] ?? 0), 0) / pesoTotal) : null;
  const n = medidas.length;
  return {
    total,
    confidence: n <= 2 ? "low" : n === 3 ? "medium" : "high",
    analyzedAt: iso(input.analyzedAt),
    reason: `${n} de 4 señales medibles de la Ad Library (pesos ${medidas.map((m) => `${m.key} ${ADLIB_SCORE_WEIGHTS[m.key]}`).join(", ")}). Sin gasto, ventas ni CTR: la API no los da. El resto de señales no existe en esta fuente.`,
    signals,
  };
}

// ------------------------------------------------------------
// adlib: último snapshot no ruido de cada candidato del discovery.
// ------------------------------------------------------------
interface SnapshotRow { candidate_key: string; page_id: string; page_name: string | null; fingerprint: string; captured_at: number; active_ads: number; oldest_active_at: number | null; momentum: string; previous_active_ads: number | null; ads_json: string; prev_captured_at: number | null }

function textOf(ads: AdLibraryAd[]): string {
  return ads.flatMap((a) => [...a.titles, ...a.bodies, ...(a.descriptions ?? [])]).join(" · ").replace(/\s+/g, " ").trim();
}

export function adlibResultFromSnapshot(row: SnapshotRow, now: number, countriesSeen: string[]): AdLibraryResult {
  let ads: AdLibraryAd[] = [];
  try { ads = JSON.parse(row.ads_json) as AdLibraryAd[]; } catch { ads = []; }
  const activeDays = row.oldest_active_at !== null ? Math.max(0, Math.floor((now - row.oldest_active_at) / DAY)) : null;
  const variations = ads.length ? creativeVariants(ads) : null;
  const dominio = declaredDomains(ads)[0] ?? null;
  const copy = textOf(ads) || null;
  const price = detectPriceInText(copy);
  const trace = computeMomentum({ activeAds: row.active_ads, previousActiveAds: row.previous_active_ads, previousCapturedAt: row.prev_captured_at, now });
  const titulo = ads.map((a) => a.titles[0]).find(Boolean) ?? ads.map((a) => a.bodies[0]).find(Boolean) ?? null;
  return {
    id: `adlib:${row.candidate_key}`,
    productName: titulo ? titulo.slice(0, 120) : null,
    advertiser: row.page_name,
    countries: countriesSeen,
    format: null,
    cta: null,
    startedAt: row.oldest_active_at !== null ? iso(row.oldest_active_at).slice(0, 10) : null,
    activeDays,
    variations,
    landingUrl: dominio ? `https://${dominio}` : null,
    detectedPrice: price ? { amount: price.amount, currency: price.currency } : null,
    previewUrl: ads.map((a) => a.snapshotUrl).find(Boolean) ?? null,
    adCopy: copy ? copy.slice(0, 1500) : null,
    dataStatus: "partial",
    winnerScore: adlibWinnerScore({ activeDays, variations, activeAds: row.active_ads, countriesSeen: countriesSeen.length, momentumReason: trace.reason, analyzedAt: row.captured_at }),
  };
}

const SNAPSHOT_SQL = `
  SELECT c.candidate_key, c.page_id, c.page_name, c.fingerprint, s.captured_at, s.active_ads, s.oldest_active_at, s.momentum, s.previous_active_ads, s.ads_json,
         (SELECT p.captured_at FROM adlib_candidate_snapshots p WHERE p.candidate_id = c.id AND p.id <> s.id ORDER BY p.captured_at DESC, p.id DESC LIMIT 1) AS prev_captured_at
  FROM adlib_candidates c
  JOIN adlib_candidate_snapshots s ON s.id = (SELECT id FROM adlib_candidate_snapshots x WHERE x.candidate_id = c.id ORDER BY x.captured_at DESC, x.id DESC LIMIT 1)
  WHERE s.noise = 0`;

export class AdlibSource {
  constructor(private readonly db: Database.Database = systemDbHandle(), private readonly discovery = new DiscoveryRepository(db)) {}

  private countries(row: SnapshotRow): string[] {
    const seen = this.discovery.countriesForCandidate(row.page_id, row.fingerprint);
    if (seen.length) return seen;
    const pais = row.candidate_key.split(":")[0];
    return /^[A-Z]{2}$/.test(pais) ? [pais] : [];
  }

  search(term: string, country: string, now: number): AdLibraryResult[] {
    const rows = this.db.prepare(`${SNAPSHOT_SQL} AND c.candidate_key LIKE ?`).all(`${country.toUpperCase()}:%`) as SnapshotRow[];
    const words = tokens(term);
    const out: AdLibraryResult[] = [];
    for (const row of rows) {
      const hay = tokens(`${row.page_name ?? ""} ${row.ads_json}`).join(" ");
      if (words.length && !words.every((w) => hay.includes(w))) continue;
      out.push(adlibResultFromSnapshot(row, now, this.countries(row)));
    }
    return out;
  }

  byKey(key: string, now: number): AdLibraryResult | null {
    const row = this.db.prepare(`${SNAPSHOT_SQL} AND c.candidate_key = ?`).get(key) as SnapshotRow | undefined;
    return row ? adlibResultFromSnapshot(row, now, this.countries(row)) : null;
  }
}

// ------------------------------------------------------------
// local: product_candidates (hunter:add / hechos manuales)
// ------------------------------------------------------------
export function factsOf(c: ProductCandidate, source: CandidateFactsView["source"]): CandidateFactsView {
  return { unitCostEur: c.unitCostEur, pvpEur: c.salePriceEur ?? null, weightGrams: c.weightGrams, lengthCm: c.lengthCm, widthCm: c.widthCm, heightCm: c.heightCm, source };
}

export function hunterScoreOf(c: ProductCandidate): HunterScoreView | null {
  if (!c.scoring) return null;
  return { score: c.scoring.score, verdict: c.scoring.verdict, unitMarginEur: c.scoring.unitMarginEur, maxCpaEur: c.scoring.maxCpaEur, breakEvenDeliveryPct: c.scoring.breakEvenDeliveryPct, shippingTier: c.scoring.shippingTier, reasons: c.scoring.reasons };
}

export function localResult(c: ProductCandidate): AdLibraryResult {
  const sintetico = c.sourceUrl.startsWith("hunter://");
  return {
    id: `local:${c.id}`,
    productName: c.name,
    advertiser: sintetico ? null : c.sourceDomain,
    countries: [],
    format: null, cta: null, startedAt: null, activeDays: null, variations: null,
    landingUrl: sintetico ? null : c.sourceUrl,
    detectedPrice: null, previewUrl: null,
    adCopy: sintetico ? "Candidato creado a mano (sin ficha de origen)." : `Ficha de origen: ${c.sourceDomain}. Sin datos de anuncio: no viene de la Ad Library.`,
    dataStatus: "partial",
    winnerScore: null,
  };
}

export class LocalSource {
  constructor(private readonly repo = new HunterRepository()) {}
  search(term: string): Array<{ result: AdLibraryResult; candidate: ProductCandidate }> {
    const words = tokens(term);
    return this.repo.list()
      .filter((c) => !c.sourceUrl.startsWith("hunter://")) // los creados desde el pipeline ya salen por su fuente
      .filter((c) => !words.length || words.every((w) => tokens(`${c.name ?? ""} ${c.sourceDomain}`).join(" ").includes(w)))
      .map((candidate) => ({ result: localResult(candidate), candidate }));
  }
  byId(id: number): ProductCandidate | null { return this.repo.byId(id); }
}

// ------------------------------------------------------------
// dropea: copia local del catálogo
// ------------------------------------------------------------
export function dropeaResult(r: DropeaCatalogRow): AdLibraryResult {
  return {
    id: `dropea:${r.variantId}`,
    productName: r.name ?? r.productName,
    advertiser: "Dropea (catálogo)",
    countries: [],
    format: null, cta: null, startedAt: null, activeDays: null, variations: null, landingUrl: null,
    detectedPrice: null, previewUrl: null,
    adCopy: [
      r.productName && r.name && r.productName !== r.name ? `Producto: ${r.productName}` : null,
      r.sku ? `SKU ${r.sku}` : null,
      r.costEur !== null ? `coste mayorista ${r.costEur.toFixed(2)} €` : "coste no informado",
      r.recommendedPriceEur !== null ? `PVPR de Dropea ${r.recommendedPriceEur.toFixed(2)} €` : null,
      r.stock !== null ? `stock ${r.stock}` : null,
      `copia del catálogo del ${iso(r.syncedAt).slice(0, 10)}`,
    ].filter(Boolean).join(" · "),
    dataStatus: "partial",
    winnerScore: null,
  };
}

export class DropeaSource {
  constructor(readonly repo = new DropeaCatalogRepository()) {}
  search(term: string, page: number, pageSize: number, category: string | null): { results: AdLibraryResult[]; total: number } {
    const { rows, total } = this.repo.search(term, { page, pageSize, category });
    return { results: rows.map(dropeaResult), total };
  }
  byVariantId(variantId: number): DropeaCatalogRow | null { return this.repo.byVariantId(variantId); }
}
