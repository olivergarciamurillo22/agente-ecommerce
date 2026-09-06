// ============================================================
// AI Winner Radar — ACCESO A DATOS.
//
// Todo el SQL del módulo vive aquí. El resto del código trabaja con los tipos
// de `types.ts` y no sabe que por debajo hay SQLite.
// ============================================================

import { systemDbHandle } from "../db";
import { emptySignals, type HunterAd, type OpportunityStatus, type ProductOpportunity, type ProductSignals, type RadarReport, type SearchRun, type ScoreKey, type ScoreValue } from "./types";
import { initialStages, STAGES, stageDef, type StageKey, type StageState } from "./stages";
import { emptyScoreMap } from "./scoring/opportunity";

function db() {
  return systemDbHandle();
}

const json = (v: unknown): string => JSON.stringify(v ?? null);
function parse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s) as T;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// --- Búsquedas ---

export function createSearchRun(run: SearchRun, createdBy: string | null): void {
  db()
    .prepare(
      `INSERT INTO hunter_searches (id, prompt, filters_json, queries_json, state, progress_json,
         provider_calls, credits_spent, fixture_mode, created_by, started_at,
         title, stage, current_message, estimate_seconds, estimated_finish_at, provider_mode, coverage, plan_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      run.id, run.prompt, json(run.filters), json(run.queries), run.state, json(run.progress),
      run.providerCalls, run.creditsSpent, run.fixtureMode ? 1 : 0, createdBy, run.startedAt,
      run.title, run.stage, run.currentMessage, run.estimateSeconds, run.estimatedFinishAt,
      run.providerMode, run.coverage, json(run.plan)
    );
  // Las seis etapas se siembran ya en 'pending'. Así la pantalla de progreso
  // enseña el recorrido completo desde el primer instante en vez de ir
  // apareciendo etapa a etapa, que se lee como si el sistema improvisara.
  saveStages(run.id, run.stages.length > 0 ? run.stages : initialStages());
}

export function updateSearchRun(run: SearchRun): void {
  db()
    .prepare(
      `UPDATE hunter_searches SET state=?, progress_json=?, queries_json=?, error=?,
         provider_calls=?, credits_spent=?, finished_at=?,
         title=?, stage=?, current_message=?, estimate_seconds=?, estimated_finish_at=?,
         duration_ms=?, provider_mode=?, coverage=?, plan_json=?, report_json=?
       WHERE id=?`
    )
    .run(
      run.state, json(run.progress), json(run.queries), run.error, run.providerCalls, run.creditsSpent,
      run.finishedAt, run.title, run.stage, run.currentMessage, run.estimateSeconds, run.estimatedFinishAt,
      run.durationMs, run.providerMode, run.coverage, json(run.plan), json(run.report), run.id
    );
  if (run.stages.length > 0) saveStages(run.id, run.stages);
}

// --- Etapas ---

export function saveStages(searchId: string, stages: StageState[]): void {
  const stmt = db().prepare(
    `INSERT INTO hunter_search_stages (search_id, stage_key, position, status, summary, counters_json, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(search_id, stage_key) DO UPDATE SET
       status=excluded.status, summary=excluded.summary, counters_json=excluded.counters_json,
       started_at=excluded.started_at, completed_at=excluded.completed_at`
  );
  const tx = db().transaction(() => {
    stages.forEach((st, i) => {
      stmt.run(searchId, st.key, i, st.status, st.summary, json(st.counters), st.startedAt, st.completedAt);
    });
  });
  tx();
}

export function getStages(searchId: string): StageState[] {
  const rows = db()
    .prepare("SELECT * FROM hunter_search_stages WHERE search_id = ? ORDER BY position")
    .all(searchId) as Record<string, unknown>[];
  if (rows.length === 0) return initialStages();
  return rows.map((r) => {
    const def = stageDef(String(r.stage_key) as StageKey);
    return {
      key: def.key,
      label: def.label,
      hint: def.hint,
      status: (r.status as StageState["status"]) ?? "pending",
      startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
      completedAt: r.completed_at === null || r.completed_at === undefined ? null : Number(r.completed_at),
      summary: (r.summary as string) ?? null,
      counters: parse(r.counters_json as string, {} as Record<string, number>),
    };
  });
}

/**
 * Segundos que costó, de media, cada consulta en las búsquedas anteriores
 * que TERMINARON. Es lo que convierte el tiempo estimado en una medición en
 * vez de una corazonada.
 *
 * Se exigen 2 muestras: con una sola, una búsqueda rarísima marcaría el
 * ritmo de todas las siguientes.
 */
export function historicalSecondsPerQuery(): number | null {
  const row = db()
    .prepare(
      `SELECT AVG(CAST(duration_ms AS REAL) / 1000.0 / MAX(json_array_length(queries_json), 1)) AS media,
              COUNT(*) AS n
         FROM (SELECT duration_ms, queries_json FROM hunter_searches
                WHERE duration_ms IS NOT NULL AND duration_ms > 0
                  AND state IN ('complete','partial')
                ORDER BY started_at DESC LIMIT 10)`
    )
    .get() as { media: number | null; n: number } | undefined;
  if (!row || !row.media || row.n < 2) return null;
  const media = Number(row.media);
  return Number.isFinite(media) && media > 0 ? media : null;
}

export function getSearchRun(id: string): SearchRun | null {
  const row = db().prepare("SELECT * FROM hunter_searches WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function listSearchRuns(limit = 25): SearchRun[] {
  const rows = db().prepare("SELECT * FROM hunter_searches ORDER BY started_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

function rowToRun(r: Record<string, unknown>): SearchRun {
  const id = String(r.id);
  return {
    id,
    title: (r.title as string) ?? null,
    prompt: (r.prompt as string) ?? null,
    filters: parse(r.filters_json as string, {} as SearchRun["filters"]),
    queries: parse(r.queries_json as string, [] as string[]),
    state: (r.state as SearchRun["state"]) ?? "queued",
    progress: parse(r.progress_json as string, {
      sourcesQueried: 0, sourcesTotal: 0, sourcesFailed: [], adsAnalyzed: 0,
      productsDetected: 0, candidatesDiscarded: 0, opportunities: 0,
    }),
    startedAt: Number(r.started_at ?? 0),
    finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
    error: (r.error as string) ?? null,
    providerCalls: Number(r.provider_calls ?? 0),
    creditsSpent: r.credits_spent === null || r.credits_spent === undefined ? null : Number(r.credits_spent),
    fixtureMode: Number(r.fixture_mode ?? 0) === 1,
    stages: getStages(id),
    stage: (r.stage as StageKey) ?? null,
    currentMessage: (r.current_message as string) ?? null,
    estimateSeconds: r.estimate_seconds === null || r.estimate_seconds === undefined ? null : Number(r.estimate_seconds),
    estimatedFinishAt: r.estimated_finish_at === null || r.estimated_finish_at === undefined ? null : Number(r.estimated_finish_at),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    providerMode: (r.provider_mode as string) ?? null,
    coverage: (r.coverage as SearchRun["coverage"]) ?? "unknown",
    plan: parse(r.plan_json as string, null as SearchRun["plan"]),
    report: parse(r.report_json as string, null as RadarReport | null),
  };
}

// --- Anuncios ---

export function upsertAds(ads: HunterAd[]): void {
  const stmt = db().prepare(
    `INSERT INTO hunter_ads (id, provider, external_id, platform, advertiser_name, advertiser_external_id,
       product_name_raw, ad_copy, format, countries_json, started_at, last_seen_at, active, active_days,
       landing_url, preview_url, image_url, creative_ids_json, price_amount, price_currency, fingerprint)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(provider, external_id) DO UPDATE SET
       last_seen_at=excluded.last_seen_at, active=excluded.active, active_days=excluded.active_days,
       ad_copy=COALESCE(excluded.ad_copy, hunter_ads.ad_copy),
       landing_url=COALESCE(excluded.landing_url, hunter_ads.landing_url),
       price_amount=COALESCE(excluded.price_amount, hunter_ads.price_amount)`
  );
  const tx = db().transaction((rows: HunterAd[]) => {
    for (const a of rows) {
      stmt.run(
        a.id, a.provider, a.externalId, a.platform, a.advertiserName, a.advertiserExternalId,
        a.productNameRaw, a.adCopy, a.format, json(a.countries), a.startedAt, a.lastSeenAt,
        a.active === null ? null : a.active ? 1 : 0, a.activeDays, a.landingUrl, a.previewUrl,
        a.imageUrl, json(a.creativeExternalIds), a.priceObserved?.amount ?? null,
        a.priceObserved?.currency ?? null, a.fingerprint
      );
    }
  });
  tx(ads);
}

export function getAdsByIds(ids: string[]): HunterAd[] {
  if (ids.length === 0) return [];
  const marcas = ids.map(() => "?").join(",");
  const rows = db().prepare(`SELECT * FROM hunter_ads WHERE id IN (${marcas})`).all(...ids) as Record<string, unknown>[];
  return rows.map(rowToAd);
}

export function getAdsForProduct(productId: string): HunterAd[] {
  const rows = db()
    .prepare(`SELECT a.* FROM hunter_ads a JOIN hunter_product_ads pa ON pa.ad_id = a.id WHERE pa.product_id = ?`)
    .all(productId) as Record<string, unknown>[];
  return rows.map(rowToAd);
}

function rowToAd(r: Record<string, unknown>): HunterAd {
  const amount = r.price_amount === null || r.price_amount === undefined ? null : Number(r.price_amount);
  return {
    id: String(r.id),
    provider: r.provider as HunterAd["provider"],
    externalId: String(r.external_id),
    platform: (r.platform as HunterAd["platform"]) ?? "other",
    advertiserName: (r.advertiser_name as string) ?? null,
    advertiserExternalId: (r.advertiser_external_id as string) ?? null,
    productNameRaw: (r.product_name_raw as string) ?? null,
    adCopy: (r.ad_copy as string) ?? null,
    format: (r.format as HunterAd["format"]) ?? null,
    countries: parse(r.countries_json as string, [] as string[]),
    startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    active: r.active === null || r.active === undefined ? null : Number(r.active) === 1,
    activeDays: r.active_days === null || r.active_days === undefined ? null : Number(r.active_days),
    landingUrl: (r.landing_url as string) ?? null,
    previewUrl: (r.preview_url as string) ?? null,
    imageUrl: (r.image_url as string) ?? null,
    creativeExternalIds: parse(r.creative_ids_json as string, [] as string[]),
    priceObserved: amount !== null ? { amount, currency: (r.price_currency as string) ?? "EUR" } : null,
    fingerprint: String(r.fingerprint),
    raw: null,
  };
}

// --- Productos ---

export function upsertProduct(op: ProductOpportunity, searchId: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  db()
    .prepare(
      `INSERT INTO hunter_products (id, canonical_name, category, description, hero_image_url,
         observed_price_min, observed_price_max, supplier_cost_min, supplier_cost_max, currency,
         first_seen_at, last_seen_at, status, source_confidence, cluster_confidence,
         signals_json, scores_json, features_json, economics_json, summary_json, updated_at,
         primary_provider, images_json, landing_domain)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         canonical_name=CASE WHEN hunter_products.manual_overrides_json IS NULL
                             THEN excluded.canonical_name ELSE hunter_products.canonical_name END,
         observed_price_min=excluded.observed_price_min,
         observed_price_max=excluded.observed_price_max,
         last_seen_at=excluded.last_seen_at,
         source_confidence=excluded.source_confidence,
         cluster_confidence=excluded.cluster_confidence,
         signals_json=excluded.signals_json,
         scores_json=excluded.scores_json,
         features_json=excluded.features_json,
         economics_json=excluded.economics_json,
         summary_json=excluded.summary_json,
         primary_provider=excluded.primary_provider,
         images_json=excluded.images_json,
         landing_domain=excluded.landing_domain,
         updated_at=excluded.updated_at`
    )
    .run(
      op.id, op.canonicalName, op.category, op.description, op.heroImageUrl,
      op.observedPriceMin, op.observedPriceMax, op.supplierCostMin, op.supplierCostMax, op.currency,
      op.firstSeenAt, op.lastSeenAt, op.status, op.sourceConfidence, op.clusterConfidence,
      json(op.signals), json(op.scores), json(op.features), json(op.economics), json(op.summary), now,
      op.primaryProvider, json(op.images), op.landingDomain
    );

  const linkAd = db().prepare(
    "INSERT OR IGNORE INTO hunter_product_ads (product_id, ad_id, cluster_pass, similarity) VALUES (?,?,?,?)"
  );
  const linkSearch = db().prepare(
    "INSERT OR IGNORE INTO hunter_search_products (search_id, product_id) VALUES (?,?)"
  );
  const src = db().prepare(
    "INSERT OR IGNORE INTO hunter_product_sources (product_id, provider, external_ref) VALUES (?,?,?)"
  );
  const tx = db().transaction(() => {
    for (const adId of op.adIds) linkAd.run(op.id, adId, null, null);
    for (const p of op.providers) src.run(op.id, p, "");
    if (searchId) linkSearch.run(searchId, op.id);
  });
  tx();
}

export function getProduct(id: string): ProductOpportunity | null {
  const row = db().prepare("SELECT * FROM hunter_products WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const adIds = (db().prepare("SELECT ad_id FROM hunter_product_ads WHERE product_id = ?").all(id) as { ad_id: string }[]).map((r) => r.ad_id);
  const providers = (db().prepare("SELECT DISTINCT provider FROM hunter_product_sources WHERE product_id = ?").all(id) as { provider: string }[]).map((r) => r.provider);
  return rowToProduct(row, adIds, providers as ProductOpportunity["providers"]);
}

export function listProductsForSearch(searchId: string): ProductOpportunity[] {
  const rows = db()
    .prepare(
      `SELECT p.* FROM hunter_products p
        JOIN hunter_search_products sp ON sp.product_id = p.id
       WHERE sp.search_id = ?`
    )
    .all(searchId) as Record<string, unknown>[];
  return rows.map((r) => rowToProduct(r, [], []));
}

export function listProductsByStatus(status: OpportunityStatus[], limit = 100): ProductOpportunity[] {
  if (status.length === 0) return [];
  const marcas = status.map(() => "?").join(",");
  const rows = db()
    .prepare(`SELECT * FROM hunter_products WHERE status IN (${marcas}) ORDER BY updated_at DESC LIMIT ?`)
    .all(...status, limit) as Record<string, unknown>[];
  return rows.map((r) => rowToProduct(r, [], []));
}

function rowToProduct(r: Record<string, unknown>, adIds: string[], providers: ProductOpportunity["providers"]): ProductOpportunity {
  const num = (k: string): number | null => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  return {
    id: String(r.id),
    canonicalName: String(r.canonical_name),
    category: (r.category as string) ?? null,
    description: (r.description as string) ?? null,
    heroImageUrl: (r.hero_image_url as string) ?? null,
    observedPriceMin: num("observed_price_min"),
    observedPriceMax: num("observed_price_max"),
    supplierCostMin: num("supplier_cost_min"),
    supplierCostMax: num("supplier_cost_max"),
    currency: (r.currency as string) ?? "EUR",
    firstSeenAt: num("first_seen_at"),
    lastSeenAt: num("last_seen_at"),
    status: (r.status as OpportunityStatus) ?? "new",
    sourceConfidence: Number(r.source_confidence ?? 0),
    clusterConfidence: Number(r.cluster_confidence ?? 0),
    signals: parse(r.signals_json as string, emptySignals()),
    scores: parse(r.scores_json as string, emptyScoreMap()) as Record<ScoreKey, ScoreValue>,
    features: parse(r.features_json as string, [] as ProductOpportunity["features"]),
    economics: parse(r.economics_json as string, null as ProductOpportunity["economics"]),
    badges: [],
    adIds,
    providers,
    summary: parse(r.summary_json as string, null as ProductOpportunity["summary"]),
    primaryProvider: (r.primary_provider as ProductOpportunity["primaryProvider"]) ?? null,
    images: parse(r.images_json as string, [] as string[]),
    landingDomain: (r.landing_domain as string) ?? null,
    // Enlace y veredicto NO se guardan: se derivan. Así una búsqueda vieja
    // que se vuelve a abrir se juzga con las reglas de HOY, y cambiar un
    // umbral no obliga a reescribir la tabla entera.
    adLibraryUrl: null,
    recommendation: null,
  };
}

export function setProductStatus(id: string, status: OpportunityStatus): void {
  db().prepare("UPDATE hunter_products SET status=?, updated_at=unixepoch() WHERE id=?").run(status, id);
}

/**
 * Ediciones a mano de Pedro. Se guardan aparte y quedan marcadas para que el
 * siguiente refresco NO las pise: si corrige el nombre o el coste, su valor
 * manda sobre lo que traiga el proveedor.
 */
export function applyManualOverride(id: string, patch: Record<string, unknown>): void {
  const row = db().prepare("SELECT manual_overrides_json FROM hunter_products WHERE id=?").get(id) as { manual_overrides_json: string | null } | undefined;
  const prev = parse(row?.manual_overrides_json ?? null, {} as Record<string, unknown>);
  const next = { ...prev, ...patch };
  const sets: string[] = ["manual_overrides_json=?", "updated_at=unixepoch()"];
  const args: unknown[] = [json(next)];
  if (typeof patch.canonicalName === "string") { sets.unshift("canonical_name=?"); args.unshift(patch.canonicalName); }
  if (typeof patch.category === "string") { sets.unshift("category=?"); args.unshift(patch.category); }
  if (typeof patch.supplierCost === "number") {
    sets.unshift("supplier_cost_min=?", "supplier_cost_max=?");
    args.unshift(patch.supplierCost, patch.supplierCost);
  }
  db().prepare(`UPDATE hunter_products SET ${sets.join(", ")} WHERE id=?`).run(...args, id);
}

// --- Snapshots ---

export function saveSnapshot(productId: string, signals: ProductSignals, scores: unknown): void {
  db()
    .prepare("INSERT INTO hunter_product_snapshots (product_id, signals_json, scores_json) VALUES (?,?,?)")
    .run(productId, json(signals), json(scores));
}

/**
 * Foto más cercana a `daysAgo` días atrás, con tolerancia. Se busca la MÁS
 * RECIENTE dentro de la ventana: comparar con una foto de hace 40 días
 * cuando se pidieron 7 daría un "momentum" que no significa nada.
 */
export function getSnapshotAround(productId: string, daysAgo: number, toleranceDays = 3): ProductSignals | null {
  const target = Math.floor(Date.now() / 1000) - daysAgo * 86400;
  const tol = toleranceDays * 86400;
  const row = db()
    .prepare(
      `SELECT signals_json FROM hunter_product_snapshots
        WHERE product_id = ? AND taken_at BETWEEN ? AND ?
        ORDER BY taken_at DESC LIMIT 1`
    )
    .get(productId, target - tol, target + tol) as { signals_json: string } | undefined;
  return row ? parse(row.signals_json, null as ProductSignals | null) : null;
}

/**
 * Serie completa para el gráfico de actividad (§24). Se devuelve ordenada de
 * más antigua a más nueva: es como se dibuja, y ordenarla en el navegador es
 * un paso más donde equivocarse.
 */
export function listSnapshots(productId: string, limit = 60): Array<{ takenAt: number; signals: ProductSignals }> {
  const rows = db()
    .prepare("SELECT taken_at, signals_json FROM hunter_product_snapshots WHERE product_id = ? ORDER BY taken_at DESC LIMIT ?")
    .all(productId, limit) as Array<{ taken_at: number; signals_json: string }>;
  return rows
    .map((r) => ({ takenAt: Number(r.taken_at), signals: parse(r.signals_json, emptySignals()) }))
    .reverse();
}

export function countSnapshots(productId: string): number {
  const r = db().prepare("SELECT COUNT(*) AS n FROM hunter_product_snapshots WHERE product_id = ?").get(productId) as { n: number };
  return r?.n ?? 0;
}

// --- Registro de llamadas a proveedores ---

export function recordProviderRun(input: {
  searchId: string | null;
  provider: string;
  capability: string | null;
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  calls: number;
  credits: number | null;
  durationMs: number | null;
}): void {
  db()
    .prepare(
      `INSERT INTO hunter_provider_runs (search_id, provider, capability, ok, http_status, error, calls, credits, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(input.searchId, input.provider, input.capability, input.ok ? 1 : 0, input.httpStatus, input.error, input.calls, input.credits, input.durationMs);
}

export interface ProviderUsage {
  provider: string;
  calls: number;
  credits: number | null;
  failures: number;
}

/** Consumo del día, para que el gasto se vea antes de que llegue la factura. */
export function providerUsageToday(): ProviderUsage[] {
  const rows = db()
    .prepare(
      `SELECT provider, SUM(calls) AS calls, SUM(COALESCE(credits,0)) AS credits,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failures
         FROM hunter_provider_runs
        WHERE created_at >= unixepoch('now','start of day')
        GROUP BY provider`
    )
    .all() as Array<{ provider: string; calls: number; credits: number; failures: number }>;
  return rows.map((r) => ({ provider: r.provider, calls: r.calls, credits: r.credits, failures: r.failures }));
}
