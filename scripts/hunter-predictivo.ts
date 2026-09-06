import { estimatePredictiveCandidate } from "../src/lib/hunter/predictive/estimate";
import { PredictiveRepository } from "../src/lib/hunter/predictive/repository";
import { HttpPredictiveSearchProvider } from "../src/lib/hunter/predictive/search";
import { PublicScrapingSearchProvider } from "../src/lib/hunter/predictive/scraping-publico";

function arg(name: string): string | null { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }

async function main(): Promise<void> {
  const product = arg("--producto");
  const competitorUrl = arg("--url");
  if (!product) throw new Error('Uso: npm run hunter:predictivo -- --producto "nombre" [--url <url_competidor>]');
  if (competitorUrl) new URL(competitorUrl);

  const provider = process.env.HUNTER_PREDICTIVE_SEARCH_SOURCE === "scraping_publico"
    ? new PublicScrapingSearchProvider()
    : new HttpPredictiveSearchProvider();
  const estimate = await estimatePredictiveCandidate(product, competitorUrl, provider);
  const repository = new PredictiveRepository();
  const saved = repository.save(estimate);
  const promoted = process.argv.includes("--promover") && saved.viability.verdict && saved.viability.verdict !== "descartar"
    ? repository.promote(saved.id!)
    : null;
  console.log(JSON.stringify({
    ...saved,
    promotedCandidateId: promoted?.id ?? null,
    warning: "Estimacion preliminar: no usar para margenes reales ni presupuesto de ads.",
    units: { prices: "EUR/unidad", weight: "gramos", quantities: "unidades" },
    sin_acceso_a_busqueda: !saved.searchAvailable,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
