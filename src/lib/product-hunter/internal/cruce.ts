// ============================================================
// CRUCE DROPEA × AD LIBRARY · Score de Oportunidad Validada (08-09-2026)
// docs/PRODUCT-HUNTER-BACKEND-PLAN.md §2d y §3b · docs/PRODUCT-HUNTER-BACKEND-USO.md
//
// La idea invertida: en vez de descubrir un ganador y buscarlo en Dropea, se
// recorre el catálogo de Dropea (copia local) y, producto a producto, se
// pregunta a la Ad Library si alguien lo está anunciando, desde cuándo y a
// qué precio lo dice el anuncio. Coste real (Dropea) + demanda observada
// (anuncios activos) = oportunidad validada.
//
// HONESTIDAD, por partes:
//  · Emparejar Dropea ↔ anuncio es una HEURÍSTICA DE TEXTO. No hay id común.
//    Se sacan 2–4 palabras clave del nombre de Dropea, se buscan en
//    /ads_archive y se mide qué fracción de esas palabras aparece en el texto
//    del grupo (cobertura). Falsos positivos (nombre parecido, producto
//    distinto) y negativos (el anunciante lo llama de otra forma) existen y
//    se declaran en `match` (si | dudoso | no) y `matchConfidence`.
//  · El precio de competencia solo existe si está ESCRITO en el anuncio
//    (price-detect.ts). Sin precio no hay margen: la parte queda «no
//    calculable», nunca estimada. No se visita la landing del competidor.
//  · Momentum y señales: computeMomentum / creativeVariants del discovery,
//    importados. El «anterior» es el cruce previo del mismo producto.
//  · Volumen: es un proceso por lotes (CLI), con el presupuesto del discovery
//    (peticiones y tiempo) y persistencia producto a producto. El panel lee
//    lo persistido; nunca dispara el cruce desde una request.
//
// SCORE DE OPORTUNIDAD VALIDADA (0–100), con pesos y motivo:
//   validación de mercado   40 · antigüedad min(1, días/60)×20 + variantes
//                                min(1, n/3)×10 + activos min(1, n/5)×10
//                                (match «dudoso»: se divide entre 2; «no»: 0)
//   margen                  40 · sobre el precio detectado: pct = (precio −
//                                coste) / precio; puntos = clamp((pct − 0,30)
//                                / 0,40)×40 (30 % → 0, 70 % → 40). Sin
//                                precio: 0 y «no calculable»
//   confianza del match     20 · cobertura × 20
// Ejemplo numérico real en docs/PRODUCT-HUNTER-BACKEND-USO.md.
// ============================================================

import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import { canRunDiscovery } from "../../safety";
import { cleanMarketplaceTitle } from "../../hunter/ingest";
import { AdLibraryClient } from "../../hunter/discovery/client";
import { DiscoveryBudget, type StopReason } from "../../hunter/discovery/budget";
import { DiscoveryHaltedError, asAdLibraryError } from "../../hunter/discovery/errors";
import { groupAds } from "../../hunter/discovery/grouping";
import { computeMomentum } from "../../hunter/discovery/momentum";
import { creativeVariants } from "../../hunter/discovery/signals";
import type { AdLibraryAd, DiscoveryGroup } from "../../hunter/discovery/types";
import { mergeGroupsByPage } from "../../hunter/audit/store-audit";
import { DropeaCatalogRepository, tokens, type DropeaCatalogRow } from "./dropea-catalog";
import { detectPriceInText } from "./price-detect";

const DAY = 86_400;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const CRUCE_WEIGHTS = { validacion: 40, margen: 40, confianza: 20 } as const;
export const CRUCE_MARGIN_FLOOR = 0.3;
export const CRUCE_MARGIN_CEIL = 0.7;
export const CRUCE_FORMULA =
  "validación 40 (días/60×20 + variantes/3×10 + activos/5×10; dudoso ÷2; sin match 0) + margen 40 ((precio−coste)/precio, de 30 % → 0 a 70 % → 40; sin precio detectado: no calculable) + confianza del match 20 (cobertura de palabras clave × 20)";

