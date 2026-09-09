// ============================================================
// hunter:deep-dive — NIVEL 2 del Cazador, candidato a candidato
// docs/HUNTER-DEEP-DIVE.md
//
//   npm run hunter:deep-dive -- --ids 12,45,78                 (cruces concretos, por id de hunter_cruces)
//   npm run hunter:deep-dive -- --min-score 60 --limite 5      (los N mejores cruces con match, aún sin deep dive)
//   npm run hunter:deep-dive -- --dominio cloudcore.es --palabras "cojin gel silla" --coste 9.5
//                                                             (modo manual: sin base del cruce; datos reales de la tienda)
//   BÚSQUEDA 2 (otros países): los cruces hechos con --pais IT llevan su país; el deep dive busca en ese país
//   y COMPRUEBA ESPAÑA obligatoriamente (misma búsqueda por palabra en español con ad_reached_countries=ES).
//   npm run hunter:deep-dive -- --ids 301,302                  (cruce en IT → informe con «competencia en España»)
//   npm run hunter:deep-dive -- --dominio x.it --palabras "cuscino gel sedia" --palabras-es "cojin gel silla" --pais IT --page-id N
//   opciones: --sin-vision · --sin-video · --sin-cuenta · --sin-busqueda · --page-id N (manual)
//             --json informe.json · --ver (lista lo persistido, sin red) · --ver-id N (un informe entero, sin red)
//
// NUNCA recorre el catálogo entero: exige --ids, --min-score+--limite o
// --dominio. Por candidato: 1 petición de búsqueda por palabra (saturación),
// 1 por cada 100 anuncios de la cuenta (tope 5), 2–4 a la tienda, 0–1 a
// render_ad, 0–1 imagen, 0–1 vídeo (fbcdn), 0–2 a OpenRouter, 0–1 a OpenAI
// (solo transcripción del vídeo). Respeta EMERGENCY_STOP.
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
  if (r.earlyExit) {
    // Corte temprano: corto y distinto a un informe completo, porque el resto NO se ejecutó.
    console.log(`\n─── ${titulo} · SKIP_NO_MATCH (corte temprano, no es un veredicto) ───`);
    p(`Tienda: ${r.domain ?? "no localizable"} · catálogo ${r.catalog ? `${r.catalog.status}, ${r.catalog.products} productos` : "no leído"}`);
    p(`Buscaba: «${r.gate?.searched ?? "?"}»`);
    p(`Encontró: ${r.gate?.found ? `«${r.gate.found}»` : "nada que case"} · cobertura ${Math.round((r.gate?.coverage ?? 0) * 100)} %${r.gate?.missing.length ? ` · faltan: ${r.gate.missing.join(", ")}` : ""}`);
    p(`Motivo del corte: ${r.earlyExit.reason}`);
    p(`No ejecutado (ahorro): ${r.earlyExit.skipped.join(", ")} · peticiones gastadas: ${r.requests}`);
    if (r.adLink) p(`Anuncio: ${r.adLink}`);
    return;
  }
  console.log(`\n═══ ${titulo} ═══`);
  p(`VEREDICTO: ${r.verdict.toUpperCase()} — ${r.reasoning}`);
  p(`RECOMENDACIÓN: ${r.recommendation.action.toUpperCase()} — ${r.recommendation.reason}`);
  if (r.adLink) p(`Anuncio (comprobar a mano): ${r.adLink}`);
  if (r.spainCheck) p(`COMPETENCIA EN ESPAÑA: ${r.spainCheck.verified ? `${r.spainCheck.activeAds} anuncios activos (verificado)` : "NO VERIFICADA"} · oportunidad: ${r.opportunity.toUpperCase()} · ${r.spainCheck.basis}${r.spainCheck.reason ? ` · ${r.spainCheck.reason}` : ""}`);
  for (const c of r.spainCheck?.pages.slice(0, 5) ?? []) p(`  · ES · ${c.pageName ?? c.pageId}: ${c.activeAds} activos, match ${c.verdict} (${Math.round(c.coverage * 100)} %)${c.adLink ? ` · ${c.adLink}` : ""}`);
  if (r.country !== "ES") p(`País de la búsqueda: ${r.country}`);
  p("");
  p("EN CLARO: " + r.summary);
  p("");
  if (r.incomplete.length) { p("No se pudo completar:"); for (const i of r.incomplete) p(`  ✗ ${i.part}: ${i.reason}`); }
  p(`Tienda: ${r.domain ?? "no localizable"}${r.domainSource ? ` (${r.domainSource})` : ""}${r.store ? ` · portada ${r.store.status} · ${r.store.isShopify ? "Shopify" : "no Shopify"}${r.store.brand ? ` · ${r.store.brand}` : ""}` : ""}`);
  p(`Catálogo: ${r.catalog ? `${r.catalog.status} · ${r.catalog.products} productos${r.catalog.truncated ? "+" : ""}` : "no leído"}`);
  if (r.match) p(`Producto: «${r.match.product.title}» (match ${r.match.verdict}, cobertura ${Math.round(r.match.coverage * 100)} %) · ${r.match.product.url}`);
  p(`Precio real: ${eur(r.priceEur)}${r.priceMaxEur !== null && r.priceMaxEur !== r.priceEur ? ` – ${eur(r.priceMaxEur)}` : ""} · coste Dropea: ${eur(r.costEur)} · margen real: ${eur(r.marginEur)} (${pct(r.marginPct)})`);
  p(`Anuncios del producto: ${r.activeAds ?? "?"} activos · ${r.daysActive ?? "?"} días el más antiguo`);
  if (r.account) {
    const a = r.account;
    p(`Cuenta completa ${a.pageName ? `«${a.pageName}» ` : ""}(page ${a.pageId}) · ${a.requests} petición(es), ${a.pages} página(s)${a.truncated ? " · TRUNCADA: cota inferior" : ""}:`);
    p(`  · anuncia desde: ${a.firstAdStart ?? "?"}${a.daysAdvertising !== null ? ` (${a.daysAdvertising} días)` : ""} · activo más antiguo desde ${a.oldestActiveStart ?? "—"}`);
    p(`  · anuncios: ${a.totalAds} en total · ${a.activeAds} activos ahora · ${a.inactiveAds} apagados`);
    if (a.angles.length) { p("  · ángulos de la cuenta (activo más antiguo primero = ganadores):"); for (const g of a.angles.slice(0, 5)) p(`      ${g.label}: ${g.ads} anuncios, ${g.activeAds} activos${g.longestActiveDays !== null ? `, el más longevo ${g.longestActiveDays} días (desde ${g.oldestActiveStart})` : ", ninguno activo"}${g.evidence ? ` — «${g.evidence.quote}»` : ""}`); }
    else p("  · ángulos: ninguno clasificado por texto");
    p(`  · avatar consolidado${a.avatar.summarySource ? ` (${a.avatar.summarySource})` : ""}: ${a.avatar.summary ?? "sin señales de avatar en el texto"}`);
    for (const s of a.avatar.signals.slice(0, 3)) p(`      ${s.label}: ${s.ads} anuncios — «${s.evidence.quote}»`);
    p(`  · ritmo de testeo de la cuenta: ${a.testing ? `${a.testing.level.toUpperCase()} · ${a.testing.newAds30d} anuncios nuevos en 30 días (${a.testing.perWeek30d}/semana), ${a.testing.newAds90d} en 90` : "sin fechas"}`);
    p(`  · madurez del ángulo ganador: ${a.winner ? `${a.winner.label} · ${a.winner.daysActive} días activo sin cambios (desde ${a.winner.since}) · «${a.winner.quote}» · ${a.winner.adLink}` : "ningún ángulo activo clasificado"}`);
    p(`  · productos distintos entre los activos (agrupación por texto): ${a.products.length}`);
    p(`  · diversidad del catálogo: ${a.diversity.level.toUpperCase()} — ${a.diversity.note}`);
    if (r.gate) p(`Gate de producto: pasó — ${r.gate.reason}`);
  }
  if (r.competitors) {
    p(`Competencia: ${r.competitors.count} tienda(s) más anunciando lo mismo ahora · ${r.competitors.basis}`);
    for (const c of r.competitors.pages.slice(0, 5)) p(`  · ${c.pageName ?? c.pageId}: ${c.activeAds} activos, match ${c.verdict} (${Math.round(c.coverage * 100)} %)${c.adLink ? ` · ${c.adLink}` : ""}`);
  }
  p(`Coherencia de precio: ${r.priceCoherence.status.toUpperCase()} — ${r.priceCoherence.note}`);
  if (r.otherProducts.length) {
    p("Otros posibles ganadores detectados en esta misma tienda (activos, sin peticiones extra):");
    for (const o of r.otherProducts) p(`  · «${o.label}» · ${o.ads} anuncio(s) · ${o.longestActiveDays ?? "?"} días el más antiguo · palabras: ${o.keywords.join(", ")} · Dropea: ${o.dropea.searched ? (o.dropea.matches.length ? o.dropea.matches.map((m) => `${m.name}${m.costEur !== null ? ` (${m.costEur.toFixed(2)} €)` : ""}`).join("; ") : "no encontrado") : "no buscado"} · ${o.adLink}`);
  }
  if (r.angles && r.angles.angles.length) { p("Ángulos del texto del anuncio (cita literal):"); for (const a of r.angles.angles.slice(0, 6)) p(`  · ${a.label}: «${a.evidence[0]?.quote ?? ""}»`); }
  p(`Creatividad (imagen): ${r.creativeStatus}${r.creative ? ` (${r.creative.model})` : ""}`);
  if (r.creative) { for (const [k, v] of Object.entries({ gancho: r.creative.hook, angulo: r.creative.angle, dolor: r.creative.pain, deseo: r.creative.desire, avatar: r.creative.avatar, "precio visible": r.creative.visiblePrice })) if (v) p(`  · ${k}: ${v}`); }
  p(`Vídeo: ${r.videoStatus}${r.video ? ` (${r.video.transcribeModel}${r.video.interpretModel ? ` + ${r.video.interpretModel}` : ""}) · ${r.video.durationSec ?? "?"} s · ${r.video.wordsPerMinute ?? "?"} palabras/min · idioma ${r.video.language ?? "?"}` : ""}`);
  if (r.video) {
    p(`  · gancho (primeros 5 s): «${r.video.hookFirstSeconds ?? "—"}»`);
    if (r.video.interpretation) { for (const [k, v] of Object.entries({ angulo: r.video.interpretation.angle, dolor: r.video.interpretation.pain, deseo: r.video.interpretation.desire, avatar: r.video.interpretation.avatar, cta: r.video.interpretation.cta, ritmo: r.video.interpretation.rhythm })) if (v) p(`  · ${k}: ${v}`); }
    p(`  · guion: «${r.video.transcript.slice(0, 400)}${r.video.transcript.length > 400 ? "…" : ""}»`);
    p(`  · límite: ${r.video.limits}`);
  }
  p(`Reglas: ${r.rules}`);
}

