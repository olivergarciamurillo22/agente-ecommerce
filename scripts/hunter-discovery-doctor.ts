import "./env-loader";
import { AdLibraryClient, probeAdLibraryFields } from "../src/lib/hunter/discovery/client";

async function main() {
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim(); if (!token) throw new Error("Falta META_AD_LIBRARY_ACCESS_TOKEN con ads_read");
  const term = process.argv.slice(2).join(" ").trim() || "comodidad hogar";
  const until = new Date().toISOString().slice(0, 10); const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const probes = await probeAdLibraryFields(new AdLibraryClient(token), { term, country: "ES", since, until });
  console.table(probes); if (probes.every((probe) => probe.status === "error")) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