/**
 * Palabras que no identifican un producto en un nombre de catálogo: relleno,
 * cantidades, y las VARIANTES (talla, color, medida) que Dropea mete en el
 * nombre de la variante («Faja reductora Negro XL», «Funda 20x30 cm»). Un
 * color o una talla en el término de búsqueda solo sirve para NO encontrar
 * al anunciante, que anuncia el producto, no la variante.
 */
const STOP = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "con", "sin", "para", "por", "en", "a", "al", "the", "and", "for", "with", "of", "to",
  "pack", "set", "kit", "lote", "unidad", "unidades", "uds", "ud", "pcs", "pieza", "piezas", "nuevo", "nueva", "oferta", "envio", "gratis", "modelo", "version", "premium", "pro", "plus", "mini", "max", "original", "casamable", "dropea",
  // variantes
  "color", "colores", "talla", "tallas", "tamano", "tamanos", "medida", "medidas", "unisex", "adulto", "adultos", "infantil",
  "rojo", "roja", "azul", "negro", "negra", "blanco", "blanca", "gris", "verde", "rosa", "amarillo", "amarilla", "beige", "dorado", "dorada", "plateado", "plateada", "marron", "naranja", "morado", "morada", "violeta", "turquesa", "transparente", "multicolor",
  "xs", "xxs", "xl", "xxl", "xxxl", "3xl", "4xl", "pequeno", "pequena", "mediano", "mediana", "grande", "grandes", "cm", "mm", "ml", "kg", "gr", "gramos", "litros", "pulgadas",
]);

/** Nombres con UNA sola palabra clave («Funda», «Soporte») casan con cualquier cosa: se marca genérico y la confianza se recorta a la mitad. */
export const GENERIC_KEYWORD_LIMIT = 1;
export function isGenericName(keywords: string[]): boolean {
  return keywords.length <= GENERIC_KEYWORD_LIMIT;
}

/** 2–4 palabras clave del nombre de Dropea: sin marca ni relleno, en orden de aparición. */
export function productKeywords(name: string): string[] {
  const limpio = cleanMarketplaceTitle(name) ?? name;
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const t of tokens(limpio)) {
    // números, «x2», «2x», medidas pegadas («20x30», «500ml», «30cm») y tallas
    if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t) || /^x\d+$/.test(t) || /^\d+x\d*$/.test(t) || /^\d+(cm|mm|ml|kg|gr?|l)$/.test(t) || /^[smlx]{1,4}$/.test(t)) continue;
    if (vistas.has(t)) continue;
    vistas.add(t);
    out.push(t);
    if (out.length === 4) break;
  }
  return out;
}

export type MatchVerdict = "si" | "dudoso" | "no";

export interface GroupMatch {
  group: DiscoveryGroup;
  /** Fracción de palabras clave presentes en el texto del grupo (0–1). */
  coverage: number;
  verdict: MatchVerdict;
}

function groupText(g: DiscoveryGroup): string {
  return tokens(g.ads.flatMap((a: AdLibraryAd) => [...a.titles, ...a.bodies, ...a.captions, ...(a.descriptions ?? [])]).join(" ")).join(" ");
}

/** El mejor grupo para estas palabras clave, con su veredicto. Null si no hay grupos útiles. */
export function bestMatch(keywords: string[], groups: DiscoveryGroup[]): GroupMatch | null {
  if (!keywords.length) return null;
  let best: GroupMatch | null = null;
  for (const group of groups) {
    if (group.noise) continue;
    const text = ` ${groupText(group)} `;
    const hits = keywords.filter((k) => text.includes(` ${k} `) || text.includes(k)).length;
    let coverage = hits / keywords.length;
    let verdict: MatchVerdict = "no";
    if (hits >= 2 && coverage >= 0.75) verdict = "si";
    else if (hits >= 1) verdict = "dudoso"; // una sola palabra (o pocas) coincidente: baja confianza, y la cobertura lo penaliza
    if (verdict === "no") continue;
    // Nombre genérico (una sola palabra clave): «si» es imposible y la cobertura se recorta a 0,5.
    if (isGenericName(keywords)) { verdict = "dudoso"; coverage = Math.min(coverage, 0.5); }
    if (!best || coverage > best.coverage || (coverage === best.coverage && group.activeAds > best.group.activeAds)) best = { group, coverage, verdict };
  }
  return best;
}

