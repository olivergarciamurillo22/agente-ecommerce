// ============================================================
// FUENTE «cruce» PARA EL PANEL (08-09-2026)
// Lee los cruces YA persistidos por `hunter:cruce-dropea` y los enseña como
// resultados del Cazador con su Score de Oportunidad Validada desglosado.
// Nunca dispara un cruce desde una request: eso es el CLI.
// ============================================================

import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import type { AdLibraryResult, WinnerScoreBreakdown, WinnerScoreSignal, WinnerSignalKey } from "../types";
import { WINNER_SIGNAL_KEYS, WINNER_SIGNAL_LABEL } from "../types";
import { CruceRepository, type CruceRow } from "./cruce";
import { DropeaCatalogRepository, type DropeaCatalogRow } from "./dropea-catalog";
import { dropeaResult } from "./sources";

const DAY = 86_400;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** El desglose del cruce en las 11 señales del contrato: lo que no se midió, `missing`. */
export function cruceWinnerScore(c: CruceRow): WinnerScoreBreakdown {
  const b = c.breakdown;
  const activeDays = c.oldestActiveAt !== null ? Math.max(0, Math.floor((c.capturedAt - c.oldestActiveAt) / DAY)) : null;
  const medidas = new Map<WinnerSignalKey, { value: number | null; weight: number | null; observed: string }>();
  if (c.match !== "no") {
    medidas.set("ad_age", { value: activeDays === null ? null : Math.round(Math.min(100, (activeDays / 60) * 100)), weight: 20, observed: `${activeDays ?? 0} días activo el anuncio más antiguo del grupo` });
    medidas.set("creative_variations", { value: Math.round(Math.min(100, ((c.variants ?? 0) / 3) * 100)), weight: 10, observed: `${c.variants ?? 0} textos creativos distintos` });
    medidas.set("advertiser_similar_ads", { value: Math.round(Math.min(100, ((c.activeAds ?? 0) / 5) * 100)), weight: 10, observed: `${c.activeAds ?? 0} anuncios activos de «${c.pageName ?? "?"}»` });
    medidas.set("active_continuity", { value: null, weight: null, observed: b.momentum.reason });
  }
  medidas.set("margin_potential", b.margen.calculable && c.marginPct !== null
    ? { value: Math.round(Math.max(0, Math.min(1, (c.marginPct - 0.3) / 0.4)) * 100), weight: 40, observed: b.margen.detail }
    : { value: null, weight: 40, observed: b.margen.detail });
  medidas.set("price_potential", c.detectedPriceEur !== null
    ? { value: null, weight: null, observed: `precio detectado en el anuncio: ${c.detectedPriceEur.toFixed(2)} € («${b.priceQuote ?? ""}»)` }
    : { value: null, weight: null, observed: "sin precio escrito en el anuncio" });
  medidas.set("offer_clarity", { value: Math.round(c.matchConfidence * 100), weight: 20, observed: `confianza del emparejamiento por texto: ${b.confianza.detail} (heurística; palabras clave: ${b.keywords.join(", ")})` });
  const signals: WinnerScoreSignal[] = WINNER_SIGNAL_KEYS.map((key) => {
    const m = medidas.get(key);
    return m ? { key, label: WINNER_SIGNAL_LABEL[key], value: m.value, weight: m.weight, observed: m.observed, missing: m.value === null } : { key, label: WINNER_SIGNAL_LABEL[key], value: null, weight: null, observed: null, missing: true };
  });
  return {
    total: c.score,
    confidence: c.match === "si" && b.margen.calculable ? "high" : c.match === "no" ? "low" : "medium",
    analyzedAt: iso(c.capturedAt),
    reason: `${b.formula}. Validación ${b.validacion.points}/${b.validacion.max} (${b.validacion.detail}); margen ${b.margen.points}/${b.margen.max} (${b.margen.detail}); confianza ${b.confianza.points}/${b.confianza.max}. Match «${c.match}».`,
    signals,
  };
}

export function cruceResult(c: CruceRow, dropea: DropeaCatalogRow | null): AdLibraryResult {
  const activeDays = c.oldestActiveAt !== null ? Math.max(0, Math.floor((c.capturedAt - c.oldestActiveAt) / DAY)) : null;
  return {
    id: `cruce:${c.id}`,
    productName: c.productName ?? dropea?.name ?? null,
    advertiser: c.match === "no" ? "sin anunciante que case (Ad Library)" : c.pageName,
    countries: [c.country],
    format: null, cta: null,
    startedAt: c.oldestActiveAt !== null ? iso(c.oldestActiveAt).slice(0, 10) : null,
    activeDays,
    variations: c.variants,
    landingUrl: null,
    detectedPrice: c.detectedPriceEur !== null ? { amount: c.detectedPriceEur, currency: "EUR" } : null,
    previewUrl: c.breakdown.snapshotUrl,
    adCopy: [
      `Cruce Dropea × Ad Library del ${iso(c.capturedAt).slice(0, 10)}`,
      c.costEur !== null ? `coste Dropea ${c.costEur.toFixed(2)} €` : "coste no informado",
      `match ${c.match} (${Math.round(c.matchConfidence * 100)} %, palabras: ${c.terms.join(", ")})`,
      c.marginEur !== null ? `margen bruto ${c.marginEur.toFixed(2)} €` : "margen no calculable (sin precio en el anuncio)",
      `momentum: ${c.breakdown.momentum.reason}`,
    ].join(" · "),
    dataStatus: "partial",
    winnerScore: cruceWinnerScore(c),
  };
}

export class CruceSource {
  private readonly repo: CruceRepository;
  private readonly catalog: DropeaCatalogRepository;
  constructor(db: Database.Database = systemDbHandle()) {
    this.repo = new CruceRepository(db);
    this.catalog = new DropeaCatalogRepository(db);
  }
  search(term: string, country: string): AdLibraryResult[] {
    return this.repo.latest({ term, country }).map((c) => cruceResult(c, this.catalog.byVariantId(c.variantId)));
  }
  byId(id: number): AdLibraryResult | null {
    const c = this.repo.byId(id);
    return c ? cruceResult(c, this.catalog.byVariantId(c.variantId)) : null;
  }
  dropeaRowOf(cruceId: number): DropeaCatalogRow | null {
    const c = this.repo.byId(cruceId);
    return c ? this.catalog.byVariantId(c.variantId) : null;
  }
  /** Un producto de Dropea con su último cruce, si lo tiene: el score viaja con él. */
  enrichDropea(row: DropeaCatalogRow, _now: number): AdLibraryResult {
    const base = dropeaResult(row);
    const c = this.repo.latestForVariant(row.variantId);
    if (!c) return base;
    return { ...base, countries: [c.country], startedAt: c.oldestActiveAt !== null ? iso(c.oldestActiveAt).slice(0, 10) : null, activeDays: c.oldestActiveAt !== null ? Math.max(0, Math.floor((c.capturedAt - c.oldestActiveAt) / DAY)) : null, variations: c.variants, detectedPrice: c.detectedPriceEur !== null ? { amount: c.detectedPriceEur, currency: "EUR" } : null, previewUrl: c.breakdown.snapshotUrl, adCopy: `${base.adCopy} · último cruce ${iso(c.capturedAt).slice(0, 10)}: match ${c.match}, score ${c.score}`, winnerScore: cruceWinnerScore(c) };
  }
}
