// ============================================================
// BUSCADOR DE COMPETENCIA POR UNA PALABRA — CLI
// docs/HUNTER-BUSCADOR.md
//
//   npm run hunter:search -- --palabra "organizador cocina"
//   npm run hunter:search -- --palabra "almohada" --minutos 15 --pais ES --dias 30
//   npm run hunter:search -- --palabra "..." --solo-terminos      (no sale a la red)
//   npm run hunter:search -- --palabra "..." --json informe.json
//
// Enseña progreso en vivo (término, anuncios y peticiones) para que se vea que
// sigue trabajando durante los quince minutos. Si el presupuesto o la cuota
// cortan, lo encontrado hasta ahí queda guardado y el informe dice por qué.
//
// Exige META_AD_LIBRARY_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN). Sin token no
// inventa nada: dice que falta y sale con 2.
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return inline ? inline.slice(nombre.length + 3) : undefined;
}
const hasFlag = (nombre: string) => process.argv.includes(`--${nombre}`);

async function main(): Promise<void> {
  const palabra = arg("palabra") ?? arg("termino");
  if (!palabra) {
    console.error('Uso: npm run hunter:search -- --palabra "organizador cocina" [--pais ES] [--dias 30] [--minutos 15] [--solo-terminos] [--json informe.json]');
    process.exit(2);
  }

  const { expandSearchTerm } = await import("../src/lib/hunter/discovery/expansion");
  const terms = expandSearchTerm(palabra, { max: Number.parseInt(arg("terminos") ?? "", 10) || 24 });

  console.log(`\n──── BUSCADOR DE COMPETENCIA · "${palabra}" ────\n`);
  console.log(`  ${terms.length} término(s) de búsqueda:`);
  for (const t of terms) console.log(`    · ${t.term.padEnd(38)} (${t.origin}: ${t.why})`);

  if (hasFlag("solo-terminos")) {
    console.log("\n  (--solo-terminos: no se ha salido a la red)\n");
    return;
  }

  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  if (!token) {
    console.error("\n✗ Falta META_AD_LIBRARY_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN) en el entorno.");
    console.error("  Sin token no se busca nada: este comando no inventa resultados.\n");
    process.exit(2);
  }

  const { runWordSearch } = await import("../src/lib/hunter/discovery/word-search");
  const minutos = Number.parseInt(arg("minutos") ?? "", 10) || 15;
  let ultimaLinea = 0;
  const result = await runWordSearch({
    seed: palabra,
    country: (arg("pais") ?? "ES").toUpperCase(),
    days: Number.parseInt(arg("dias") ?? "", 10) || 30,
    token,
    minutes: minutos,
    maxTerms: terms.length,
    onProgress: (p) => {
      // Una línea por término: legible en un log, no una barra que parpadea.
      if (p.fase === "buscando" && p.termsDone !== ultimaLinea) {
        ultimaLinea = p.termsDone;
        console.log(`  [${String(p.termsDone).padStart(2)}/${p.termsTotal}] "${p.term}" · ${p.ads} anuncios · ${p.requests} peticiones · quedan ${Math.floor(p.remainingSec / 60)} min`);
      }
      if (p.fase === "agrupando") console.log(`\n  Agrupando ${p.ads} anuncios por competidor…`);
    },
  });

  console.log(`\n  Parada: ${result.stopReason} · ${result.termsQueried.length}/${result.terms.length} términos · ${result.requests} peticiones · ${result.pages} páginas · ${result.elapsedSec} s`);
  console.log(`  ${result.rawAds} anuncios únicos → ${result.competitors.length} competidor(es) + ${result.discarded.length} descartado(s) por ruido\n`);

  for (const c of result.competitors.slice(0, 25)) {
    console.log(`  ▸ ${(c.pageName ?? c.pageId).slice(0, 48)}  ·  ${c.activeAds} anuncio(s) activo(s)`);
    for (const s of c.signals) {
      if (s.value === null || s.value === "") continue;
      const etiqueta = s.confirmado ? "dato" : s.source === "declarado" ? "declarado" : "señal";
      console.log(`      ${s.label}: ${s.value}   [${etiqueta}]`);
    }
    if (c.snapshotUrls[0]) console.log(`      Ficha del anuncio: ${c.snapshotUrls[0]}`);
    console.log("");
  }
  if (result.discarded.length) {
    console.log("  Descartados por ruido (revisa si alguno no debería estarlo):");
    for (const c of result.discarded.slice(0, 10)) console.log(`    · ${(c.pageName ?? c.pageId).slice(0, 40)} — ${c.noiseReason}`);
    console.log("");
  }

  const { NOT_AVAILABLE_FROM_AD_LIBRARY } = await import("../src/lib/hunter/discovery/signals");
  console.log("  Lo que esta API NO da, y por tanto no se enseña:");
  for (const l of NOT_AVAILABLE_FROM_AD_LIBRARY) console.log(`    · ${l}`);
  console.log("");

  const jsonPath = arg("json");
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`  Informe JSON: ${jsonPath}\n`);
  }
  process.exitCode = result.stopReason === "token_invalido" || result.stopReason === "permiso" ? 1 : 0;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("\n✗", err instanceof Error ? err.message : err, "\n");
    process.exitCode = 1;
  });
}
