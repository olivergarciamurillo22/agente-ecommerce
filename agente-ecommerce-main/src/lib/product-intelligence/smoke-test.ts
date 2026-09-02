import { runResearch } from "./engine";
import { MetaAdLibraryProvider } from "./providers/meta-ad-library-provider";
import { saveProviderHealth } from "./state";

export async function metaSmokeTest(rootQuery: string) {
  const started = Date.now(); const provider = new MetaAdLibraryProvider(); const health = await provider.healthCheck(); saveProviderHealth(health);
  const base = { provider: "META_AD_LIBRARY", apiVersion: health.apiVersion, authorization: health.authorization, rootQuery, httpSuccess: health.code === "META_CONNECTED", adsFound: 0, advertisersFound: 0, productsFound: 0, derivedQueriesGenerated: 0, persistence: false, durationMs: Date.now() - started };
  if (health.code !== "META_CONNECTED") return base;
  const session = await runResearch(provider, rootQuery);
  return { ...base, adsFound: session.adsScanned ?? 0, advertisersFound: session.advertisersFound ?? 0, productsFound: session.productsFound, derivedQueriesGenerated: Math.max(0, session.queries.length - 1), persistence: true, durationMs: Date.now() - started };
}
