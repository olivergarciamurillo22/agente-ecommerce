import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "product-intelligence-test-"));

async function main() {
  const { runResearch, normalizeQuery } = await import("../src/lib/product-intelligence/engine");
  const calls: string[] = [];
  const session = await runResearch({ searchAds: async (query) => { calls.push(query); return query === "almohada cervical" ? [{ id: "a1", advertiserId: "x", advertiserName: "Tienda", copy: "Alivia el dolor cervical", productName: "Almohada ortopédica", startedAt: new Date(Date.now() - 30 * 86400000).toISOString(), active: true, price: 39.9 }] : []; } }, "almohada cervical");
  assert.equal(calls[0], "almohada cervical", "la primera llamada debe conservar exactamente la query del usuario");
  assert.ok(calls.indexOf("Almohada ortopédica") > 0, "la expansión solo sucede después");
  assert.equal(normalizeQuery(" JUANETES "), normalizeQuery("juanetes"));
  assert.equal(session.products.length, 1);
  assert.equal(session.queries[0].rootQueryId, session.queries[0].id);
  const { MetaAdLibraryProvider, normalizeMetaAd } = await import("../src/lib/product-intelligence/providers/meta-ad-library-provider");
  assert.equal(new MetaAdLibraryProvider().status().available, false, "Meta queda deshabilitado sin credenciales");
  const normalized = normalizeMetaAd({ id: "meta-1", page_id: "page-1", page_name: "Tienda", ad_delivery_start_time: "2026-08-01", ad_creative_bodies: ["Texto real"], access_token: "nunca-guardar" });
  assert.equal(normalized?.copy, "Texto real");
  assert.equal("access_token" in (normalized?.rawProviderPayload ?? {}), false, "el raw payload elimina secretos");

  const previousFetch = global.fetch;
  process.env.META_AD_LIBRARY_ACCESS_TOKEN = "token-solo-test";
  process.env.META_GRAPH_API_VERSION = "v-test";
  const requestedTerms: string[] = [];
  let page = 0;
  global.fetch = async (input) => {
    const url = new URL(String(input)); requestedTerms.push(url.searchParams.get("search_terms") ?? ""); page++;
    return Response.json({ data: [{ id: `real-${page}`, page_id: "p", page_name: "Tienda", ad_delivery_start_time: "2026-08-01", ad_creative_bodies: ["Ad"] }], paging: page === 1 ? { next: "present", cursors: { after: "cursor-2" } } : {} });
  };
  try {
    const provider = new MetaAdLibraryProvider();
    const ads = await provider.searchAds("almohada cervical");
    assert.deepEqual(requestedTerms, ["almohada cervical", "almohada cervical"], "query exacta conservada en todas las páginas");
    assert.equal(ads.length, 2, "consume paginación real");
  } finally { global.fetch = previousFetch; delete process.env.META_AD_LIBRARY_ACCESS_TOKEN; delete process.env.META_GRAPH_API_VERSION; }
  process.env.META_AD_LIBRARY_ACCESS_TOKEN = "test-only"; process.env.META_GRAPH_API_VERSION = "v-test";
  global.fetch = async () => new Response(JSON.stringify({ error: { code: 10, message: "Application does not have permission for this action" } }), { status: 400, headers: { "content-type": "application/json" } });
  try { const health = await new MetaAdLibraryProvider().healthCheck(); assert.equal(health.code, "META_CONFIGURED_UNAUTHORIZED"); assert.equal(health.reason, "Meta Ad Library authorization pending"); }
  finally { global.fetch = previousFetch; delete process.env.META_AD_LIBRARY_ACCESS_TOKEN; delete process.env.META_GRAPH_API_VERSION; }
  const { clusterSimilarity, advertiserKey } = await import("../src/lib/product-intelligence/clustering");
  assert.equal(clusterSimilarity("Corrector de Juanetes", "Corrector Hallux Valgus").confidence, "HIGH");
  assert.equal(advertiserKey({ id: "x", advertiserId: "a", pageId: "p1", advertiserName: "Tienda", copy: "", startedAt: "2026-01-01", active: true }), "page:p1");
  const { calculateQueryScore } = await import("../src/lib/product-intelligence/engine");
  assert.ok(calculateQueryScore({ newProducts: 3, newAdvertisers: 2, averageOpportunity: 80, duplicateRate: 0 }) > calculateQueryScore({ newProducts: 0, newAdvertisers: 0, averageOpportunity: 30, duplicateRate: 0.95, emptyRuns: 2 }));
  const { diffObservations } = await import("../src/lib/product-intelligence/diff-engine");
  const snapshot = { id: "s", productId: "p", capturedAt: "2026-09-01", activeAds: 1, advertisers: 1, medianAdAge: 10, oldestAd: 10, newAds7d: 1, newAds14d: 1, creativeVelocity: 20, opportunityScore: 50, momentum: 40, lifecycle: "EMERGING" as const };
  const diffs = diffObservations({ productId: "p", adIds: ["old"], advertiserIds: ["a"], snapshot }, { productId: "p", adIds: ["new"], advertiserIds: ["a", "b"], snapshot: { ...snapshot, id: "s2", newAds7d: 5, opportunityScore: 65, lifecycle: "SCALING" } });
  assert.ok(diffs.some((item) => item.type === "NEW_AD") && diffs.some((item) => item.type === "REMOVED_AD") && diffs.some((item) => item.type === "LIFECYCLE_CHANGE"));
  assert.equal(diffObservations({ productId: "p", adIds: ["new"], advertiserIds: ["a", "b"], snapshot: { ...snapshot, lifecycle: "SCALING" } }, { productId: "p", adIds: ["new"], advertiserIds: ["a", "b"], snapshot: { ...snapshot, lifecycle: "SCALING" } }).length, 0, "signals idempotentes sin cambios");
  const { opportunityScore, scoreBreakdown, classifyLifecycle } = await import("../src/lib/product-intelligence/scoring");
  for (let index = 0; index < 500; index++) { const random = () => Math.random() * 180 - 40; const input = { metaValidation: random(), longevity: random(), creativeVelocity: random(), momentum: random(), pain: random(), creativePotential: random(), casamableFit: random(), economics: random(), saturation: random(), logistics: random(), penalties: random() }; const score = opportunityScore(input); assert.ok(Number.isFinite(score) && score >= 0 && score <= 100); assert.equal(scoreBreakdown(input).total, score); }
  const baseScore = { metaValidation: 50, longevity: 50, creativeVelocity: 50, momentum: 50, pain: 50, creativePotential: 50, casamableFit: 50, economics: 50, saturation: 50, logistics: 50 };
  assert.equal(classifyLifecycle({ ...baseScore, momentum: 60 }, 3), "EMERGING");
  assert.equal(classifyLifecycle({ ...baseScore, momentum: 80, creativeVelocity: 70 }, 5), "SCALING");
  assert.equal(classifyLifecycle({ ...baseScore, longevity: 80, metaValidation: 80 }, 5), "VALIDATED");
  assert.equal(classifyLifecycle({ ...baseScore, saturation: 90 }, 20), "SATURATING");
  assert.equal(classifyLifecycle({ ...baseScore, momentum: 10, creativeVelocity: 10 }, 5), "DECLINING");
  const { productIntelligenceEnabled } = await import("../src/lib/product-intelligence/config");
  process.env.PRODUCT_INTELLIGENCE_ENABLED = "false"; let disabledCalls = 0; assert.equal(productIntelligenceEnabled(), false); await assert.rejects(() => runResearch({ searchAds: async () => { disabledCalls++; return []; } }, "off")); assert.equal(disabledCalls, 0); delete process.env.PRODUCT_INTELLIGENCE_ENABLED;
  const formerData = process.env.DATA_DIR; const recoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recovery-")); process.env.DATA_DIR = recoveryDir;
  const repositoryFile = path.join(recoveryDir, "product-intelligence.json"); fs.writeFileSync(repositoryFile, "{broken");
  const { listSessions } = await import("../src/lib/product-intelligence/repository"); assert.deepEqual(listSessions(), []); assert.ok(fs.readdirSync(recoveryDir).some((name) => name.startsWith("product-intelligence.corrupt.")));
  process.env.DATA_DIR = formerData;
  const noStart = normalizeMetaAd({ id: "missing-date", page_id: "p" }); assert.equal(noStart, null, "missing start date remains unknown and is not invented");
  process.env.META_AD_LIBRARY_ACCESS_TOKEN = "test-only"; process.env.META_GRAPH_API_VERSION = "v-test";
  for (const scenario of [{ status: 401, payload: { error: { code: 190, message: "Invalid OAuth access token" } }, expected: "META_ERROR" }, { status: 403, payload: { error: { code: 10, message: "Application does not have permission for this action" } }, expected: "META_CONFIGURED_UNAUTHORIZED" }, { status: 429, payload: { error: { code: 4, message: "rate limit" } }, expected: "META_RATE_LIMITED" }, { status: 500, payload: { error: { code: 1, message: "server" } }, expected: "META_ERROR" }]) { global.fetch = async () => new Response(JSON.stringify(scenario.payload), { status: scenario.status }); const health = await new MetaAdLibraryProvider({ maxRetries: 0 }).healthCheck(); assert.equal(health.code, scenario.expected); }
  global.fetch = async () => { throw new DOMException("timeout", "AbortError"); }; assert.equal((await new MetaAdLibraryProvider({ maxRetries: 0 }).healthCheck()).code, "META_ERROR");
  global.fetch = previousFetch; delete process.env.META_AD_LIBRARY_ACCESS_TOKEN; delete process.env.META_GRAPH_API_VERSION;
  const { redactProductIntelligence } = await import("../src/lib/product-intelligence/redaction"); assert.ok(!redactProductIntelligence("Authorization: Bearer secret-value access_token=abc app_secret=xyz").includes("secret-value"));
  const recoveryCalls: string[] = []; const recovered = { id: "recover", mode: "MANUAL_SEED" as const, userQuery: "A", rootQuery: "A", status: "PAUSED" as const, startedAt: new Date().toISOString(), queriesProcessed: 1, productsFound: 0, queries: [{ id: "qa", displayQuery: "A", normalizedQuery: "a", rootQueryId: "qa", depth: 0, source: "USER", priority: 100, status: "COMPLETED" as const, resultsCount: 0, queryScore: 0 }, { id: "qb", displayQuery: "B", normalizedQuery: "b", rootQueryId: "qa", parentQueryId: "qa", depth: 1, source: "PRODUCT_NAME", priority: 80, status: "PENDING" as const, resultsCount: 0, queryScore: 0 }], products: [] };
  await runResearch({ searchAds: async (term) => { recoveryCalls.push(term); return []; } }, "A", recovered); assert.deepEqual(recoveryCalls, ["B"], "resume skips processed queries and continues pending queue");
  const loopCalls: string[] = []; await runResearch({ searchAds: async (term) => { loopCalls.push(term); const next = term === "A" ? "B" : term === "B" ? "C" : "A"; return [{ id: term, advertiserId: term, advertiserName: term, copy: term, productName: next, startedAt: "2026-08-01", active: true }]; } }, "A"); assert.deepEqual(loopCalls, ["A", "B", "C"], "normalized graph stops A→B→C→A loop");
  const explosion = await runResearch({ searchAds: async () => Array.from({ length: 1000 }, (_, index) => ({ id: `e${index}`, advertiserId: `a${index}`, advertiserName: "A", copy: "x", productName: `derived ${index}`, startedAt: "2026-08-01", active: true })) }, "root"); assert.ok(explosion.queries.length <= 31, "children are bounded per query and depth");
  console.log("36 tests de Product Intelligence OK");
}

main().catch((error) => { console.error(error); process.exit(1); });
