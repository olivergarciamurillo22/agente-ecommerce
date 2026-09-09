// ============================================================
// hunter:deep-dive — NIVEL 2 del Cazador, candidato a candidato
// docs/HUNTER-DEEP-DIVE.md
//
//   npm run hunter:deep-dive -- --ids 12,45,78                 (cruces concretos, por id de hunter_cruces)
//   npm run hunter:deep-dive -- --min-score 60 --limite 5      (los N mejores cruces con match, aún sin deep dive)
//   npm run hunter:deep-dive -- --dominio cloudcore.es --palabras "cojin gel silla" --coste 9.5
//                                                             (modo manual: sin base del cruce; datos reales de la tienda)
//   opciones: --sin-vision · --json informe.json · --ver (lista lo persistido, sin red)
//
// NUNCA recorre el catálogo entero: exige --ids, --min-score+--limite o
// --dominio. Por candidato: 2–4 peticiones a la tienda, 0–1 a render_ad
// (solo con visión), 0–1 a OpenRouter. Respeta EMERGENCY_STOP.
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
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)} %`);

type Informe = import("../src/lib/hunter/deep-dive/deep-dive").DeepDiveReport;

function pintar(titulo: string, r: Informe): void {
  const p = (s: string) => console.log("  " + s);
  console.log(`\n═══ ${titulo} ═══`);
  p(`VEREDICTO: ${r.verdict.toUpperCase()} — ${r.reasoning}`);
  if (r.incomplete.length) { p("No se pudo completar:"); for (const i of r.incomplete) p(`  ✗ ${i.part}: ${i.reason}`); }
  p(`Tienda: ${r.domain ?? "no localizable"}${r.domainSource ? ` (${r.domainSource})` : ""}${r.store ? ` · portada ${r.store.status} · ${r.store.isShopify ? "Shopify" : "no Shopify"}${r.store.brand ? ` · ${r.store.brand}` : ""}` : ""}`);
  p(`Catálogo: ${r.catalog ? `${r.catalog.status} · ${r.catalog.products} productos${r.catalog.truncated ? "+" : ""}` : "no leído"}`);
  if (r.match) p(`Producto: «${r.match.product.title}» (match ${r.match.verdict}, cobertura ${Math.round(r.match.coverage * 100)} %) · ${r.match.product.url}`);
  p(`Precio real: ${eur(r.priceEur)}${r.priceMaxEur !== null && r.priceMaxEur !== r.priceEur ? ` – ${eur(r.priceMaxEur)}` : ""} · coste Dropea: ${eur(r.costEur)} · margen real: ${eur(r.marginEur)} (${pct(r.marginPct)})`);
  p(`Anuncios: ${r.activeAds ?? "?"} activos · ${r.daysActive ?? "?"} días el más antiguo`);
  if (r.angles && r.angles.angles.length) { p("Ángulos del texto del anuncio (cita literal):"); for (const a of r.angles.angles.slice(0, 6)) p(`  · ${a.label}: «${a.evidence[0]?.quote ?? ""}»`); }
  p(`Creatividad: ${r.creativeStatus}${r.creative ? ` (${r.creative.model})` : ""}`);
  if (r.creative) { for (const [k, v] of Object.entries({ gancho: r.creative.hook, angulo: r.creative.angle, dolor: r.creative.pain, deseo: r.creative.desire, avatar: r.creative.avatar, "precio visible": r.creative.visiblePrice })) if (v) p(`  · ${k}: ${v}`); }
  p(`Reglas: ${r.rules}`);
}

async function main(): Promise<void> {
  const { canRunDiscovery } = await import("../src/lib/safety");
  const { runDeepDive } = await import("../src/lib/hunter/deep-dive/deep-dive");
  const { DeepDiveRepository } = await import("../src/lib/hunter/deep-dive/repository");
  const { makeOpenRouterVision, visionAvailable, visionModel } = await import("../src/lib/hunter/deep-dive/vision");
  const { productKeywords, CruceRepository } = await import("../src/lib/product-hunter/internal/cruce");
  const repo = new DeepDiveRepository();
  const now = Math.floor(Date.now() / 1000);

  if (hasFlag("ver")) {
    const rows = repo.latest({ limit: Number.parseInt(arg("limite") ?? "", 10) || 50 });
    console.log(`\n──── DEEP DIVES PERSISTIDOS · ${rows.length} ────\n`);
    if (!rows.length) console.log("  (ninguno todavía)");
    console.table(rows.map((r) => ({ id: r.id, veredicto: r.verdict, tienda: r.domain ?? "—", producto: (r.matchedTitle ?? "—").slice(0, 36), precio: eur(r.priceEur), coste: eur(r.costEur), "margen real": pct(r.marginPct), activos: r.activeAds ?? "—", dias: r.daysActive ?? "—", creatividad: r.creativeStatus })));
    return;
  }
  if (!canRunDiscovery()) { console.error("\n✗ EMERGENCY_STOP activo: el deep dive no sale a Internet.\n"); process.exit(2); }

  const sinVision = hasFlag("sin-vision");
  const disp = visionAvailable();
  const vision = sinVision ? null : makeOpenRouterVision();
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim() || null;
  console.log(`\n──── DEEP DIVE · visión: ${sinVision ? "desactivada (--sin-vision)" : disp.ok ? `OpenRouter ${visionModel()}` : disp.reason} ────`);

  // Trabajos: manual, por ids o por score.
  type Trabajo = { titulo: string; cruceId: number | null; variantId: number | null; candidateKey: string | null; keywords: string[]; ads: import("../src/lib/hunter/discovery/types").AdLibraryAd[]; costEur: number | null; activeAds: number | null; oldestActiveAt: number | null; domainOverride: string | null };
  const trabajos: Trabajo[] = [];
  if (arg("dominio")) {
    const palabras = arg("palabras");
    if (!palabras) { console.error("✗ --dominio exige --palabras \"…\""); process.exit(2); }
    const coste = arg("coste") !== undefined ? Number(String(arg("coste")).replace(",", ".")) : null;
    trabajos.push({ titulo: `manual · ${arg("dominio")} · «${palabras}»`, cruceId: null, variantId: null, candidateKey: null, keywords: productKeywords(palabras), ads: [], costEur: Number.isFinite(coste as number) ? coste : null, activeAds: Number.parseInt(arg("activos") ?? "", 10) || null, oldestActiveAt: null, domainOverride: arg("dominio")! });
  } else {
    const cruces = new CruceRepository();
    let filas: Array<import("../src/lib/product-hunter/internal/cruce").CruceRow> = [];
    if (arg("ids")) filas = arg("ids")!.split(",").map((s) => cruces.byId(Number(s.trim()))).filter((x): x is NonNullable<typeof x> => Boolean(x));
    else if (arg("min-score")) {
      const min = Number(arg("min-score")); const limite = Number.parseInt(arg("limite") ?? "", 10) || 5;
      const hechos = new Set(repo.latest({ limit: 5000 }).map((d) => d.variantId));
      filas = cruces.latest({ limit: 5000 }).filter((c) => c.match !== "no" && (c.score ?? 0) >= min && !hechos.has(c.variantId)).slice(0, limite);
    } else { console.error("✗ Indica --ids 1,2,3 · --min-score N --limite M · o --dominio X --palabras \"…\". Nunca el catálogo entero."); process.exit(2); }
    if (!filas.length) { console.log("  Nada que analizar con ese filtro."); return; }
    for (const c of filas) trabajos.push({ titulo: `cruce #${c.id} · ${c.productName ?? "?"}`, cruceId: c.id, variantId: c.variantId, candidateKey: c.adlibCandidateKey, keywords: c.terms, ads: c.adlibCandidateKey ? repo.adsForCandidateKey(c.adlibCandidateKey) : [], costEur: c.costEur, activeAds: c.activeAds, oldestActiveAt: c.oldestActiveAt, domainOverride: null });
  }

  const informes: Array<{ id: number; titulo: string; report: Informe }> = [];
  for (const t of trabajos) {
    if (!canRunDiscovery()) { console.error("\n✗ EMERGENCY_STOP activado a mitad: se para aquí, lo hecho queda.\n"); break; }
    const report = await runDeepDive({ keywords: t.keywords, ads: t.ads, costEur: t.costEur, activeAds: t.activeAds, oldestActiveAt: t.oldestActiveAt, now, token, vision, domainOverride: t.domainOverride });
    const id = repo.insert({ cruceId: t.cruceId, variantId: t.variantId, adlibCandidateKey: t.candidateKey, adId: t.ads[0]?.id ?? null, keywords: t.keywords, report, capturedAt: now });
    pintar(`${t.titulo} → deep dive #${id}`, report);
    informes.push({ id, titulo: t.titulo, report });
  }
  console.log(`\n  ${informes.length} informe(s) persistido(s) en hunter_deep_dives. Ver: npm run hunter:deep-dive -- --ver\n`);
  if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(informes, null, 2));
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
