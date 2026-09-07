// ============================================================
// AUDITOR DE TIENDAS GANADORAS — CLI
// docs/HUNTER-AUDITOR.md
//
//   Modo A · una tienda:
//     npm run hunter:audit -- --tienda casamable.es
//     npm run hunter:audit -- --tienda tienda.es --facebook https://www.facebook.com/latienda
//     npm run hunter:audit -- --tienda tienda.es --solo-tienda     (solo portada + catálogo: NO toca Meta)
//
//   Modo B · nicho → candidatas → auditoría en cadena:
//     npm run hunter:audit -- --nicho "barra de apoyo" --minutos 15
//
//   --json informe.json guarda el informe completo.
//
// Lo que no se pudo completar sale en «No se pudo completar», con motivo. No
// hay gasto, ventas ni rendimiento: la Ad Library no los da y no se estiman.
//
// Exige META_AD_LIBRARY_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN) salvo con
// --solo-tienda. Sin token no inventa nada: dice que falta y sale con 2.
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

type Informe = Awaited<ReturnType<(typeof import("../src/lib/hunter/audit/store-audit"))["runStoreAudit"]>>;

function pintarInforme(r: Informe, sangria = "  "): void {
  const p = (s: string) => console.log(sangria + s);
  if (r.incomplete.length) {
    p("No se pudo completar:");
    for (const i of r.incomplete) p(`  ✗ ${i.part}: ${i.reason}`);
  }
  p(`Marca: ${r.brandName ?? "(sin nombre usable)"} · dominio ${r.domain} · ${r.profile.isShopify ? "Shopify" : "no Shopify"}`);
  if (r.catalog.status === "ok") {
    p(`Catálogo: ${r.catalog.products}${r.catalog.truncated ? "+" : ""} productos · ${eur(r.catalog.priceMin)} – ${eur(r.catalog.priceMax)}`);
    if (r.catalog.topTypes.length) p(`  tipos: ${r.catalog.topTypes.map((t) => `${t.type} (${t.count})`).join(", ")}`);
    for (const s of r.catalog.sample.slice(0, 5)) p(`  · ${s.title} — ${eur(s.price)}`);
  } else {
    p(`Catálogo: no accesible (${r.catalog.reason ?? r.catalog.status})`);
  }
  p(`Facebook: ${r.facebook.urls[0] ?? "sin enlace"} · ${r.facebook.note}`);
  if (r.adLibrary.status === "ok") {
    p(`Ad Library: ${r.adLibrary.activeAds} anuncio(s) activo(s) · atribuidos por ${r.adLibrary.matchedBy.join(" y ")} · buscado como «${r.adLibrary.searchTerms.join("», «")}»`);
    for (const c of r.adLibrary.competitors) {
      const dias = c.signals.find((s) => s.id === "dias_activo")?.value;
      p(`  ${c.pageName ?? c.pageId}: ${c.activeAds} activos${typeof dias === "number" ? `, ${dias} días activa` : ""}${c.snapshotUrls[0] ? ` · ${c.snapshotUrls[0]}` : ""}`);
    }
  } else {
    p(`Ad Library: ${r.adLibrary.status} · ${r.adLibrary.reason ?? ""}`);
  }
  if (r.angles && r.angles.angles.length) {
    p("Ángulos (etiqueta heurística; la cita es el dato):");
    for (const a of r.angles.angles) {
      p(`  ${a.label} · ${a.ads} anuncio(s)`);
      for (const e of a.evidence.slice(0, 2)) p(`     «${e.quote}» [${e.field}]`);
    }
    if (r.angles.unclassified.length) p(`  ${r.angles.unclassified.length} anuncio(s) sin ángulo reconocido`);
  }
  p(`No disponible: ${r.notAvailable.join(" · ")}`);
}

