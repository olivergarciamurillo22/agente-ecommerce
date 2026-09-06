// ============================================================
// AI Winner Radar — ORQUESTADOR DE UNA BÚSQUEDA, POR ETAPAS.
//
// Interpretar → explorar Meta → agrupar → leer creatividades → puntuar →
// seleccionar. Seis etapas con nombre, cada una escribiendo su progreso.
//
// CUATRO COSAS QUE GOBIERNAN ESTE FICHERO:
//
// 1. TOLERANCIA A FALLOS. Si una consulta o una fuente se cae, la búsqueda
//    termina en PARTIAL con lo que hay. Abortar entera por un 429 sería tirar
//    resultados buenos y llamadas ya gastadas.
// 2. PRESUPUESTO. Todo pasa por un CallBudget compartido: una búsqueda no
//    puede vaciar la cuota por un bucle mal escrito.
// 3. NADA DE CINCO MINUTOS EN UN REQUEST. Esto corre en segundo plano y va
//    escribiendo su estado; la interfaz lo consulta y Pedro puede irse.
// 4. LA IA SOLO SOBRE LA SHORTLIST (§30). Analizar 2.000 anuncios uno a uno
//    costaría una fortuna y no cambiaría ninguna decisión. Primero reglas y
//    agrupación —que son gratis—, y el modelo solo sobre lo que ha
//    sobrevivido.
// ============================================================

import { randomUUID } from "node:crypto";
import { logIntegrationEvent } from "../../system/repo";
import { CallBudget } from "../http";
import { clusterAds } from "../cluster";
import { computeOpportunityEconomics } from "../economics";
import { analyzeCreatives, classifyProduct, generateOpportunitySummary, interpretSearchIntent, parseIntentDeterministic } from "../intelligence";
import { adLibrarySearchUrl, normalizeDomain } from "../links";
import { getCategoryPerformance, getInternalRates } from "../providers/internal";
import { lookupSupplierCost } from "../providers/supplier";
import { fixtureModeActive, providerMode, searchProviders } from "../providers/registry";
import { buildReport } from "../report";
import { computeSignals, dedupeAds, observedPriceRange, seenRange } from "../signals";
import { scoreCreativeInvestment, scoreMarket, scoreMomentum, scoreSaturation } from "../scoring/market";
import { scoreCasamable, scoreProduct } from "../scoring/product";
import { emptyScore, scoreOpportunity } from "../scoring/opportunity";
import { estimateDuration, initialStages, stageProgress, type StageKey, type StageState } from "../stages";
import { decideVerdict } from "../verdict";
import type { HunterAd, HunterFilters, ProductOpportunity, ProviderId, ScoreKey, ScoreValue, SearchRun } from "../types";
import { applyAiFilters, applyFinancialFilters, applyPostFilters, defaultFilters } from "./filters";
import { buildSearchPlan, type SearchPlan } from "./planner";
import * as repo from "../repo";

/** Tope de llamadas por búsqueda. Es cuota y es tiempo: se elige explícitamente. */
export const DEFAULT_CALL_BUDGET = 40;
/** Tope de productos analizados con IA: cada uno son dos llamadas al modelo. */
export const MAX_AI_ANALYSIS = 12;
/** Imágenes guardadas por producto para la ficha. */
const MAX_IMAGES = 6;

export interface StartSearchInput {
  prompt: string | null;
  /** true = solo vista previa: ni estrategia con IA ni interpretación cara. */
  preview?: boolean;
  filters?: Partial<HunterFilters>;
  maxQueries?: number;
  callBudget?: number;
  createdBy?: string | null;
}

/**
 * Duración estimada de un plan, con su etiqueta honesta. Se expone aparte
 * porque la vista previa la necesita antes de que exista una búsqueda.
 */
export function estimateFor(plan: SearchPlan) {
  return estimateDuration({
    queries: plan.queries.length,
    providers: searchProviders().length || 1,
    aiBudget: MAX_AI_ANALYSIS,
    historicalSecondsPerQuery: safeHistorical(),
  });
}

