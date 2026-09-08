// ============================================================
// hunter:add — ingiere una ficha de producto como candidato del Cazador.
//
//   npm run hunter:add -- --url <url>            (dry-run: enseña lo leído)
//   npm run hunter:add -- --url <url> --apply    (guarda el candidato)
//
// F3 (08-09-2026) · hechos MANUALES para proveedores con catálogo privado
// (Dropi/Dropea) o fichas que no exponen coste ni medidas:
//   npm run hunter:add -- --url <url> --apply --coste-eur 7.9 --peso-gramos 420 \
//       --largo-cm 22 --ancho-cm 14 --alto-cm 8 [--pvp-eur 29.99]
//   npm run hunter:add -- --nombre "Barra de apoyo" --apply --coste-eur 6 ...   (sin URL: candidato manual)
// Regla: si el scraper sacó un valor Y llega uno manual, gana el MANUAL, y
// queda constancia en nota_manual / candidate_events (origen humano). El
// sistema nunca inventa un dato: sin medidas, hunter:score sigue sin puntuar.
//
// Todo dentro de main(): el proyecto es CommonJS (package.json sin
// "type": "module"), tsx compila los scripts a CJS y esbuild rechaza un
// `await` de nivel superior. Incidente del 08-09-2026 en el NAS.
// ============================================================

import { ingestProductPage, type IngestEvent } from "../src/lib/hunter/ingest";
import { HunterRepository } from "../src/lib/hunter/repository";
import { logIntegrationEvent } from "../src/lib/system/repo";
import type { CandidateFacts } from "../src/lib/hunter/types";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
function numArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === null) return undefined;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} debe ser un número no negativo (llegó "${raw}")`);
  return n;
}

/** Los flags manuales presentes, tal cual (undefined = no llegó). */
export function manualFactsFromArgs(): { unitCostEur?: number; salePriceEur?: number; weightGrams?: number; lengthCm?: number; widthCm?: number; heightCm?: number } {
  const out: Record<string, number | undefined> = {
    unitCostEur: numArg("--coste-eur"), salePriceEur: numArg("--pvp-eur"), weightGrams: numArg("--peso-gramos"),
    lengthCm: numArg("--largo-cm"), widthCm: numArg("--ancho-cm"), heightCm: numArg("--alto-cm"),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

async function main(): Promise<void> {
  const url = arg("--url");
  const nombre = arg("--nombre");
  if (!url && !nombre) throw new Error('Uso: npm run hunter:add -- --url <url> [--apply] [--coste-eur N --peso-gramos N --largo-cm N --ancho-cm N --alto-cm N --pvp-eur N]   |   --nombre "…" --apply --coste-eur … (candidato manual sin URL)');
  const apply = process.argv.includes("--apply");
  const manual = manualFactsFromArgs();
  const repo = new HunterRepository();

  let facts: CandidateFacts;
  let dryRunInfo: Record<string, unknown> = {};
  if (url) {
    new URL(url);
    const audit: IngestEvent = (type, severity, message, attemptUrl) =>
      logIntegrationEvent("system", type, severity, message, new URL(attemptUrl).hostname);
    const result = await ingestProductPage(url, fetch, audit);
    facts = result.facts;
    dryRunInfo = { suspiciousInstruction: result.suspiciousInstruction, shell: result.shell };
  } else {
    // Candidato manual: sin ficha que leer, con URL sintética única por nombre.
    const slug = nombre!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
    facts = { sourceUrl: `hunter://manual/${slug}`, sourceDomain: "manual", fetchedAt: Math.floor(Date.now() / 1000), name: nombre!.trim().slice(0, 160), category: null, unitCostEur: null, salePriceEur: null, sourceCurrency: null, sourceCost: null, weightGrams: null, lengthCm: null, widthCm: null, heightCm: null, variants: null, specs: null, claims: null };
  }

  const sobrescribe = (Object.keys(manual) as Array<keyof typeof manual>).filter((k) => facts[k] !== null && facts[k] !== undefined && manual[k] !== facts[k]);
  const combinado: CandidateFacts = { ...facts, ...manual, sourceCurrency: manual.unitCostEur !== undefined ? "EUR" : facts.sourceCurrency };
  const criticalMissing = [combinado.unitCostEur, combinado.weightGrams, combinado.lengthCm, combinado.widthCm, combinado.heightCm].some((v) => v === null || v === undefined);

  if (!apply) {
    console.log(JSON.stringify({ ...dryRunInfo, facts: combinado, manual, sobrescribe, mode: "dry-run", reason: criticalMissing ? "Faltan datos críticos (coste, peso o medidas); pásalos con los flags manuales o usa --apply conscientemente para guardar el candidato incompleto." : "Falta --apply." }, null, 2));
    return;
  }
  const saved = repo.upsert(facts);
  const final = Object.keys(manual).length ? repo.setFacts(saved.id, manual, "manual") : saved;
  if (sobrescribe.length) console.error(`aviso: el dato manual sustituye al scrapeado en ${sobrescribe.join(", ")} (queda anotado en nota_manual)`);
  console.log(JSON.stringify(final, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