export interface CruceBreakdown {
  formula: string;
  keywords: string[];
  match: MatchVerdict;
  coverage: number;
  validacion: { points: number; max: number; detail: string };
  margen: { points: number; max: number; detail: string; calculable: boolean };
  confianza: { points: number; max: number; detail: string };
  momentum: { status: string; reason: string };
  priceQuote: string | null;
  /** Avisos del parser: «sin IVA», «desde», «precio de lote», «varios importes». Vacío = sin matices. */
  priceNotes: string[];
  snapshotUrl: string | null;
}

export interface CruceRow {
  id: number;
  runId: number;
  variantId: number;
  productName: string | null;
  costEur: number | null;
  terms: string[];
  match: MatchVerdict;
  matchConfidence: number;
  adlibCandidateKey: string | null;
  pageName: string | null;
  activeAds: number | null;
  oldestActiveAt: number | null;
  variants: number | null;
  momentum: string | null;
  detectedPriceEur: number | null;
  detectedPriceSource: string | null;
  marginEur: number | null;
  marginPct: number | null;
  score: number | null;
  breakdown: CruceBreakdown;
  country: string;
  capturedAt: number;
}

/** El score, puro: mismo cálculo en el motor, en el CLI y en los tests. */
export function scoreCruce(input: { costEur: number | null; match: GroupMatch | null; detectedPrice: number | null; activeDays: number | null; variants: number | null; activeAds: number | null; momentum: { status: string; reason: string } }): { score: number; marginEur: number | null; marginPct: number | null; breakdown: Omit<CruceBreakdown, "keywords" | "priceQuote" | "priceNotes" | "snapshotUrl"> } {
  const m = input.match;
  // 1 · validación de mercado
  let validacion = 0;
  let detalleV = "sin anuncios que casen con el producto: sin validar por el mercado";
  if (m) {
    const dias = Math.min(1, (input.activeDays ?? 0) / 60) * 20;
    const variantes = Math.min(1, (input.variants ?? 0) / 3) * 10;
    const activos = Math.min(1, (input.activeAds ?? 0) / 5) * 10;
    validacion = dias + variantes + activos;
    if (m.verdict === "dudoso") validacion /= 2;
    detalleV = `${input.activeDays ?? 0} días activo (${round2(dias)}), ${input.variants ?? 0} variantes (${round2(variantes)}), ${input.activeAds ?? 0} activos (${round2(activos)})${m.verdict === "dudoso" ? " · match dudoso: ÷2" : ""}`;
  }
  // 2 · margen sobre el precio detectado
  let margen = 0, marginEur: number | null = null, marginPct: number | null = null, calculable = false;
  let detalleM = "no calculable — falta precio de competencia (no está escrito en el anuncio)";
  if (input.costEur === null) detalleM = "no calculable — el catálogo no informa el coste";
  else if (m && input.detectedPrice !== null && input.detectedPrice > 0) {
    calculable = true;
    marginEur = round2(input.detectedPrice - input.costEur);
    marginPct = round2((input.detectedPrice - input.costEur) / input.detectedPrice);
    margen = Math.max(0, Math.min(1, (marginPct - CRUCE_MARGIN_FLOOR) / (CRUCE_MARGIN_CEIL - CRUCE_MARGIN_FLOOR))) * CRUCE_WEIGHTS.margen;
    detalleM = `precio detectado en el anuncio ${input.detectedPrice.toFixed(2)} € − coste Dropea ${input.costEur.toFixed(2)} € = ${marginEur.toFixed(2)} € (${Math.round(marginPct * 100)} % sobre precio); es margen bruto, sin envío ni COD`;
  }
  // 3 · confianza del match
  const confianza = (m?.coverage ?? 0) * CRUCE_WEIGHTS.confianza;
  const score = round2(validacion + margen + confianza);
  return {
    score, marginEur, marginPct,
    breakdown: {
      formula: CRUCE_FORMULA,
      match: m?.verdict ?? "no",
      coverage: round2(m?.coverage ?? 0),
      validacion: { points: round2(validacion), max: CRUCE_WEIGHTS.validacion, detail: detalleV },
      margen: { points: round2(margen), max: CRUCE_WEIGHTS.margen, detail: detalleM, calculable },
      confianza: { points: round2(confianza), max: CRUCE_WEIGHTS.confianza, detail: m ? `${Math.round(m.coverage * 100)} % de las palabras clave aparecen en el anuncio` : "sin match" },
      momentum: input.momentum,
    },
  };
}

