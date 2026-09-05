import "./env-loader";
import { MetaAdLibraryProvider } from "../src/lib/product-intelligence/providers/meta-ad-library-provider";
import { runHunterPipeline } from "../src/lib/product-intelligence/pipeline";

const value = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const query = value("--termino") ?? value("--producto");

async function main() {
  if (!query) throw new Error('Uso: npm run hunter:end-to-end -- --termino "juanetes" [--pais ES] [--dias 14] [--max-pages 2] [--sin-predictivo] [--json]');
  const country = (value("--pais") ?? "ES") as "ES" | "PT" | "IT" | "FR" | "DE" | "EU";
  const maxPages = Math.max(1, Math.min(5, Number(value("--max-pages") ?? 2)));
  const provider = new MetaAdLibraryProvider({ maxPages, maxCalls: 20 });
  const result = await runHunterPipeline({ query, country, days: Number(value("--dias") ?? 14), predictive: !process.argv.includes("--sin-predictivo"), provider });
  if (process.argv.includes("--json")) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(["HUNTER END-TO-END", `Run: ${result.runId}`, `Root query: ${result.rootQuery}`, `País: ${result.country}`, `Meta calls: ${result.metrics.metaCalls}`, `Ads: ${result.metrics.adsReceived}`, `Grupos: ${result.metrics.groups}`, `Candidatos: ${result.metrics.candidates}`, `Ruido: ${result.metrics.noiseRejected}`, `Predictivo: ${result.metrics.predictiveEnriched}`, `Errores: ${result.metrics.errors}`, ""].join("\n"));
  for (const candidate of result.candidates) console.log([
    `CANDIDATO: ${candidate.name}`, `ADVERTISER: ${candidate.advertiser ?? "SIN_DATOS"}`, `ADS ACTIVOS: ${candidate.activeAds}`,
    `AD MÁS ANTIGUO: ${candidate.oldestActiveAdDays}d`, `MOMENTUM: ${candidate.momentumStatus ?? "SIN_HISTORICO"}`,
    `RUIDO: ${candidate.noise ? candidate.noiseReason : "NO"}`, `COSTE EST.: ${candidate.predictiveEconomics?.costAt500 ? `${candidate.predictiveEconomics.costAt500.min}-${candidate.predictiveEconomics.costAt500.max} EUR` : "SIN_DATOS"}`,
    `PVP EST.: ${candidate.predictiveEconomics?.pvp ? `${candidate.predictiveEconomics.pvp.min}-${candidate.predictiveEconomics.pvp.max} EUR` : "SIN_DATOS"}`,
    `VEREDICTO: ${candidate.preliminaryVerdict ?? "SIN_DATOS"}`, `CONFIANZA: ${candidate.predictiveEconomics?.confidence ?? candidate.confidence}`, "",
  ].join("\n"));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });

