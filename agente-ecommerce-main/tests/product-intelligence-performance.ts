import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-performance-"));

async function main() {
  const { analyzeAds, calculateQueryScore } = await import("../src/lib/product-intelligence/engine");
  const { saveSession } = await import("../src/lib/product-intelligence/repository");
  const { exportDailyReport, exportProductDossiers } = await import("../src/lib/product-intelligence/export");
  const before = process.memoryUsage().heapUsed; const started = performance.now();
  const ads = Array.from({ length: 10000 }, (_, index) => ({ id: `ad-${index}`, advertiserId: `advertiser-${index % 500}`, advertiserName: `Advertiser ${index % 500}`, copy: `Creative for item ${index % 1000}`, productName: `SKU ${String(index % 1000).padStart(4, "0")}`, startedAt: new Date(Date.now() - (index % 90) * 86400000).toISOString(), active: index % 5 !== 0, price: 39.9, provider: "TEST_FIXTURE" as const }));
  const generatedAt = performance.now(); const products = analyzeAds(ads); const analyzedAt = performance.now();
  const queries = Array.from({ length: 5000 }, (_, index) => ({ id: `q-${index}`, displayQuery: `query ${index}`, normalizedQuery: `query ${index}`, rootQueryId: "root", depth: index % 3, source: "TEST_FIXTURE", priority: 1, status: "COMPLETED" as const, resultsCount: 2, queryScore: calculateQueryScore({ newProducts: index % 3, newAdvertisers: index % 2, averageOpportunity: 60, duplicateRate: 0.1 }) }));
  const scoredAt = performance.now(); saveSession({ id: "performance-fixture", mode: "AUTONOMOUS", status: "COMPLETED", startedAt: new Date().toISOString(), queriesProcessed: queries.length, productsFound: products.length, queries, products, source: "TEST_FIXTURE", adsScanned: ads.length, advertisersFound: 500 }); const persistedAt = performance.now();
  exportProductDossiers(); exportDailyReport(); const reportedAt = performance.now();
  console.log(JSON.stringify({ ads: ads.length, advertisers: 500, products: products.length, queries: queries.length, generationMs: Math.round(generatedAt - started), ingestionDedupScoringMs: Math.round(analyzedAt - generatedAt), queryScoringMs: Math.round(scoredAt - analyzedAt), persistenceMs: Math.round(persistedAt - scoredAt), reportMs: Math.round(reportedAt - persistedAt), heapDeltaMb: Math.round((process.memoryUsage().heapUsed - before) / 1048576), totalMs: Math.round(reportedAt - started) }, null, 2));
}
main().catch((error) => { console.error(error); process.exit(1); });