// ------------------------------------------------------------
// Persistencia
// ------------------------------------------------------------
function rowOf(r: Record<string, unknown>): CruceRow {
  let breakdown: CruceBreakdown;
  try { breakdown = JSON.parse(String(r.breakdown_json)) as CruceBreakdown; } catch { breakdown = { formula: CRUCE_FORMULA, keywords: [], match: "no", coverage: 0, validacion: { points: 0, max: 40, detail: "" }, margen: { points: 0, max: 40, detail: "", calculable: false }, confianza: { points: 0, max: 20, detail: "" }, momentum: { status: "sin_datos", reason: "" }, priceQuote: null, priceNotes: [], snapshotUrl: null }; }
  let terms: string[] = [];
  try { terms = JSON.parse(String(r.terms_json)) as string[]; } catch { terms = []; }
  return {
    id: Number(r.id), runId: Number(r.run_id), variantId: Number(r.variant_id), productName: r.product_name as string | null, costEur: r.cost_eur as number | null, terms,
    match: r.match as MatchVerdict, matchConfidence: Number(r.match_confidence), adlibCandidateKey: r.adlib_candidate_key as string | null, pageName: r.page_name as string | null,
    activeAds: r.active_ads as number | null, oldestActiveAt: r.oldest_active_at as number | null, variants: r.variants as number | null, momentum: r.momentum as string | null,
    detectedPriceEur: r.detected_price_eur as number | null, detectedPriceSource: r.detected_price_source as string | null, marginEur: r.margin_eur as number | null, marginPct: r.margin_pct as number | null,
    score: r.score as number | null, breakdown, country: String(r.country), capturedAt: Number(r.captured_at),
  };
}

export class CruceRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}

  startRun(input: { country: string; category: string | null; maxProducts: number | null; now: number }): number {
    const r = this.db.prepare("INSERT INTO hunter_cruce_runs(started_at,country,category,max_products) VALUES(?,?,?,?)").run(input.now, input.country, input.category, input.maxProducts);
    return Number(r.lastInsertRowid);
  }
  progress(runId: number, p: { processed: number; matched: number; requests: number }): void {
    this.db.prepare("UPDATE hunter_cruce_runs SET processed=?,matched=?,requests=? WHERE id=?").run(p.processed, p.matched, p.requests, runId);
  }
  finishRun(runId: number, stopReason: string, now: number): void {
    this.db.prepare("UPDATE hunter_cruce_runs SET finished_at=?,stop_reason=? WHERE id=?").run(now, stopReason, runId);
  }
  /** El cruce anterior del mismo producto (para el momentum), de otra corrida. */
  previousFor(variantId: number, runId: number): { activeAds: number | null; capturedAt: number } | null {
    const r = this.db.prepare("SELECT active_ads, captured_at FROM hunter_cruces WHERE variant_id=? AND run_id<>? ORDER BY captured_at DESC, id DESC LIMIT 1").get(variantId, runId) as { active_ads: number | null; captured_at: number } | undefined;
    return r ? { activeAds: r.active_ads, capturedAt: r.captured_at } : null;
  }
  insert(c: Omit<CruceRow, "id">): CruceRow {
    const r = this.db.prepare(`INSERT INTO hunter_cruces(run_id,variant_id,product_name,cost_eur,terms_json,match,match_confidence,adlib_candidate_key,page_name,active_ads,oldest_active_at,variants,momentum,detected_price_eur,detected_price_source,margin_eur,margin_pct,score,breakdown_json,country,captured_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.runId, c.variantId, c.productName, c.costEur, JSON.stringify(c.terms), c.match, c.matchConfidence, c.adlibCandidateKey, c.pageName, c.activeAds, c.oldestActiveAt, c.variants, c.momentum, c.detectedPriceEur, c.detectedPriceSource, c.marginEur, c.marginPct, c.score, JSON.stringify(c.breakdown), c.country, c.capturedAt);
    return this.byId(Number(r.lastInsertRowid))!;
  }
  byId(id: number): CruceRow | null {
    const r = this.db.prepare("SELECT * FROM hunter_cruces WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }
  /** El último cruce de cada producto, ordenado por score. */
  latest(opts: { country?: string; term?: string; limit?: number } = {}): CruceRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.country) { where.push("c.country=?"); params.push(opts.country.toUpperCase()); }
    for (const w of tokens(opts.term ?? "")) { where.push("LOWER(COALESCE(c.product_name,'')) LIKE ?"); params.push(`%${w}%`); }
    const sql = `SELECT c.* FROM hunter_cruces c
      WHERE c.id = (SELECT x.id FROM hunter_cruces x WHERE x.variant_id=c.variant_id ORDER BY x.captured_at DESC, x.id DESC LIMIT 1)
      ${where.length ? "AND " + where.join(" AND ") : ""}
      ORDER BY c.score DESC, c.captured_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, opts.limit ?? 200) as Array<Record<string, unknown>>).map(rowOf);
  }
  latestForVariant(variantId: number): CruceRow | null {
    const r = this.db.prepare("SELECT * FROM hunter_cruces WHERE variant_id=? ORDER BY captured_at DESC, id DESC LIMIT 1").get(variantId) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }
  /** Cuántos productos del catálogo ya tienen cruce (para el offset por defecto del CLI). */
  crossedVariantIds(): Set<number> {
    return new Set((this.db.prepare("SELECT DISTINCT variant_id FROM hunter_cruces").all() as Array<{ variant_id: number }>).map((r) => r.variant_id));
  }
}

