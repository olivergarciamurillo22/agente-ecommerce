// ============================================================
// hunter:cruce-dropea — cruce Dropea × Ad Library por lotes (08-09-2026)
// docs/PRODUCT-HUNTER-BACKEND-USO.md §cruce
//
//   npm run hunter:cruce-dropea -- --limite 20
//   npm run hunter:cruce-dropea -- --limite 50 --categoria "cocina" --pais ES --dias 30
//   npm run hunter:cruce-dropea -- --limite 20 --pais IT,PT,FR,DE     (búsqueda 2: otros mercados, una corrida por país;
//                                                                     palabras traducidas por Claude si hay OPENROUTER_API_KEY; --sin-traducir)
//   npm run hunter:cruce-dropea -- --limite 10 --repetir      (vuelve a cruzar los ya cruzados: mide momentum)
//   npm run hunter:cruce-dropea -- --ver                       (solo lista lo persistido, sin red)
//   npm run hunter:cruce-dropea -- ... --json informe.json
//
// Cada producto del catálogo local = UNA petición a la Ad Library (una
// página). Respeta el presupuesto del discovery (peticiones y tiempo) y
// EMERGENCY_STOP, y persiste producto a producto: si se corta, lo hecho se
// queda. El panel lee de lo persistido.
//
// Exige META_AD_LIBRARY_ACCESS_TOKEN y una copia del catálogo
// (hunter:dropea:sync). Sin ellos no inventa nada.
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return inline ? inline.slice(nombre.length + 3) : undefined;
}
const hasFlag = (nombre: string) => process.argv.includes(`--${nombre}`);
const eur = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)} €`);
const fecha = (sec: number | null) => (sec === null ? "—" : new Date(sec * 1000).toISOString().slice(0, 10));

function tabla(rows: Array<import("../src/lib/product-hunter/internal/cruce").CruceRow>): void {
  if (!rows.length) { console.log("  (sin cruces todavía: lanza npm run hunter:cruce-dropea -- --limite 20)"); return; }
  console.table(rows.map((c) => ({
    producto: (c.productName ?? "?").slice(0, 38),
    "palabras a Meta": c.terms.join(" ").slice(0, 32) || "(ninguna)",
    coste: eur(c.costEur),
    match: c.match,
    "anuncio desde": fecha(c.oldestActiveAt),
    activos: c.activeAds ?? "—",
    "precio anuncio": eur(c.detectedPriceEur),
    "margen %": c.marginPct === null ? "no calc." : `${Math.round(c.marginPct * 100)} %`,
    score: c.score ?? "—",
    motivo: `${c.breakdown.validacion.points}+${c.breakdown.margen.points}+${c.breakdown.confianza.points}`,
  })));
}

async function main(): Promise<void> {
  const { CruceRepository, runCruceBatch, CRUCE_FORMULA } = await import("../src/lib/product-hunter/internal/cruce");
  const { DropeaCatalogRepository } = await import("../src/lib/product-hunter/internal/dropea-catalog");
  const paises = (arg("pais") ?? "ES").toUpperCase().split(",").map((p) => p.trim()).filter((p) => /^[A-Z]{2}$/.test(p));
  if (!paises.length) { console.error("✗ --pais espera códigos ISO de 2 letras, p. ej. IT o IT,PT,FR"); process.exit(2); }
  const pais = paises[0];
  const repo = new CruceRepository();

  if (hasFlag("ver")) {
    const rows = repo.latest({ country: pais, term: arg("buscar") ?? "", limit: Number.parseInt(arg("limite") ?? "", 10) || 50 });
    console.log(`\n──── CRUCES PERSISTIDOS (${pais}) · ${rows.length} producto(s), último cruce de cada uno ────\n`);
    tabla(rows);
    console.log(`\n  Fórmula: ${CRUCE_FORMULA}\n`);
    return;
  }

  const catalogo = new DropeaCatalogRepository();
  if (catalogo.count() === 0) {
    console.error("\n✗ No hay copia local del catálogo de Dropea. Ejecuta antes: npm run hunter:dropea:sync\n");
    process.exit(2);
  }
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  if (!token) {
    console.error("\n✗ Falta META_AD_LIBRARY_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN). Sin token no se cruza nada.\n");
    process.exit(2);
  }
  const limite = Number.parseInt(arg("limite") ?? "", 10) || 20;
  const { makeKeywordTranslator, needsTranslation } = await import("../src/lib/hunter/deep-dive/translate");
  const translate = hasFlag("sin-traducir") ? null : makeKeywordTranslator();
  const informes: unknown[] = [];
  for (const p of paises) {
    console.log(`\n──── CRUCE DROPEA × AD LIBRARY · ${limite} producto(s) · ${p} · ${arg("dias") ?? 30} días${p !== "ES" ? ` · palabras ${needsTranslation(p) ? (translate ? "traducidas por Claude" : "en español (sin OPENROUTER_API_KEY o --sin-traducir)") : "en español"}` : ""} ────\n`);
    console.log(`  Catálogo local: ${catalogo.count()} variantes (copia del ${fecha(catalogo.lastSyncedAt())}) · ya cruzados en ${p}: ${repo.crossedVariantIds(p).size}${hasFlag("repetir") ? " (se repiten)" : " (se saltan)"}\n`);
    const r = await runCruceBatch({
      token, country: p, days: Number.parseInt(arg("dias") ?? "", 10) || 30, limit: limite, translate,
      offset: Number.parseInt(arg("offset") ?? "", 10) || 0, category: arg("categoria") ?? null, skipCrossed: !hasFlag("repetir"),
      onProduct: (c, i, total) => console.log(`  [${String(i).padStart(3)}/${total}] ${(c.productName ?? "?").slice(0, 44).padEnd(44)} match ${c.match.padEnd(6)} score ${String(c.score ?? "—").padStart(5)}  ${c.breakdown.margen.calculable ? `margen ${Math.round((c.marginPct ?? 0) * 100)} %` : "margen no calculable"}${c.breakdown.keywordsOriginal ? ` · «${c.terms.join(" ")}»` : ""}`),
    });
    console.log(`\n  Parada: ${r.stopReason} · ${r.processed} procesado(s) · ${r.matched} con match · ${r.requests} peticiones a Meta · ${r.elapsedSec} s (corrida ${r.runId})\n`);
    tabla([...r.cruces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)));
    informes.push(r);
    if (r.stopReason !== "completado") { console.log(`  Corrida en ${p} parada por ${r.stopReason}: no se sigue con el resto de países.`); break; }
  }
  console.log(`\n  Fórmula: ${CRUCE_FORMULA}`);
  console.log(`  Un match es una heurística de texto: puede casar un producto parecido (falso positivo) o no encontrar al anunciante que lo llama de otra forma (falso negativo).`);
  if (paises.some((p) => p !== "ES")) console.log(`  Un match fuera de España NO es una oportunidad hasta que el deep dive compruebe España: npm run hunter:deep-dive -- --ids <id> (campo «competencia en España»).\n`);
  if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(informes.length === 1 ? informes[0] : informes, null, 2));
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
