import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hunter-e2e-test-"));
process.env.PRODUCT_INTELLIGENCE_ENABLED = "true";

let passed = 0;
const test = async (name: string, run: () => void | Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const ad = (overrides: Record<string, unknown> = {}) => ({ id: "ad-1", advertiserId: "page-1", pageId: "page-1", advertiserName: "Tienda Uno", copy: "Corrector para aliviar dolor", productName: "Corrector de juanetes", startedAt: "2026-08-01", active: true, provider: "TEST_FIXTURE" as const, ...overrides });

async function main() {
  const { runResearch, analyzeAds } = await import("../src/lib/product-intelligence/engine");
  await test("root query exacta antes de expandir", async () => {
    const calls: string[] = [];
    await runResearch({ searchAds: async (query) => { calls.push(query); return query === "juanetes" ? [ad()] : []; } }, "juanetes");
    assert.equal(calls[0], "juanetes"); assert.ok(calls.indexOf("hallux valgus") > 0);
  });

  const { MetaAdLibraryProvider, normalizeMetaAd } = await import("../src/lib/product-intelligence/providers/meta-ad-library-provider");
  process.env.META_AD_LIBRARY_ACCESS_TOKEN = "test"; process.env.META_GRAPH_API_VERSION = "v-test";
  await test("paginación Meta usa cursor y deduplica", async () => {
    const after: Array<string | null> = []; let page = 0;
    const fetcher: typeof fetch = async (input) => { const url = new URL(String(input)); after.push(url.searchParams.get("after")); page++; return Response.json({ data: [{ id: page === 1 ? "a" : "b", page_id: "p", page_name: "T", ad_delivery_start_time: "2026-08-01" }, { id: "a", page_id: "p", page_name: "T", ad_delivery_start_time: "2026-08-01" }], paging: page === 1 ? { next: "yes", cursors: { after: "cursor-2" } } : {} }); };
    const ads = await new MetaAdLibraryProvider({ maxPages: 2 }, fetcher).searchAds("juanetes");
    assert.deepEqual(after, [null, "cursor-2"]); assert.equal(ads.length, 2);
  });
  await test("Meta cero resultados", async () => { assert.deepEqual(await new MetaAdLibraryProvider({ maxRetries: 0 }, async () => Response.json({ data: [] })).searchAds("nada"), []); });
  await test("Meta 429 queda aislado", async () => { const health = await new MetaAdLibraryProvider({ maxRetries: 0 }, async () => new Response(JSON.stringify({ error: { code: 4, message: "rate limit" } }), { status: 429 })).healthCheck(); assert.equal(health.code, "META_RATE_LIMITED"); });
  await test("campos Meta ausentes no se inventan", () => { assert.equal(normalizeMetaAd({ id: "x" }), null); const normalized = normalizeMetaAd({ id: "x", page_id: "p", ad_delivery_start_time: "2026-08-01" }); assert.equal(normalized?.title, undefined); });

  await test("múltiples creatividades del mismo anunciante se agrupan", () => { assert.equal(analyzeAds([ad(), ad({ id: "ad-2", productName: "Corrector de juanetes" })]).length, 1); });
  await test("clustering conservador separa productos distintos", () => { assert.equal(analyzeAds([ad(), ad({ id: "ad-2", productName: "Plantilla ortopédica" })]).length, 2); });

  const { calculateMomentum } = await import("../src/lib/product-intelligence/momentum");
  await test("primer snapshot es SIN_HISTORICO", () => { assert.equal(calculateMomentum({ activeAds: 5, totalAds: 5, newAds7d: 5 }).status, "SIN_HISTORICO"); });
  await test("dos snapshots permiten momentum", () => { const result = calculateMomentum({ activeAds: 8, totalAds: 9, newAds7d: 4 }, { id: "s", productId: "p", capturedAt: new Date(Date.now() - 3 * 86400000).toISOString(), activeAds: 5, totalAds: 5, advertisers: 1, medianAdAge: 20, oldestAd: 20, newAds7d: 1, newAds14d: 1, creativeVelocity: 10, opportunityScore: 50, momentum: 0, lifecycle: "UNKNOWN" }); assert.equal(result.status, "STRONG_GROWTH"); assert.equal(result.components.deltaActiveAds, 3); });

  const { classifyNoise } = await import("../src/lib/product-intelligence/noise");
  await test("ruido servicio", () => assert.equal(classifyNoise([ad({ productName: undefined, copy: "Reserva consulta en nuestra clínica" })]).reason, "SERVICE"));
  await test("ruido app", () => assert.equal(classifyNoise([ad({ productName: undefined, copy: "Descarga nuestra aplicación móvil" })]).reason, "APP"));

  const { PublicSupplierProvider, estimatePredictiveEconomics } = await import("../src/lib/product-intelligence/predictive");
  await test("supplier 403 y captcha no rompen otras fuentes", async () => {
    process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE = "scraping_publico";
    const fetcher: typeof fetch = async (input) => String(input).includes("aliexpress") ? new Response('<a href="https://www.aliexpress.com/item/1">100 units €3.50</a>', { status: 200 }) : String(input).includes("1688") ? new Response("forbidden", { status: 403 }) : new Response("captcha verify you are human", { status: 200 });
    const provider = new PublicSupplierProvider(fetcher); const result = await estimatePredictiveEconomics("corrector", provider, [ad({ price: 29.9, landingUrl: "https://tienda.example/producto" })]);
    assert.equal(result.economics.costAt100?.confidence, "LOW"); assert.deepEqual(provider.sourceStatuses().map((entry) => entry.status), ["DISPONIBLE", "NO_DISPONIBLE", "NO_DISPONIBLE"]); assert.ok(result.economics.costAt100?.sources[0].url.includes("aliexpress.com"));
    delete process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE;
  });
  await test("tres suppliers producen confianza MEDIUM", async () => {
    const provider = { available: true, mechanism: "mock", search: async ({ kind }: { kind: "wholesale" | "retail" }) => kind === "retail" ? [{ kind, source: "retail", url: "https://shop.example/p", priceEur: 30, quantity: 1, weightGrams: 500, observedAt: new Date().toISOString() }] : ["Alibaba", "AliExpress", "1688"].map((source, index) => ({ kind, source, url: `https://${source.toLowerCase()}.example/p`, priceEur: 3 + index, quantity: 500, weightGrams: 500, observedAt: new Date().toISOString() })) };
    const result = await estimatePredictiveEconomics("p", provider); assert.equal(result.economics.confidence, "MEDIUM"); assert.equal(result.verdict, "CANDIDATO_FUERTE");
  });
  await test("todos los suppliers caídos dejan coste null", async () => {
    const provider = { available: true, mechanism: "mock", search: async () => [], sourceStatuses: () => ["Alibaba", "AliExpress", "1688"].map((source) => ({ source, status: "NO_DISPONIBLE" as const, reason: "HTTP 403" })) };
    const result = await estimatePredictiveEconomics("p", provider); assert.equal(result.economics.costAt500, null); assert.equal(result.economics.confidence, "SIN_DATOS"); assert.equal(result.verdict, null);
  });

  const { runHunterPipeline } = await import("../src/lib/product-intelligence/pipeline");
  await test("pipeline end-to-end mockeado y estimados no habilitan decisión final", async () => {
    const calls: string[] = [];
    const provider = { searchAds: async (query: string) => { calls.push(query); return query === "juanetes" ? [ad({ id: "pipeline-ad", advertiserId: "pipeline-page", pageId: "pipeline-page", advertiserName: "Pipeline Shop", price: 29.9, landingUrl: "https://shop.example/p", rawProviderPayload: { id: "pipeline-ad", access_token: "never-store" } })] : []; } };
    const predictiveProvider = { available: true, mechanism: "mock", search: async ({ kind }: { kind: "wholesale" | "retail" }) => kind === "wholesale" ? [{ kind, source: "Alibaba", url: "https://alibaba.example/p", priceEur: 4, quantity: 500, weightGrams: 500, observedAt: new Date().toISOString() }] : [] };
    const result = await runHunterPipeline({ query: "juanetes", provider, predictiveProvider, persist: false });
    assert.equal(calls[0], "juanetes"); assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].predictiveEconomics?.sourceType, "ESTIMATED"); assert.equal(result.candidates[0].decisionEligible, false); assert.equal(result.candidates[0].momentumStatus, "SIN_HISTORICO"); assert.equal("access_token" in result.rawMetaResponses[0].payload, false); assert.equal(result.normalizedAds[0].rawProviderPayload, undefined);
  });

  delete process.env.META_AD_LIBRARY_ACCESS_TOKEN; delete process.env.META_GRAPH_API_VERSION;
  console.log(`${passed} tests Hunter end-to-end OK`);
}

main().catch((error) => { console.error(error); process.exit(1); });
