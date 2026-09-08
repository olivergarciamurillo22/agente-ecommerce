// ============================================================
// hunter:add — ingiere una ficha de producto como candidato del Cazador.
//
//   npm run hunter:add -- --url <url>            (dry-run: enseña lo leído)
//   npm run hunter:add -- --url <url> --apply    (guarda el candidato)
//
// Todo dentro de main(): el proyecto es CommonJS (package.json sin
// "type": "module"), tsx compila los scripts a CJS y esbuild rechaza un
// `await` de nivel superior ("Top-level await is currently not supported
// with the cjs output format"). Incidente del 08-09-2026 en el NAS: este era
// el único script del repo con un await suelto. Mismo patrón que
// hunter-discovery-doctor.ts y el resto.
// ============================================================

import { ingestProductPage, type IngestEvent } from "../src/lib/hunter/ingest";
import { HunterRepository } from "../src/lib/hunter/repository";
import { logIntegrationEvent } from "../src/lib/system/repo";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  const url = arg("--url");
  if (!url) throw new Error("Uso: npm run hunter:add -- --url <url> [--apply]");
  new URL(url);
  const apply = process.argv.includes("--apply");
  const audit: IngestEvent = (type, severity, message, attemptUrl) =>
    logIntegrationEvent("system", type, severity, message, new URL(attemptUrl).hostname);
  const result = await ingestProductPage(url, fetch, audit);
  const criticalMissing = [result.facts.unitCostEur, result.facts.weightGrams, result.facts.lengthCm, result.facts.widthCm, result.facts.heightCm].some((v) => v === null);
  if (!apply) {
    console.log(JSON.stringify({ ...result, mode: "dry-run", reason: criticalMissing ? "Faltan datos críticos; usa --apply conscientemente para guardar el candidato incompleto." : "Falta --apply." }, null, 2));
    return;
  }
  const saved = new HunterRepository().upsert(result.facts);
  console.log(JSON.stringify(saved, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
