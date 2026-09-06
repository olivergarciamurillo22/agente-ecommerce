// ============================================================
// AI Winner Radar — ORQUESTADOR DE UNA BÚSQUEDA.
//
// Une todo: interpretar → expandir consultas → consultar fuentes →
// deduplicar → agrupar → señales → puntuar → filtrar → guardar.
//
// TRES COSAS QUE GOBIERNAN ESTE FICHERO:
//
// 1. TOLERANCIA A FALLOS (§68). Si WinningHunter se cae pero Meta responde,
//    la búsqueda termina en PARTIAL con lo que hay. Abortar entera por una
//    fuente sería tirar resultados buenos y créditos ya gastados.
// 2. PRESUPUESTO. Todas las llamadas pasan por un CallBudget compartido: una
//    búsqueda no puede vaciar la cuenta por un bucle mal escrito.
// 3. NADA DE 5 MINUTOS EN UN REQUEST (§19). Esto se ejecuta en segundo plano
//    y va escribiendo su progreso; la interfaz lo consulta.
// ============================================================

import { randomUUID } from "node:crypto";
import { logIntegrationEvent } from "../../system/repo";
import { CallBudget } from "../http";
import { clusterAds } from "../cluster";
import { computeOpportunityEconomics } from "../economics";
import { classifyProduct, generateOpportunitySummary, interpretSearchIntent } from "../intelligence";
import { getCategoryPerformance, getInternalRates } from "../providers/internal";
import { lookupSupplierCost } from "../providers/supplier";
import { fixtureModeActive, searchProviders } from "../providers/registry";
import { computeSignals, dedupeAds, observedPriceRange, seenRange } from "../signals";
import { scoreCreativeInvestment, scoreMarket, scoreMomentum, scoreSaturation } from "../scoring/market";
import { scoreCasamable, scoreProduct } from "../scoring/product";
import { emptyScore, scoreOpportunity } from "../scoring/opportunity";
import type { HunterAd, HunterFilters, ProductOpportunity, ScoreKey, ScoreValue, SearchRun } from "../types";
import { applyAiFilters, applyFinancialFilters, applyPostFilters, defaultFilters } from "./filters";
import { dedupeQueries, expandQueries } from "./query-expansion";
import * as repo from "../repo";

/** Tope de llamadas por búsqueda. Es dinero: se elige explícitamente. */
export const DEFAULT_CALL_BUDGET = 24;
/** Tope de productos analizados con IA: cada uno es una llamada al modelo. */
export const MAX_AI_ANALYSIS = 12;

export interface StartSearchInput {
  prompt: string | null;
  filters?: Partial<HunterFilters>;
  maxQueries?: number;
  callBudget?: number;
  createdBy?: string | null;
}