async function main(): Promise<void> {
  const { canRunDiscovery } = await import("../src/lib/safety");
  const { runDeepDive } = await import("../src/lib/hunter/deep-dive/deep-dive");
  const { DeepDiveRepository } = await import("../src/lib/hunter/deep-dive/repository");
  const { makeOpenRouterVision, visionAvailable, visionModel } = await import("../src/lib/hunter/deep-dive/vision");
  const { productKeywords, CruceRepository } = await import("../src/lib/product-hunter/internal/cruce");
  const { AdLibraryClient } = await import("../src/lib/hunter/discovery/client");
  const { makeAccountSummarizer } = await import("../src/lib/hunter/deep-dive/account-summary");
  const { makeVideoAnalysis, videoAvailable, videoDailyLimit, transcribeModel } = await import("../src/lib/hunter/deep-dive/video");
  const { DropeaCatalogRepository } = await import("../src/lib/product-hunter/internal/dropea-catalog");
  const { systemDbHandle } = await import("../src/lib/db");
  const repo = new DeepDiveRepository();
  const now = Math.floor(Date.now() / 1000);

  if (arg("ver-id")) {
    const fila = repo.byId(Number(arg("ver-id")));
    if (!fila) { console.error("✗ no existe ese deep dive"); process.exit(2); }
    if (fila.report) pintar(`deep dive #${fila.id} (persistido el ${new Date(fila.capturedAt * 1000).toISOString().slice(0, 16)})`, fila.report);
    else console.log(`  deep dive #${fila.id}: ${fila.verdict} — ${fila.reasoning} (informe anterior al pipeline completo: sin report_json)`);
    return;
  }
  if (hasFlag("ver")) {
    const rows = repo.latest({ limit: Number.parseInt(arg("limite") ?? "", 10) || 50 });
    console.log(`\n──── DEEP DIVES PERSISTIDOS · ${rows.length} ────\n`);
    if (!rows.length) console.log("  (ninguno todavía)");
    console.table(rows.map((r) => ({ id: r.id, veredicto: r.verdict, tienda: r.domain ?? "—", producto: (r.matchedTitle ?? "—").slice(0, 36), precio: eur(r.priceEur), coste: eur(r.costEur), "margen real": pct(r.marginPct), activos: r.activeAds ?? "—", dias: r.daysActive ?? "—", creatividad: r.creativeStatus, "cuenta desde": r.account?.firstAdStart ?? "—", "cuenta activos": r.account ? `${r.account.activeAds}/${r.account.totalAds}` : "—", recomendacion: r.earlyExit ? "SKIP_NO_MATCH" : (r.recommendation ?? "—"), competencia: r.competitors ?? "—", "otros prod.": r.otherProducts ?? "—", video: r.videoStatus ?? "—", pais: r.country ?? "ES", "ES activos": r.spainActiveAds ?? (r.country && r.country !== "ES" ? "no verif." : "—"), oportunidad: r.opportunity ?? "—" })));
    return;
  }
  if (!canRunDiscovery()) { console.error("\n✗ EMERGENCY_STOP activo: el deep dive no sale a Internet.\n"); process.exit(2); }

  const sinVision = hasFlag("sin-vision");
  const disp = visionAvailable();
  const vision = sinVision ? null : makeOpenRouterVision();
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim() || null;
  const sinCuenta = hasFlag("sin-cuenta");
  const client = token && !sinCuenta ? new AdLibraryClient(token) : null;
  const accountSummarize = sinCuenta ? null : makeAccountSummarizer();
  const sinVideo = hasFlag("sin-video");
  const dispVideo = videoAvailable();
  const video = sinVideo ? null : makeVideoAnalysis();
  const sinBusqueda = hasFlag("sin-busqueda");
  const dropea = new DropeaCatalogRepository();
  const dropeaLookup = (keywords: string[]) => { try { return dropea.search(keywords.join(" "), { pageSize: 5 }).rows.map((r) => ({ variantId: r.variantId, name: r.productName ?? r.name ?? `variante ${r.variantId}`, costEur: r.costEur })); } catch { return []; } };
  const videosHoy = () => { try { return Number((systemDbHandle().prepare("SELECT COUNT(*) AS n FROM hunter_deep_dives WHERE video_status = 'analizada_audio' AND captured_at >= ?").get(now - 86400) as { n: number }).n); } catch { return 0; } };
  console.log(`\n──── DEEP DIVE · visión: ${sinVision ? "desactivada (--sin-vision)" : disp.ok ? `OpenRouter ${visionModel()}` : disp.reason} · cuenta: ${sinCuenta ? "omitida (--sin-cuenta)" : client ? `search_page_ids, activos+inactivos${accountSummarize ? ", avatar por Claude" : ", avatar heurístico"}` : "sin token de la Ad Library"} · vídeo: ${sinVideo ? "desactivado (--sin-video)" : dispVideo.ok ? `OpenAI ${transcribeModel()} (solo audio), tope ${videoDailyLimit()}/día` : dispVideo.reason} · búsqueda por palabra: ${sinBusqueda ? "no (--sin-busqueda)" : client ? "sí (saturación cruzada)" : "sin token"} ────`);

  // Trabajos: manual, por ids o por score.
  type Trabajo = { titulo: string; cruceId: number | null; variantId: number | null; candidateKey: string | null; keywords: string[]; ads: import("../src/lib/hunter/discovery/types").AdLibraryAd[]; costEur: number | null; activeAds: number | null; oldestActiveAt: number | null; domainOverride: string | null; pageId: string | null; country: string; spainKeywords: string[] };
  const trabajos: Trabajo[] = [];
  if (arg("dominio")) {
    const palabras = arg("palabras");
    if (!palabras) { console.error("✗ --dominio exige --palabras \"…\""); process.exit(2); }
    const coste = arg("coste") !== undefined ? Number(String(arg("coste")).replace(",", ".")) : null;
    trabajos.push({ titulo: `manual · ${arg("dominio")} · «${palabras}»`, cruceId: null, variantId: null, candidateKey: null, keywords: productKeywords(palabras), ads: [], costEur: Number.isFinite(coste as number) ? coste : null, activeAds: Number.parseInt(arg("activos") ?? "", 10) || null, oldestActiveAt: null, domainOverride: arg("dominio")!, pageId: arg("page-id") ?? null, country: (arg("pais") ?? "ES").toUpperCase(), spainKeywords: arg("palabras-es") ? productKeywords(arg("palabras-es")!) : [] });
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
    for (const c of filas) trabajos.push({ titulo: `cruce #${c.id} · ${c.productName ?? "?"}`, cruceId: c.id, variantId: c.variantId, candidateKey: c.adlibCandidateKey, keywords: c.terms, ads: c.adlibCandidateKey ? repo.adsForCandidateKey(c.adlibCandidateKey) : [], costEur: c.costEur, activeAds: c.activeAds, oldestActiveAt: c.oldestActiveAt, domainOverride: null, pageId: null, country: (arg("pais") ?? c.country).toUpperCase(), spainKeywords: c.breakdown.keywordsOriginal ?? (c.productName ? productKeywords(c.productName) : c.terms) });
    // page_id: del snapshot si lo hay; si no, de la clave del candidato («ES:<page_id>:<huella>»); si no, lo trae la búsqueda por palabra.
    for (const t of trabajos) t.pageId = t.ads.find((a) => a.pageId)?.pageId ?? (t.candidateKey?.split(":")[1] || null);
  }

  const informes: Array<{ id: number; titulo: string; report: Informe }> = [];
  for (const t of trabajos) {
    if (!canRunDiscovery()) { console.error("\n✗ EMERGENCY_STOP activado a mitad: se para aquí, lo hecho queda.\n"); break; }
    const report = await runDeepDive({ keywords: t.keywords, ads: t.ads, costEur: t.costEur, activeAds: t.activeAds, oldestActiveAt: t.oldestActiveAt, now, token, vision, video, skipVideo: sinVideo, videoBudgetExhausted: videoDailyLimit() > 0 && videosHoy() >= videoDailyLimit(), domainOverride: t.domainOverride, client, pageId: t.pageId, country: t.country, search: !sinBusqueda, accountSummarize, skipAccount: sinCuenta, dropeaLookup, spainKeywords: t.spainKeywords });
    const id = repo.insert({ cruceId: t.cruceId, variantId: t.variantId, adlibCandidateKey: t.candidateKey, adId: report.adLink ? report.adLink.split("id=")[1] : (t.ads[0]?.id ?? null), keywords: t.keywords, report, capturedAt: now });
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