async function main(): Promise<void> {
  const tienda = arg("tienda");
  const nicho = arg("nicho");
  if (!tienda && !nicho) {
    console.error('Uso: npm run hunter:audit -- --tienda tienda.es [--facebook URL] [--solo-tienda]   |   --nicho "palabra" [--minutos 15] [--pais ES] [--dias 30]   [--json informe.json]');
    process.exit(2);
  }
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  const country = (arg("pais") ?? "ES").toUpperCase();
  const days = Number.parseInt(arg("dias") ?? "", 10) || 30;

  if (tienda) {
    console.log(`\n──── AUDITOR · tienda ${tienda} ────\n`);
    if (hasFlag("solo-tienda")) {
      const { readStore } = await import("../src/lib/hunter/audit/store");
      const r = await readStore(tienda);
      console.log(`  Portada: ${r.profile.homepageStatus}${r.profile.homepageReason ? ` (${r.profile.homepageReason})` : ""} · ${r.profile.isShopify ? "Shopify" : "no Shopify"} [${r.profile.shopifyHints.join("; ")}]`);
      console.log(`  Marca: ${r.profile.brandName ?? "—"} (${r.profile.brandNameSource ?? "sin fuente"}) · Facebook: ${r.profile.facebookUrls.join(", ") || "sin enlace"}`);
      console.log(`  Catálogo: ${r.catalog.status}${r.catalog.reason ? ` (${r.catalog.reason})` : ""} · ${r.catalog.products.length} productos${r.catalog.truncated ? " (truncado)" : ""} · ${r.requests} peticiones a la tienda`);
      for (const p of r.catalog.products.slice(0, 8)) console.log(`    · ${p.title} — ${eur(p.priceMin)}`);
      console.log("\n  (--solo-tienda: no se ha consultado la Ad Library)\n");
      if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(r, null, 2));
      return;
    }
    if (!token) {
      console.error("\n✗ Falta META_AD_LIBRARY_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN). Con --solo-tienda puedes leer solo la tienda.\n");
      process.exit(2);
    }
    const { runStoreAudit } = await import("../src/lib/hunter/audit/store-audit");
    const r = await runStoreAudit({ storeUrl: tienda, facebookUrl: arg("facebook") ?? null, pageId: arg("page-id") ?? null, token, country, days });
    pintarInforme(r);
    console.log(`\n  ${r.storeRequests} peticiones a la tienda · ${r.adLibrary.requests} a la Ad Library · ${r.elapsedSec} s\n`);
    if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(r, null, 2));
    return;
  }

  if (!token) {
    console.error("\n✗ Falta META_AD_LIBRARY_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN). Sin token no se busca nada.\n");
    process.exit(2);
  }
  const { runWinnerHunt } = await import("../src/lib/hunter/audit/winner-hunt");
  console.log(`\n──── AUDITOR · nicho "${nicho}" ────\n`);
  let ultimo = 0;
  const r = await runWinnerHunt({
    seed: nicho!,
    token,
    country,
    days,
    minutes: Number.parseInt(arg("minutos") ?? "", 10) || 15,
    onProgress: (p) => {
      if (p.auditando) console.log(`  Auditando ${p.auditsDone ?? 0}/${p.auditsTotal ?? "?"}: ${p.auditando}`);
      else if (p.fase === "buscando" && p.termsDone !== ultimo) {
        ultimo = p.termsDone;
        console.log(`  [${String(p.termsDone).padStart(2)}/${p.termsTotal}] "${p.term}" · ${p.ads} anuncios · ${p.requests} peticiones · quedan ${Math.floor(p.remainingSec / 60)} min`);
      }
    },
  });
  console.log(`\n  Búsqueda: ${r.search.termsQueried.length}/${r.search.terms.length} términos · ${r.search.rawAds} anuncios · ${r.search.requests} peticiones · parada ${r.search.stopReason}`);
  console.log(`  Reparto: ${r.budgetSplit.searchMinutes} min búsqueda / ${r.budgetSplit.auditMinutes} min auditorías · tope ${r.budgetSplit.maxAudits} auditorías`);
  console.log(`  Criterio: ${r.criterion}`);
  console.log(`  ${r.totalCompetitors} páginas anunciantes → ${r.candidates.length} candidata(s) · ${r.auditsRun} auditada(s) · parada ${r.stopReason}\n`);
  r.candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.pageName ?? c.pageId} · señal ${c.score.score} (${c.score.why}) · ${c.auditStatus}${c.storeUrl ? ` · ${c.storeUrl}` : ""}`);
    if (c.audit) pintarInforme(c.audit, "     ");
    console.log("");
  });
  if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(r, null, 2));
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