export function newSearchRun(input: StartSearchInput, filters: HunterFilters, queries: string[]): SearchRun {
  return {
    id: `hs_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    prompt: input.prompt,
    filters,
    queries,
    state: "queued",
    progress: {
      sourcesQueried: 0, sourcesTotal: 0, sourcesFailed: [], adsAnalyzed: 0,
      productsDetected: 0, candidatesDiscarded: 0, opportunities: 0,
    },
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
    error: null,
    providerCalls: 0,
    creditsSpent: null,
    fixtureMode: fixtureModeActive(),
  };
}

/** Prepara la búsqueda (interpreta y expande) sin salir a la red todavía. */
export async function planSearch(input: StartSearchInput): Promise<{ run: SearchRun; aiUsed: boolean }> {
  let filters: HunterFilters = { ...defaultFilters(), ...(input.filters ?? {}) };
  let sugeridas: string[] = [];
  let aiUsed = false;

  if (input.prompt && input.prompt.trim()) {
    const intent = await interpretSearchIntent(input.prompt);
    aiUsed = intent.aiUsed;
    // Lo que Pedro fijó a mano MANDA sobre lo que interprete la IA.
    filters = { ...intent.filters, ...(input.filters ?? {}) };
    sugeridas = intent.suggestedQueries;
  }

  const queries = dedupeQueries(
    expandQueries(filters.keywords, { maxQueries: input.maxQueries, aiSuggestions: sugeridas })
  );
  return { run: newSearchRun(input, filters, queries), aiUsed };
}

/**
 * Ejecuta la búsqueda entera. Va persistiendo el progreso para que la
 * interfaz pueda enseñarlo sin esperar al final.
 */
export async function executeSearch(run: SearchRun): Promise<SearchRun> {
  const budget = new CallBudget(DEFAULT_CALL_BUDGET);
  const proveedores = searchProviders({ budget });
  run.state = "running";
  run.progress.sourcesTotal = proveedores.length;
  repo.updateSearchRun(run);

  logIntegrationEvent("hunter", "hunter_search_started", "info",
    `búsqueda ${run.id}: ${run.queries.length} consulta(s) sobre ${proveedores.length} fuente(s)`);

  if (proveedores.length === 0) {
    run.state = "failed";
    run.error = "No hay ninguna fuente de anuncios configurada.";
    run.finishedAt = Math.floor(Date.now() / 1000);
    repo.updateSearchRun(run);
    return run;
  }

  // --- 1 · Recolectar de todas las fuentes ---
  const recogidos: HunterAd[] = [];
  let creditos = 0;

  for (const p of proveedores) {
    if (!p.searchAds) continue;
    let fallo: string | null = null;
    for (const q of run.queries) {
      if (!budget.canAfford(1)) break;
      const t0 = Date.now();
      const res = await p.searchAds({
        keywords: q,
        country: run.filters.country,
        activeOnly: true,
        minDaysActive: run.filters.minDaysActive ?? undefined,
        limit: 40,
      });
      run.providerCalls += res.calls;
      if (res.credits) creditos += res.credits;
      repo.recordProviderRun({
        searchId: run.id, provider: p.id, capability: "META_ADS", ok: res.ok,
        httpStatus: res.status, error: res.error, calls: res.calls,
        credits: res.credits, durationMs: Date.now() - t0,
      });
      if (res.ok && res.data) {
        recogidos.push(...res.data.ads);
      } else {
        fallo = res.error ?? "fallo desconocido";
        logIntegrationEvent("hunter", res.status === 429 ? "hunter_provider_rate_limited" : "hunter_provider_failed",
          "warning", `${p.id}: ${fallo}`);
        // Un 401/403 no mejora en la siguiente consulta: se abandona esta
        // fuente en vez de gastar el resto del presupuesto contra un muro.
        if (res.status === 401 || res.status === 403) break;
      }
      repo.updateSearchRun(run);
    }
    run.progress.sourcesQueried += 1;
    if (fallo) run.progress.sourcesFailed.push(p.id);
    repo.updateSearchRun(run);
  }

  run.creditsSpent = creditos > 0 ? creditos : null;

  // --- 2 · Deduplicar y agrupar ---
  const { ads, removed } = dedupeAds(recogidos);
  run.progress.adsAnalyzed = ads.length;
  if (ads.length === 0) {
    run.state = run.progress.sourcesFailed.length > 0 ? "partial" : "complete";
    run.error = run.progress.sourcesFailed.length > 0 ? `Sin resultados; fallaron: ${run.progress.sourcesFailed.join(", ")}` : null;
    run.finishedAt = Math.floor(Date.now() / 1000);
    repo.updateSearchRun(run);
    return run;
  }
  repo.upsertAds(ads);

  const clusters = clusterAds(ads);
  run.progress.productsDetected = clusters.length;
  repo.updateSearchRun(run);
  logIntegrationEvent("hunter", "hunter_cluster_created", "info",
    `${ads.length} anuncios (${removed} duplicados fuera) → ${clusters.length} producto(s)`);

  // --- 3 · Puntuar cada producto ---
  const rates = getInternalRates();
  const perf = getCategoryPerformance(null);
  const porId = new Map(ads.map((a) => [a.id, a]));
  const oportunidades: ProductOpportunity[] = [];
  let descartados = 0;
  let analizadosIA = 0;

  // Los clusters grandes primero: son los que más probablemente importan, y
  // así el presupuesto de IA se gasta en lo relevante.
  const ordenados = [...clusters].sort((a, b) => b.adIds.length - a.adIds.length);

  for (const cl of ordenados) {
    const suyos = cl.adIds.map((id) => porId.get(id)).filter((a): a is HunterAd => !!a);
    if (suyos.length === 0) continue;

    const signals = computeSignals(suyos);
    const precios = observedPriceRange(suyos);
    const { firstSeenAt, lastSeenAt } = seenRange(suyos);
    const productId = `hp_${cl.id.slice(3)}`;

    // Momentum solo si HAY histórico. Sin foto anterior no se inventa.
    const ago7 = repo.getSnapshotAround(productId, 7);
    const historyDepth = repo.countSnapshots(productId);

    const market = scoreMarket(signals);
    const momentum = scoreMomentum({ now: signals, ago7d: ago7 });
    const saturation = scoreSaturation(signals);
    const creative = scoreCreativeInvestment(signals);

    // IA solo para los primeros: cada análisis cuesta.
    let features = analizadosIA < MAX_AI_ANALYSIS
      ? await classifyProduct({
          name: cl.canonicalName,
          adCopySamples: suyos.map((a) => a.adCopy).filter((c): c is string => !!c),
          category: null,
        })
      : [];
    if (features.length > 0) analizadosIA += 1;

    const supplier = lookupSupplierCost(cl.canonicalName);
    const salePrice = precios.max ?? precios.min;
    const economics = computeOpportunityEconomics({
      salePrice,
      salePriceProvenance: "OBSERVED",
      supplierCost: supplier.cost.value,
      supplierCostProvenance: supplier.cost.provenance,
      supplierCostSource: supplier.cost.source,
      deliveryRate: rates.deliveryRate.value,
      deliveryRateSource: rates.deliveryRate.source,
      shippingRate: rates.shippingRate.value,
      shippingRateSource: rates.shippingRate.source,
      rawCPA: rates.rawCPA.value,
      rawCPASource: rates.rawCPA.source,
      outboundShippingCost: rates.outboundShippingCost,
      codFee: rates.codFee,
      returnCost: rates.returnCost,
      vatRate: rates.vatRate,
      otherCostPerOrder: rates.otherCostPerOrder,
    });

    const product = scoreProduct(features);
    const casamable = scoreCasamable({
      economics,
      historicalDeliveryRate: perf.deliveryRate.value,
      historicalRefusalRate: perf.refusalRate.value,
      historicalCancellationRate: perf.cancellationRate.value,
      supplierAvailable: supplier.available,
      supplierLeadTimeDays: supplier.leadTimeDays,
      codSuitability: null,
      shippingComplexity: features.find((f) => f.key === "complexity")?.value ?? null,
    });

    const proveedoresDelCluster = [...new Set(suyos.map((a) => a.provider))];
    const { score: opportunity, badges } = scoreOpportunity({
      market, product, casamable, saturation, momentum, features, economics,
      supplierAvailable: supplier.available,
      providerCount: proveedoresDelCluster.length,
      failedProviders: run.progress.sourcesFailed.length,
      historyDepth,
      dataAgeHours: lastSeenAt ? (Date.now() / 1000 - lastSeenAt) / 3600 : null,
      clusterConfidence: cl.confidence,
    });

    const scores: Record<ScoreKey, ScoreValue> = {
      market, momentum, saturation, creative_investment: creative,
      product: product.score === null ? emptyScore() : product,
      casamable, opportunity,
    };

    const op: ProductOpportunity = {
      id: productId,
      canonicalName: cl.canonicalName,
      category: null,
      description: null,
      heroImageUrl: suyos.find((a) => a.imageUrl)?.imageUrl ?? null,
      observedPriceMin: precios.min,
      observedPriceMax: precios.max,
      supplierCostMin: supplier.cost.value,
      supplierCostMax: supplier.cost.value,
      currency: precios.currency,
      firstSeenAt,
      lastSeenAt,
      status: "new",
      sourceConfidence: opportunity.confidence,
      clusterConfidence: cl.confidence,
      signals,
      scores,
      features,
      economics,
      badges,
      adIds: suyos.map((a) => a.id),
      providers: proveedoresDelCluster,
      summary: null,
    };

    // Filtros por capas. Se registra por cuál cayó cada uno.
    const post = applyPostFilters(op, run.filters);
    const fin = post.keep ? applyFinancialFilters(op, run.filters) : post;
    const ai = fin.keep ? applyAiFilters(op, run.filters) : fin;
    if (!ai.keep) {
      descartados += 1;
      continue;
    }

    op.summary = await generateOpportunitySummary(op);
    // ORDEN IMPORTANTE: primero el producto, luego su foto. El snapshot tiene
    // clave ajena contra hunter_products; al revés falla la inserción.
    repo.upsertProduct(op, run.id);
    // Primera foto: sin ella, la próxima búsqueda tampoco tendría momentum.
    repo.saveSnapshot(op.id, signals, scores);
    oportunidades.push(op);
  }

  run.progress.candidatesDiscarded = descartados;
  run.progress.opportunities = oportunidades.length;
  run.state = run.progress.sourcesFailed.length > 0 ? "partial" : "complete";
  run.finishedAt = Math.floor(Date.now() / 1000);
  if (run.progress.sourcesFailed.length > 0) {
    run.error = `${run.progress.sourcesQueried - run.progress.sourcesFailed.length}/${run.progress.sourcesTotal} fuentes respondieron.`;
  }
  repo.updateSearchRun(run);
  logIntegrationEvent("hunter", "hunter_search_completed", "info",
    `búsqueda ${run.id}: ${oportunidades.length} oportunidad(es), ${descartados} descartada(s), ${run.providerCalls} llamada(s)`);
  return run;
}
