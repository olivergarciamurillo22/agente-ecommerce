import "./env-loader";
import fs from "node:fs";
import { ManualImportProvider, UnconfiguredProvider } from "../src/lib/product-intelligence/provider";
import { runResearch } from "../src/lib/product-intelligence/engine";
import type { RawAd } from "../src/lib/product-intelligence/types";
import { MetaAdLibraryProvider } from "../src/lib/product-intelligence/providers/meta-ad-library-provider";
import { saveProviderHealth } from "../src/lib/product-intelligence/state";
import { metaSmokeTest } from "../src/lib/product-intelligence/smoke-test";
import { exportDailyReport, exportProductDossiers, exportWatchlist } from "../src/lib/product-intelligence/export";
import { resetTestFixtureSessions } from "../src/lib/product-intelligence/repository";
import { resetTestFixtureState } from "../src/lib/product-intelligence/state";
import { persistenceHealth } from "../src/lib/product-intelligence/persistence";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "meta-health") {
    const health = await new MetaAdLibraryProvider().healthCheck(); saveProviderHealth(health);
    console.log(["Meta Ad Library", "----------------", `Configured: ${health.configured ? "yes" : "no"}`, `API: ${health.apiVersion ?? "not configured"}`, `Token loaded: ${health.configured ? "yes" : "no"}`, `Authorization: ${health.authorization?.toLowerCase()}`, `Provider health: ${health.code?.replace("META_", "").toLowerCase()}`, `Research available: ${health.researchAvailable ? "yes" : "no"}`].join("\n")); return;
  }
  if (command === "meta-smoke-test") { console.log(JSON.stringify(await metaSmokeTest(args[1] || "almohada cervical"), null, 2)); return; }
  if (command === "export") { const kind = args[1]; console.log(kind === "watchlist" ? exportWatchlist() : kind === "daily" ? exportDailyReport() : exportProductDossiers()); return; }
  if (command === "reset-test-data") { const ids = resetTestFixtureSessions(); resetTestFixtureState(ids); console.log(`Removed TEST_FIXTURE products: ${ids.length}`); return; }
  if (command === "persistence-health") { const health = persistenceHealth(); console.log(JSON.stringify(health, null, 2)); if (!health.healthy) process.exitCode = 1; return; }
  if (!['research', 'auto-hunt'].includes(command ?? '')) throw new Error('Uso: product-intelligence meta-health | meta-smoke-test "keyword" | research "keyword" [ads.json] | auto-hunt [ads.json]');
  const query = command === "research" ? args[1] : undefined;
  if (command === "research" && !query) throw new Error("Debes indicar una keyword");
  const importPath = command === "research" ? args[2] : args[1];
  const provider = importPath ? new ManualImportProvider(JSON.parse(fs.readFileSync(importPath, "utf8")) as RawAd[]) : new UnconfiguredProvider();
  const session = await runResearch(provider, query);
  console.log(JSON.stringify(session, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