// ------------------------------------------------------------
// Motor por lotes
// ------------------------------------------------------------
export interface CruceBatchInput {
  token: string;
  country?: string;
  days?: number;
  limit: number;
  offset?: number;
  category?: string | null;
  /** Salta los productos que ya tienen cruce (default true). */
  skipCrossed?: boolean;
  now?: number;
  client?: AdLibraryClient;
  budget?: DiscoveryBudget;
  catalog?: DropeaCatalogRepository;
  repo?: CruceRepository;
  onProduct?: (c: CruceRow, i: number, total: number) => void;
}

export interface CruceBatchReport {
  runId: number;
  processed: number;
  matched: number;
  requests: number;
  stopReason: StopReason | "completado";
  elapsedSec: number;
  cruces: CruceRow[];
}

export async function runCruceBatch(input: CruceBatchInput): Promise<CruceBatchReport> {
  if (!canRunDiscovery()) throw new DiscoveryHaltedError();
  const started = Date.now();
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const country = (input.country ?? "ES").toUpperCase();
  const days = input.days ?? 30;
  const catalog = input.catalog ?? new DropeaCatalogRepository();
  const repo = input.repo ?? new CruceRepository();
  const client = input.client ?? new AdLibraryClient(input.token);
  // Presupuesto: el del discovery (peticiones + tiempo). Un producto = 1 petición (una página).
  const budget = input.budget ?? new DiscoveryBudget({ deadlineAt: started + 15 * 60_000, maxRequests: Math.min(400, input.limit + 5) });
  const until = new Date(now * 1000).toISOString().slice(0, 10);
  const since = new Date((now - days * DAY) * 1000).toISOString().slice(0, 10);

  const yaCruzados = input.skipCrossed === false ? new Set<number>() : repo.crossedVariantIds();
  const lote = catalog.batchForCross({ limit: input.limit + yaCruzados.size, offset: input.offset ?? 0, category: input.category ?? null }).filter((r) => !yaCruzados.has(r.variantId)).slice(0, input.limit);
  const runId = repo.startRun({ country, category: input.category ?? null, maxProducts: input.limit, now });
  const cruces: CruceRow[] = [];
  let stopReason: StopReason | "completado" = "completado";
  let matched = 0;

  for (let i = 0; i < lote.length; i++) {
    const producto = lote[i];
    const freno = budget.check();
    if (freno) { stopReason = freno; break; }
    if (!canRunDiscovery()) { repo.finishRun(runId, "parada_emergencia", now); throw new DiscoveryHaltedError(); }
    // El nombre del PRODUCTO (sin la variante «Negro XL») manda; el de la variante solo si no hay otro.
    const keywords = productKeywords(producto.productName ?? producto.name ?? "");
    let match: GroupMatch | null = null;
    let busquedaError: string | null = null;
    if (keywords.length) {
      try {
        const r = await client.search({ term: keywords.join(" "), country, since, until, budget, maxPages: 1 });
        if (r.stopReason === "rate_limit" || r.stopReason === "deadline" || r.stopReason === "presupuesto_peticiones") { stopReason = r.stopReason; }
        if (r.error) busquedaError = r.error;
        // Los grupos del discovery separan líneas de producto de una misma página; aquí la unidad es el anunciante.
        match = bestMatch(keywords, mergeGroupsByPage(groupAds(r.ads, now, country)));
      } catch (err) {
        const e = asAdLibraryError(err);
        if (e.abortRun) { repo.finishRun(runId, e.kind, now); throw e; }
        busquedaError = e.message;
      }
    }
    const g = match?.group ?? null;
    const activeDays = g?.oldestActiveAt != null ? Math.max(0, Math.floor((now - g.oldestActiveAt) / DAY)) : null;
    const variants = g ? creativeVariants(g.ads) : null;
    const text = g ? g.ads.flatMap((a) => [...a.titles, ...a.bodies, ...(a.descriptions ?? [])]).join(" · ") : "";
    const price = g ? detectPriceInText(text) : null;
    const previous = repo.previousFor(producto.variantId, runId);
    const momentum = computeMomentum({ activeAds: g?.activeAds ?? 0, previousActiveAds: previous?.activeAds ?? null, previousCapturedAt: previous?.capturedAt ?? null, now });
    const s = scoreCruce({ costEur: producto.costEur, match, detectedPrice: price?.amount ?? null, activeDays, variants, activeAds: g?.activeAds ?? null, momentum: { status: momentum.status, reason: momentum.reason } });
    const priceNotes: string[] = [];
    if (price?.vat === "excl") priceNotes.push("el anuncio dice «sin IVA»: el precio final al cliente es mayor; no se ajusta");
    if (price?.isFrom) priceNotes.push("«desde»: puede ser la variante más barata");
    if (price?.unitAmbiguous) priceNotes.push("precio de lote («N por X €»), no unitario");
    if (price && price.candidates > 1) priceNotes.push(`${price.candidates} importes distintos en el texto: se eligió el marcado como precio o el más bajo`);
    const breakdown: CruceBreakdown = { ...s.breakdown, keywords, priceQuote: price?.quote ?? null, priceNotes, snapshotUrl: g?.ads.map((a) => a.snapshotUrl).find(Boolean) ?? null };
    if (priceNotes.length && breakdown.margen.calculable) breakdown.margen.detail += ` · ${priceNotes.join("; ")}`;
    if (busquedaError) breakdown.validacion.detail += ` · la consulta a la Ad Library falló (${busquedaError}): sin validar no significa que no anuncien`;
    if (!keywords.length) breakdown.validacion.detail = "el nombre del producto no deja palabras clave útiles: no se buscó";
    if (keywords.length && isGenericName(keywords)) breakdown.confianza.detail += ` · nombre genérico (${keywords.join(", ")}): confianza recortada a la mitad; revisar a mano`;
    const row = repo.insert({
      runId, variantId: producto.variantId, productName: producto.name ?? producto.productName, costEur: producto.costEur, terms: keywords,
      match: match?.verdict ?? "no", matchConfidence: round2(match?.coverage ?? 0), adlibCandidateKey: g?.key ?? null, pageName: g?.pageName ?? null,
      activeAds: g?.activeAds ?? null, oldestActiveAt: g?.oldestActiveAt ?? null, variants, momentum: g ? momentum.status : null,
      detectedPriceEur: price?.amount ?? null, detectedPriceSource: price ? "anuncio" : null, marginEur: s.marginEur, marginPct: s.marginPct, score: s.score, breakdown, country, capturedAt: now,
    });
    if (row.match !== "no") matched++;
    cruces.push(row);
    repo.progress(runId, { processed: cruces.length, matched, requests: budget.requests });
    input.onProduct?.(row, i + 1, lote.length);
    if (stopReason !== "completado") break;
  }
  repo.finishRun(runId, stopReason, Math.floor(Date.now() / 1000));
  return { runId, processed: cruces.length, matched, requests: budget.requests, stopReason, elapsedSec: Math.round((Date.now() - started) / 1000), cruces };
}