export function newSearchRun(input: StartSearchInput, plan: SearchPlan): SearchRun {
  const eta = estimateFor(plan);
  const ahora = Math.floor(Date.now() / 1000);

  return {
    id: `hs_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    title: titleFor(plan.filters),
    prompt: input.prompt,
    filters: plan.filters,
    queries: plan.queries,
    state: "queued",
    progress: {
      sourcesQueried: 0, sourcesTotal: 0, sourcesFailed: [], adsAnalyzed: 0,
      productsDetected: 0, candidatesDiscarded: 0, opportunities: 0,
    },
    startedAt: ahora,
    finishedAt: null,
    error: null,
    providerCalls: 0,
    creditsSpent: null,
    fixtureMode: fixtureModeActive(),
    stages: initialStages(),
    stage: null,
    currentMessage: null,
    estimateSeconds: eta.seconds,
    estimatedFinishAt: ahora + eta.seconds,
    durationMs: null,
    providerMode: providerMode(),
    coverage: "unknown",
    plan: { sentence: plan.sentence, strategy: plan.strategy, aiUsed: plan.aiUsed },
    report: null,
  };
}

/**
 * El histórico vive en la base. Si la base no está lista (arranque, tests que
 * no la montan), la estimación cae a la heurística en vez de reventar.
 */
function safeHistorical(): number | null {
  try {
    return repo.historicalSecondsPerQuery();
  } catch {
    return null;
  }
}

const CATEGORIA_TITULO: Record<string, string> = {
  hogar: "Hogar", mascotas: "Mascotas", coche: "Coche", cocina: "Cocina",
  belleza: "Belleza", jardin: "Jardín", bebe: "Bebé", deporte: "Deporte", salud: "Salud",
};

/** «Mascotas · España». Es lo que se ve en el historial: tiene que decir algo. */
export function titleFor(f: HunterFilters): string {
  const que = f.categories.length > 0
    ? f.categories.map((c) => CATEGORIA_TITULO[c] ?? capitalizar(c)).join(" y ")
    : f.keywords.length > 0
      ? f.keywords.slice(0, 2).map(capitalizar).join(" · ")
      : "Búsqueda general";
  return `${que} · ${f.country}`;
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Prepara la búsqueda (interpreta, planifica) sin salir a la red todavía. */
export async function planSearch(input: StartSearchInput): Promise<{ run: SearchRun; plan: SearchPlan }> {
  let filters: HunterFilters = { ...defaultFilters(), ...(input.filters ?? {}) };
  let sugeridas: string[] = [];
  let notas: string[] = [];

  if (input.prompt && input.prompt.trim()) {
    // En vista previa se usa SOLO el analizador determinista: es instantáneo,
    // no cuesta nada y cubre lo que Pedro escribe de verdad. La lectura fina
    // del modelo se hace una vez, al lanzar la búsqueda.
    const intent = input.preview
      ? parseIntentDeterministic(input.prompt)
      : await interpretSearchIntent(input.prompt);
    // Lo que Pedro fijó a mano MANDA sobre lo que interprete la IA.
    filters = { ...intent.filters, ...(input.filters ?? {}) };
    sugeridas = intent.suggestedQueries;
    notas = intent.notes;
  }

  const plan = await buildSearchPlan(filters, {
    prompt: input.prompt,
    aiSuggestions: sugeridas,
    maxQueries: input.maxQueries,
    notes: notas,
    skipStrategy: input.preview === true,
  });
  return { run: newSearchRun(input, plan), plan };
}

// ------------------------------------------------------------
// Utilidades de etapa
// ------------------------------------------------------------

function marcar(
  run: SearchRun,
  key: StageKey,
  status: StageState["status"],
  opts: { summary?: string | null; counters?: Record<string, number>; message?: string | null } = {}
): void {
  const ahora = Math.floor(Date.now() / 1000);
  const st = run.stages.find((s) => s.key === key);
  if (!st) return;
  if (status === "active" && st.startedAt === null) st.startedAt = ahora;
  if (status === "complete" || status === "failed" || status === "skipped") st.completedAt = ahora;
  st.status = status;
  if (opts.summary !== undefined) st.summary = opts.summary;
  if (opts.counters) st.counters = { ...st.counters, ...opts.counters };
  run.stage = status === "active" ? key : run.stage;
  if (opts.message !== undefined) run.currentMessage = opts.message;
  refrescarEta(run);
}

/**
 * Recalcula el final estimado con el ritmo REAL. Una cuenta atrás que se
 * queda clavada en «quedan 10 s» durante dos minutos destruye la confianza en
 * todo lo demás de la pantalla, así que si va lento, el número sube.
 */
function refrescarEta(run: SearchRun): void {
  if (run.estimateSeconds === null) return;
  const ahora = Math.floor(Date.now() / 1000);
  const avance = stageProgress(run.stages);
  if (avance <= 0.02) return;
  const transcurrido = Math.max(1, ahora - run.startedAt);
  const proyectado = transcurrido / avance;
  const mezcla = proyectado * 0.65 + run.estimateSeconds * 0.35;
  run.estimatedFinishAt = run.startedAt + Math.round(mezcla);
}

function guardar(run: SearchRun): void {
  try {
    repo.updateSearchRun(run);
  } catch {
    // Escribir el progreso NUNCA puede tumbar la búsqueda: si la base falla
    // aquí, se pierde la barra, no los resultados.
  }
}

function miles(n: number): string {
  return new Intl.NumberFormat("es-ES").format(n);
}

// ------------------------------------------------------------
// Ejecución
// ------------------------------------------------------------

export async function executeSearch(run: SearchRun): Promise<SearchRun> {
  const t0 = Date.now();
  const budget = new CallBudget(DEFAULT_CALL_BUDGET);
  const proveedores = searchProviders({ budget });

  run.state = "running";
  run.progress.sourcesTotal = proveedores.length;
  marcar(run, "interpret", "complete", {
    summary: `${run.queries.length} consulta${run.queries.length === 1 ? "" : "s"} preparada${run.queries.length === 1 ? "" : "s"}`,
    counters: { queries: run.queries.length },
    message: "Criterios listos",
  });
  guardar(run);

  logIntegrationEvent("hunter", "hunter_search_started", "info",
    `búsqueda ${run.id}: ${run.queries.length} consulta(s) sobre ${proveedores.length} fuente(s)`);

  if (proveedores.length === 0) {
    return terminar(run, t0, "failed", "No hay ninguna fuente de anuncios configurada.");
  }

  // ── 1 · Explorar Meta ────────────────────────────────────────
  marcar(run, "explore", "active", { message: "Abriendo la Biblioteca de Anuncios…" });
  guardar(run);

  const recogidos: HunterAd[] = [];
  const paginas = { hechas: 0 };
  let creditos = 0;
  let consultasHechas = 0;

  for (const p of proveedores) {
    if (!p.searchAds) continue;
    let fallo: string | null = null;

    for (const q of run.queries) {
      if (!budget.canAfford(1)) break;
      const tq = Date.now();
      const res = await p.searchAds({
        keywords: q,
        country: run.filters.country,
        activeOnly: true,
        minDaysActive: run.filters.minDaysActive ?? undefined,
        limit: 50,
      });
      consultasHechas += 1;
      run.providerCalls += res.calls;
      paginas.hechas += res.calls;
      if (res.credits) creditos += res.credits;

      repo.recordProviderRun({
        searchId: run.id, provider: p.id, capability: "META_ADS", ok: res.ok,
        httpStatus: res.status, error: res.error, calls: res.calls,
        credits: res.credits, durationMs: Date.now() - tq,
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

      const anunciantes = new Set(recogidos.map((a) => a.advertiserName).filter(Boolean)).size;
      marcar(run, "explore", "active", {
        counters: { queriesDone: consultasHechas, adsFound: recogidos.length, advertisers: anunciantes, pages: paginas.hechas },
        message: `${miles(recogidos.length)} anuncios revisados · ${miles(anunciantes)} páginas detectadas`,
      });
      guardar(run);
    }

    run.progress.sourcesQueried += 1;
    if (fallo) run.progress.sourcesFailed.push(p.id);
  }

  run.creditsSpent = creditos > 0 ? creditos : null;
  const parcial = run.progress.sourcesFailed.length > 0;
  marcar(run, "explore", parcial && recogidos.length === 0 ? "failed" : "complete", {
    summary: `${miles(recogidos.length)} anuncios de ${miles(new Set(recogidos.map((a) => a.advertiserName).filter(Boolean)).size)} páginas`,
    message: null,
  });
  guardar(run);

  // ── 2 · Agrupar en productos ─────────────────────────────────
  marcar(run, "cluster", "active", { message: "Reuniendo los anuncios que venden lo mismo…" });
  guardar(run);

  const { ads, removed } = dedupeAds(recogidos);
  run.progress.adsAnalyzed = ads.length;

  if (ads.length === 0) {
    marcar(run, "cluster", "complete", { summary: "Sin anuncios que agrupar" });
    for (const k of ["creative", "score", "select"] as StageKey[]) {
      marcar(run, k, "skipped", { summary: "Sin datos que procesar" });
    }
    // La cobertura se fija ANTES de redactar. Si no, el informe se escribe
    // creyendo que todo fue bien y la pantalla acaba diciendo «prueba con
    // otras palabras» cuando lo que ha pasado es que la fuente no respondió.
    // Pedro perdió el tiempo buscando sinónimos por esto.
    run.coverage = parcial ? "partial" : "full";
    run.report = await buildReport(run, []);
    return terminar(run, t0, parcial ? "partial" : "complete",
      parcial ? `Sin resultados; fallaron: ${run.progress.sourcesFailed.join(", ")}` : null);
  }

  repo.upsertAds(ads);
  const clusters = clusterAds(ads);
  run.progress.productsDetected = clusters.length;
  marcar(run, "cluster", "complete", {
    summary: `${clusters.length} producto${clusters.length === 1 ? "" : "s"} distintos`,
    counters: { clusters: clusters.length, duplicatesRemoved: removed },
  });
  guardar(run);
  logIntegrationEvent("hunter", "hunter_cluster_created", "info",
    `${ads.length} anuncios (${removed} duplicados fuera) → ${clusters.length} producto(s)`);

  // ── 3 · Leer creatividades (solo la shortlist) ───────────────
  const porId = new Map(ads.map((a) => [a.id, a]));
  // Los clusters grandes primero: son los que más probablemente importan, y
  // así el presupuesto de IA se gasta donde puede cambiar una decisión.
  const ordenados = [...clusters].sort((a, b) => b.adIds.length - a.adIds.length);
  const shortlist = ordenados.slice(0, MAX_AI_ANALYSIS);

  marcar(run, "creative", "active", { message: `Leyendo los anuncios de ${shortlist.length} productos…` });
  guardar(run);

  const features = new Map<string, Awaited<ReturnType<typeof classifyProduct>>>();
  const creatives = new Map<string, Awaited<ReturnType<typeof analyzeCreatives>>>();
  let analizados = 0;

  for (const cl of shortlist) {
    const suyos = cl.adIds.map((id) => porId.get(id)).filter((a): a is HunterAd => !!a);
    const copies = suyos.map((a) => a.adCopy).filter((c): c is string => !!c);
    features.set(cl.id, await classifyProduct({ name: cl.canonicalName, adCopySamples: copies, category: null }));
    creatives.set(cl.id, await analyzeCreatives({ productName: cl.canonicalName, adCopies: copies }));
    analizados += 1;
    marcar(run, "creative", "active", {
      counters: { analyzed: analizados, shortlist: shortlist.length },
      message: `${analizados} de ${shortlist.length} analizados`,
    });
    guardar(run);
  }

  marcar(run, "creative", "complete", {
    summary: `${analizados} producto${analizados === 1 ? "" : "s"} analizados a fondo`,
    message: null,
  });
  guardar(run);

  // ── 4 · Puntuar ──────────────────────────────────────────────
  marcar(run, "score", "active", { message: "Cruzando mercado, producto y tus números…" });
  guardar(run);

  const rates = getInternalRates();
  const perf = getCategoryPerformance(null);
  const oportunidades: ProductOpportunity[] = [];
  let descartados = 0;

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
    const feats = features.get(cl.id) ?? [];

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

    const product = scoreProduct(feats);
    const casamable = scoreCasamable({
      economics,
      historicalDeliveryRate: perf.deliveryRate.value,
      historicalRefusalRate: perf.refusalRate.value,
      historicalCancellationRate: perf.cancellationRate.value,
      supplierAvailable: supplier.available,
      supplierLeadTimeDays: supplier.leadTimeDays,
      codSuitability: null,
      shippingComplexity: feats.find((f) => f.key === "complexity")?.value ?? null,
    });

    const proveedoresDelCluster = [...new Set(suyos.map((a) => a.provider))];
    const { score: opportunity, badges } = scoreOpportunity({
      market, product, casamable, saturation, momentum, features: feats, economics,
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
      category: run.filters.categories[0] ?? null,
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
      features: feats,
      economics,
      badges,
      adIds: suyos.map((a) => a.id),
      providers: proveedoresDelCluster,
      summary: null,
      primaryProvider: dominante(proveedoresDelCluster, suyos),
      images: imagenesDe(suyos),
      landingDomain: dominioDominante(suyos),
      adLibraryUrl: adLibrarySearchUrl(cl.canonicalName, run.filters.country),
      recommendation: null,
    };

    // Filtros por capas. Se registra por cuál cayó cada uno.
    const post = applyPostFilters(op, run.filters);
    const fin = post.keep ? applyFinancialFilters(op, run.filters) : post;
    const ai = fin.keep ? applyAiFilters(op, run.filters) : fin;
    if (!ai.keep) {
      descartados += 1;
      continue;
    }

    op.recommendation = decideVerdict(op).recommendation;
    oportunidades.push(op);
  }

  run.progress.candidatesDiscarded = descartados;
  run.progress.opportunities = oportunidades.length;
  marcar(run, "score", "complete", {
    summary: `${oportunidades.length} pasaron tus filtros, ${descartados} no`,
    counters: { kept: oportunidades.length, discarded: descartados },
    message: null,
  });
  guardar(run);

  // ── 5 · Seleccionar, resumir y persistir ────────────────────
  marcar(run, "select", "active", { message: "Preparando tu selección…" });
  guardar(run);

  // Solo se redacta el resumen de los que van a verse arriba: escribir 38
  // resúmenes de los que 30 nadie abrirá es pagar por texto que no se lee.
  const porScore = [...oportunidades].sort((a, b) => (b.scores.opportunity.score ?? -1) - (a.scores.opportunity.score ?? -1));
  const conResumen = new Set(porScore.slice(0, MAX_AI_ANALYSIS).map((o) => o.id));

  for (const op of oportunidades) {
    if (conResumen.has(op.id)) op.summary = await generateOpportunitySummary(op);
    const cr = creatives.get(`hc_${op.id.slice(3)}`);
    if (cr && cr.hooks.length > 0 && op.description === null) op.description = cr.hooks[0];
    // ORDEN IMPORTANTE: primero el producto, luego su foto. El snapshot tiene
    // clave ajena contra hunter_products; al revés falla la inserción.
    repo.upsertProduct(op, run.id);
    repo.saveSnapshot(op.id, op.signals, op.scores);
  }

  run.coverage = parcial ? "partial" : "full";
  run.report = await buildReport(run, oportunidades);
  marcar(run, "select", "complete", {
    summary: run.report.headline,
    counters: { topPicks: run.report.topPickIds.length, watch: run.report.watchIds.length },
    message: null,
  });

  logIntegrationEvent("hunter", "hunter_search_completed", "info",
    `búsqueda ${run.id}: ${oportunidades.length} oportunidad(es), ${descartados} descartada(s), ${run.providerCalls} llamada(s)`);

  return terminar(run, t0, parcial ? "partial" : "complete",
    parcial ? `${run.progress.sourcesQueried - run.progress.sourcesFailed.length}/${run.progress.sourcesTotal} fuentes respondieron.` : null);
}

function terminar(run: SearchRun, t0: number, state: SearchRun["state"], error: string | null): SearchRun {
  run.state = state;
  run.error = error;
  run.finishedAt = Math.floor(Date.now() / 1000);
  run.durationMs = Date.now() - t0;
  run.currentMessage = null;
  run.stage = null;
  run.coverage = state === "failed" ? "none" : state === "partial" ? "partial" : "full";
  // Toda etapa que se quedó a medias se cierra: dejar una «activa» para
  // siempre haría que la interfaz enseñara una búsqueda terminada con una
  // ruedecita girando.
  for (const st of run.stages) {
    if (st.status === "active") st.status = state === "failed" ? "failed" : "complete";
    else if (st.status === "pending" && state !== "queued") st.status = "skipped";
  }
  guardar(run);
  return run;
}

/** Proveedor que aportó más anuncios: el que sostiene la evidencia. */
function dominante(providers: ProviderId[], ads: HunterAd[]): ProviderId | null {
  if (providers.length === 0) return null;
  if (providers.length === 1) return providers[0];
  const cuenta = new Map<ProviderId, number>();
  for (const a of ads) cuenta.set(a.provider, (cuenta.get(a.provider) ?? 0) + 1);
  return [...cuenta.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

/** Imágenes o previsualizaciones únicas, para ilustrar la ficha. */
function imagenesDe(ads: HunterAd[]): string[] {
  const out = new Set<string>();
  for (const a of ads) {
    if (a.imageUrl) out.add(a.imageUrl);
    if (out.size >= MAX_IMAGES) break;
  }
  return [...out];
}

/** Dominio de landing más repetido: dice a qué tienda llevan los anuncios. */
function dominioDominante(ads: HunterAd[]): string | null {
  const cuenta = new Map<string, number>();
  for (const a of ads) {
    const d = a.landingUrl ? normalizeDomain(a.landingUrl) : null;
    if (d) cuenta.set(d, (cuenta.get(d) ?? 0) + 1);
  }
  if (cuenta.size === 0) return null;
  return [...cuenta.entries()].sort((x, y) => y[1] - x[1])[0][0];
}
