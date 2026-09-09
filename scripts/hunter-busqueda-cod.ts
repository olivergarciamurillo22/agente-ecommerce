// ============================================================
// hunter:busqueda-cod — BÚSQUEDA 3: caza directa de tiendas COD (10-09-2026)
// docs/HUNTER-DEEP-DIVE.md §Búsqueda 3
//
// FASE 1 (barata: ≤ frases × páginas peticiones, agrupa por tienda, NO audita):
//   npm run hunter:busqueda-cod                                  (13 frases COD × 5 páginas, ES, 180 días: ≤ 65 peticiones)
//   npm run hunter:busqueda-cod -- --frases "pago contra reembolso|paga al recibir" --paginas 3 --dias 90 --pais ES
//   npm run hunter:busqueda-cod -- --json barrido.json
//   npm run hunter:busqueda-cod -- --ver                         (último barrido persistido, sin red)
//
// FASE 2 (cara: radiografía ≤ 5 peticiones + deep dive por producto en Dropea; SIEMPRE lote explícito):
//   npm run hunter:busqueda-cod -- --auditar --ids <page_id1,page_id2>
//   npm run hunter:busqueda-cod -- --auditar --top 20              (los 20 primeros del último barrido AÚN NO auditados; máx. 30 por tanda)
//   opciones: --max-productos 4 · --sin-vision · --sin-video · --sin-probar-video · --sin-catalogo-sitio · --json informe.json
//   (el catálogo REAL del sitio se lee en fase 2: dominio del anuncio → /products.json, 2–4 peticiones HTTP por tienda;
//    si falla se sigue con el texto minado y se dice; perfil_tienda_cod_generica = veredicto a nivel de tienda)
//
// INFORME CONSOLIDADO (solo lectura, 0 peticiones): todas las tiendas auditadas, una fila por producto con
// señal fuerte sin proveedor o ganador_probable en Dropea, madurez del ángulo entre --min-dias y --max-dias:
//   npm run hunter:busqueda-cod -- --informe --min-dias 20 --max-dias 90 [--json informe.json]
//   npm run hunter:busqueda-cod -- --ver-tiendas                 (auditorías persistidas, sin red)
//   npm run hunter:busqueda-cod -- --ver-tienda <id>             (una auditoría entera, sin red)
//
// Nunca audita todas las tiendas del barrido de golpe. Respeta EMERGENCY_STOP.
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
type Sweep = import("../src/lib/hunter/deep-dive/cod-hunt").SweepResult;
type Audit = import("../src/lib/hunter/deep-dive/cod-hunt").StoreAudit;

function tablaBarrido(r: Sweep): void {
  console.log(`\n──── BARRIDO COD · ${r.country} · ${r.phrases.length} frase(s) · ${r.days} días · ≤ ${r.maxPages} páginas/frase · ${r.requests} peticiones · ${r.adsTotal} anuncios (${r.adsUnique} únicos) · ${r.stores.length} tiendas con la frase · ${r.storesWithoutEvidence} páginas sin la frase (fuera) ────\n`);
  for (const [f, s] of Object.entries(r.stopReasons)) if (s !== "completado") console.log(`  ⚠ «${f}»: parada por ${s}`);
  console.table(r.stores.slice(0, 80).map((s) => ({ page_id: s.pageId, tienda: (s.pageName ?? "—").slice(0, 28), activos: s.activeAds, encontrados: s.adsFound, "con frase": s.codAds, "activo desde": s.oldestActiveStart ?? "—", dias: s.oldestActiveDays ?? "—", prioridad: s.priority, dominio: s.domains[0] ?? "—", evidencia: (s.evidence?.quote ?? "").slice(0, 60) })));
  if (r.stores.length > 80) console.log(`  … y ${r.stores.length - 80} tiendas más (en --json)`);
  console.log(`\n  ${r.formula}`);
  console.log(`  Siguiente: npm run hunter:busqueda-cod -- --auditar --ids <page_id,…>  (o --top N con N pequeño)\n`);
}

function pintarTienda(titulo: string, a: Audit): void {
  const p = (s: string) => console.log("  " + s);
  console.log(`\n═══ ${titulo} ═══`);
  p("VEREDICTO POR TIENDA: " + a.summary);
  if (a.incomplete.length) { p("No se pudo completar:"); for (const i of a.incomplete) p(`  ✗ ${i.part}: ${i.reason}`); }
  if (a.account) {
    const x = a.account;
    p(`Cuenta «${x.pageName ?? a.pageId}» · anuncia desde ${x.firstAdStart ?? "?"} (${x.daysAdvertising ?? "?"} días) · ${x.totalAds} anuncios, ${x.activeAds} activos, ${x.inactiveAds} apagados · ${x.requests} petición(es)${x.truncated ? " · TRUNCADA" : ""}`);
    p(`  · ritmo de testeo: ${x.testing ? `${x.testing.level.toUpperCase()} (${x.testing.newAds30d} nuevos/30 d, ${x.testing.perWeek30d}/semana)` : "sin fechas"} · madurez del ángulo ganador: ${x.winner ? `${x.winner.label} ${x.winner.daysActive} días «${x.winner.quote}»` : "—"}`);
    p(`  · diversidad del catálogo: ${x.diversity.level.toUpperCase()} — ${x.diversity.note}`);
    p(`  · avatar: ${x.avatar.summary ?? "sin señales"}`);
  }
  p(`PERFIL DE TIENDA COD GENÉRICA: ${a.profile?.codGenerica ? "SÍ" : "NO"} — ${a.profile?.reason ?? "no calculado (auditoría anterior)"}`);
  if (a.profile?.diversity === "empresa_estructurada") p(`EMPRESA REAL/ESTRUCTURADA (baja prioridad, como marca propia) · señales: ${a.profile.company.signals.map((x) => `${x.label}: «${x.quote}» (${x.source})`).join(" · ")}`);
  else if (a.profile?.company.signals.length) p(`Señales de empresa (${a.profile.company.signals.length}, no llegan a 2 distintas o el catálogo no es disperso): ${a.profile.company.signals.map((x) => `${x.label}: «${x.quote.slice(0, 60)}»`).join(" · ")}`);
  if (a.siteCatalog) {
    p(`Catálogo real del sitio: ${a.siteCatalog.status === "ok" ? `${a.siteCatalog.domain} · ${a.siteCatalog.products} productos${a.siteCatalog.truncated ? "+" : ""}${a.siteCatalog.brand ? ` · marca ${a.siteCatalog.brand}` : ""}${a.siteCatalog.diversity ? ` · ${a.siteCatalog.diversity.level}` : ""} · ${a.siteCatalog.requests} peticiones` : (a.siteCatalog.reason ?? a.siteCatalog.status)}`);
    for (const it of a.siteCatalog.items.slice(0, 12)) p(`    · ${it.title.slice(0, 70)} · ${it.price !== null ? `${it.price} €` : "—"}${it.discountPct ? ` (antes ${it.compareAt} €, −${it.discountPct} %)` : ""}`);
    if (a.siteCatalog.items.length > 12) p(`    … y ${a.siteCatalog.items.length - 12} más`);
  }
  p(`Productos ganadores detectados (${a.products.length}):`);
  for (const x of a.products) {
    const pr = x.product;
    p(`  ■ ${x.realName ? `«${x.realName}»${x.siteMatch?.price !== null && x.siteMatch?.price !== undefined ? ` a ${x.siteMatch.price} €${x.siteMatch.discountPct ? ` (−${x.siteMatch.discountPct} %)` : ""}` : ""} (nombre real del sitio; anuncio: «${pr.label}»)` : `«${pr.label}»`} · ${pr.ads} activos · ${pr.longestActiveDays ?? "?"} días el más antiguo · tiene_video: ${x.video.status === "si" ? `sí (${x.video.withVideo} de ${x.video.checked} comprobados)` : x.video.status === "no" ? `no (${x.video.checked} comprobados)` : `no comprobado (${x.video.reason ?? "—"})`} · palabras: ${x.keywords.join(", ")} · ${pr.adLink}${x.video.status === "si" ? " ← con vídeo" : ""}`);
    if (x.deepDive) {
      const d = x.deepDive;
      p(`    EN DROPEA: «${x.dropea.match!.name}» (${x.dropea.match!.costEur !== null ? `${x.dropea.match!.costEur.toFixed(2)} €` : "sin coste"}) · gate: ${x.dropea.gate?.reason ?? "—"}`);
      p(`    DEEP DIVE: ${d.verdict.toUpperCase()} — ${d.reasoning}`);
      p(`    precio real ${d.priceEur ?? "—"} € · margen real ${d.marginPct !== null ? `${Math.round(d.marginPct * 100)} %` : "—"} · coherencia ${d.priceCoherence.status} · competencia ${d.competitors?.count ?? "no medida"} · creatividad ${d.creativeStatus} · vídeo ${d.videoStatus}`);
      p(`    RECOMENDACIÓN: ${x.recommendation.action.toUpperCase()} — ${x.recommendation.reason}`);
    } else {
      p(`    NO EN DROPEA${x.dropea.searched ? ` (buscado «${x.keywords.slice(0, 3).join(" ")}»: ${x.dropea.candidates.length} candidato(s)${x.dropea.gate ? `, mejor «${x.dropea.gate.found}»: ${x.dropea.gate.reason}` : ""})` : " (catálogo local no disponible)"}`);
      p(`    SEÑAL: ${x.signal!.verdict.toUpperCase()} — ${x.signal!.reason}`);
      p(`    RECOMENDACIÓN: ${x.recommendation.action.toUpperCase()} (sourcing ${x.recommendation.sourcing}) — ${x.recommendation.reason}`);
    }
  }
  p(`Reglas: ${a.rules}`);
  p(`Peticiones: ${a.requests}`);
}

async function main(): Promise<void> {
  const { canRunDiscovery } = await import("../src/lib/safety");
  const { CodHuntRepository } = await import("../src/lib/hunter/deep-dive/cod-repository");
  const repo = new CodHuntRepository();
  const pais = (arg("pais") ?? "ES").toUpperCase();

  if (hasFlag("ver")) {
    const s = repo.sweep({ id: arg("barrido") ? Number(arg("barrido")) : undefined, country: pais });
    if (!s?.result) { console.log("  (ningún barrido persistido todavía)"); return; }
    console.log(`  barrido #${s.id} del ${new Date(s.capturedAt * 1000).toISOString().slice(0, 16)}`);
    tablaBarrido(s.result);
    return;
  }
  if (hasFlag("ver-tiendas")) {
    const rows = repo.stores({ limit: Number.parseInt(arg("limite") ?? "", 10) || 50 });
    console.log(`\n──── TIENDAS COD AUDITADAS · ${rows.length} ────\n`);
    if (!rows.length) console.log("  (ninguna todavía)");
    console.table(rows.map((r) => ({ id: r.id, page_id: r.pageId, tienda: (r.pageName ?? "—").slice(0, 28), prioridad: r.priority ?? "—", "perfil COD": r.codGeneric ? "SÍ" : "no", productos: r.products, "en sitio": r.siteProducts ?? "—", "en Dropea": r.inDropea, "fuerte sin prov.": r.strongWithoutSupplier, catalogo: r.diversity ?? "—", fecha: new Date(r.capturedAt * 1000).toISOString().slice(0, 10) })));
    return;
  }
  if (hasFlag("informe")) {
    const { consolidatedReport, CONSOLIDATED_RULE } = await import("../src/lib/hunter/deep-dive/cod-hunt");
    const minDays = Number.parseInt(arg("min-dias") ?? "20", 10); const maxDays = Number.parseInt(arg("max-dias") ?? "90", 10);
    if (!Number.isFinite(minDays) || !Number.isFinite(maxDays) || minDays < 0 || maxDays < minDays) { console.error("✗ --min-dias y --max-dias deben ser enteros con min ≤ max"); process.exit(2); }
    const rows = repo.stores({ limit: 5000 }).filter((r) => r.audit).map((r) => ({ id: r.id, capturedAt: r.capturedAt, audit: r.audit! }));
    const filas = consolidatedReport(rows, { minDays, maxDays });
    const tiendasPerfil = new Set(filas.filter((f) => f.storeProfile).map((f) => f.pageId)).size;
    const soloPorPerfil = filas.filter((f) => f.verdict === "perfil_tienda_cod_generica").length;
    console.log(`\n──── INFORME CONSOLIDADO · ${rows.length} tienda(s) auditada(s) · madurez del ángulo entre ${minDays} y ${maxDays} días · ${filas.length} fila(s) · ${tiendasPerfil} tienda(s) con perfil COD genérico (${soloPorPerfil} entran SOLO por el perfil, antes no aparecían) · 0 peticiones ────\n`);
    if (!filas.length) console.log("  (ningún producto cumple el filtro)");
    console.table(filas.map((f) => ({ "perfil COD": f.storeProfile ? "SÍ" : "no", veredicto: f.verdict.replace(" (Dropea)", "").slice(0, 26), tienda: f.store.slice(0, 24), dominio: f.domain ?? "—", producto: f.product.slice(0, 36), video: f.hasVideo, dias: f.maturityDays, activos: f.activeAds, "en Dropea": f.inDropea ? `sí${f.marginPct !== null ? ` (margen ${Math.round(f.marginPct * 100)} %)` : ""}` : "no", catalogo: f.diversity, auditoria: f.auditedAt, "#": f.auditId })));
    for (const f of filas) console.log(`  ${f.store} · «${f.product}» · ${f.maturityDays} días · ${f.adLink}${f.hasVideo === "si" ? " ← vídeo" : ""}`);
    console.log(`\n  ${CONSOLIDATED_RULE}\n`);
    if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(filas, null, 2));
    return;
  }
  if (arg("ver-tienda")) {
    const r = repo.storeById(Number(arg("ver-tienda")));
    if (!r?.audit) { console.error("✗ no existe esa auditoría"); process.exit(2); }
    pintarTienda(`tienda #${r.id} (persistida el ${new Date(r.capturedAt * 1000).toISOString().slice(0, 16)})`, r.audit);
    return;
  }

  if (!canRunDiscovery()) { console.error("\n✗ EMERGENCY_STOP activo: la búsqueda COD no sale a Internet.\n"); process.exit(2); }
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  if (!token) { console.error("\n✗ Falta META_AD_LIBRARY_ACCESS_TOKEN. Esta búsqueda se ejecuta donde esté el token (el NAS).\n"); process.exit(2); }
  const { AdLibraryClient } = await import("../src/lib/hunter/discovery/client");
  const client = new AdLibraryClient(token);
  const now = Math.floor(Date.now() / 1000);

  if (!hasFlag("auditar")) {
    const { sweepCodStores, COD_PHRASES_DEFAULT } = await import("../src/lib/hunter/deep-dive/cod-hunt");
    const frases = arg("frases") ? arg("frases")!.split("|").map((f) => f.trim()).filter(Boolean) : COD_PHRASES_DEFAULT;
    console.log(`\n──── FASE 1 · barrido COD · ${pais} · ${frases.length} frases (≤ ${frases.length * (Number.parseInt(arg("paginas") ?? "", 10) || 5)} peticiones): ${frases.map((f) => `«${f}»`).join(", ")} ────`);
    const anterior = repo.sweep({ country: pais });
    const r = await sweepCodStores({ client, country: pais, phrases: frases, days: Number.parseInt(arg("dias") ?? "", 10) || undefined, maxPages: Number.parseInt(arg("paginas") ?? "", 10) || undefined, now, onPhrase: (f, ads, pages, stop) => console.log(`  «${f}»: ${ads} anuncios en ${pages} página(s) · ${stop}`) });
    const id = repo.insertSweep(r);
    tablaBarrido(r);
    if (anterior?.result) { const antes = new Set(anterior.result.stores.map((s) => s.pageId)); const nuevas = r.stores.filter((s) => !antes.has(s.pageId)); console.log(`  Respecto al barrido anterior #${anterior.id} (${anterior.result.stores.length} tiendas): ${nuevas.length} tienda(s) nueva(s)${nuevas.length ? `: ${nuevas.slice(0, 15).map((s) => s.pageName ?? s.pageId).join(", ")}${nuevas.length > 15 ? "…" : ""}` : ""}`); }
    console.log(`  Barrido persistido como #${id} (hunter_cod_sweeps). Ver: npm run hunter:busqueda-cod -- --ver\n`);
    if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(r, null, 2));
    return;
  }

  // FASE 2
  const { auditCodStore } = await import("../src/lib/hunter/deep-dive/cod-hunt");
  const { DropeaCatalogRepository } = await import("../src/lib/product-hunter/internal/dropea-catalog");
  const { makeOpenRouterVision } = await import("../src/lib/hunter/deep-dive/vision");
  const { makeVideoAnalysis, videoDailyLimit } = await import("../src/lib/hunter/deep-dive/video");
  const { makeAccountSummarizer } = await import("../src/lib/hunter/deep-dive/account-summary");
  const { systemDbHandle } = await import("../src/lib/db");
  const sweep = repo.sweep({ id: arg("barrido") ? Number(arg("barrido")) : undefined, country: pais });
  let pageIds: string[] = [];
  if (arg("ids")) pageIds = arg("ids")!.split(",").map((s) => s.trim()).filter(Boolean);
  else if (arg("top")) {
    const n = Number.parseInt(arg("top")!, 10);
    if (!Number.isFinite(n) || n < 1 || n > 30) { console.error("✗ --top admite de 1 a 30 por tanda (nunca todas las tiendas del barrido de golpe)"); process.exit(2); }
    if (!sweep?.result) { console.error("✗ no hay barrido persistido para --top: ejecuta antes la fase 1"); process.exit(2); }
    const { pickNextBatch } = await import("../src/lib/hunter/deep-dive/cod-hunt");
    const hechas = repo.auditedPageIds();
    const lote = pickNextBatch(sweep.result.stores, hechas, n);
    console.log(`  --top ${n}: ${sweep.result.stores.length} tiendas en el barrido #${sweep.id}, ${sweep.result.stores.filter((s) => hechas.has(s.pageId)).length} ya auditadas (se saltan), ${lote.length} en esta tanda`);
    pageIds = lote.map((s) => s.pageId);
  } else { console.error("✗ --auditar exige --ids <page_id,…> o --top N (≤ 10). Nunca todas las tiendas del barrido."); process.exit(2); }
  if (!pageIds.length) { console.log("  Nada que auditar con ese filtro."); return; }
  const dropea = new DropeaCatalogRepository();
  const hayDropea = dropea.count() > 0;
  const dropeaSearch = hayDropea ? (term: string) => dropea.search(term, { pageSize: 8 }).rows.map((r) => ({ variantId: r.variantId, name: r.productName ?? r.name ?? `variante ${r.variantId}`, costEur: r.costEur })) : null;
  const dropeaLookup = hayDropea ? (keywords: string[]) => dropea.search(keywords.join(" "), { pageSize: 5 }).rows.map((r) => ({ variantId: r.variantId, name: r.productName ?? r.name ?? `variante ${r.variantId}`, costEur: r.costEur })) : null;
  const vision = hasFlag("sin-vision") ? null : makeOpenRouterVision();
  const video = hasFlag("sin-video") ? null : makeVideoAnalysis();
  const videosHoy = () => { try { return Number((systemDbHandle().prepare("SELECT COUNT(*) AS n FROM hunter_deep_dives WHERE video_status = 'analizada_audio' AND captured_at >= ?").get(now - 86400) as { n: number }).n); } catch { return 0; } };
  console.log(`\n──── FASE 2 · auditoría de ${pageIds.length} tienda(s) · Dropea local: ${hayDropea ? `${dropea.count()} variantes` : "NO (nada se podrá casar)"} · visión ${vision ? "sí" : "no"} · vídeo ${video ? "sí" : "no"} ────`);
  const { DeepDiveRepository } = await import("../src/lib/hunter/deep-dive/repository");
  const ddRepo = new DeepDiveRepository();
  const informes: Array<{ id: number; audit: Audit }> = [];
  for (const pageId of pageIds) {
    if (!canRunDiscovery()) { console.error("\n✗ EMERGENCY_STOP activado a mitad: se para aquí, lo hecho queda.\n"); break; }
    const sw = sweep?.result?.stores.find((s) => s.pageId === pageId) ?? null;
    const a = await auditCodStore({ client, pageId, pageName: sw?.pageName ?? null, country: pais, now, sweep: sw, dropeaSearch, maxProducts: Number.parseInt(arg("max-productos") ?? "", 10) || 4, accountSummarize: makeAccountSummarizer(), deepDive: { token, vision, video, skipVideo: hasFlag("sin-video"), videoBudgetExhausted: videoDailyLimit() > 0 && videosHoy() >= videoDailyLimit(), dropeaLookup }, siteCatalog: !hasFlag("sin-catalogo-sitio"), probeVideo: !hasFlag("sin-probar-video"), maxVideoProbesPerProduct: Number.parseInt(arg("max-render") ?? "", 10) || 3 });
    if (!a.account) {
      console.log(`\n  ✗ ${sw?.pageName ?? pageId}: cuenta no leída (${a.incomplete.map((i) => i.reason).join("; ")}). NO se persiste: volverá a entrar en la siguiente tanda.`);
      if (/token|OAuth|permis/i.test(a.incomplete.map((i) => i.reason).join(" "))) { console.error("\n✗ Token o permisos: se para la tanda.\n"); break; }
      continue;
    }
    const id = repo.insertStore(a, sweep?.id ?? null);
    // Los productos que SÍ están en Dropea se guardan también como deep dives normales (misma tabla que las búsquedas 1 y 2).
    for (const x of a.products) if (x.deepDive && x.dropea.match) ddRepo.insert({ cruceId: null, variantId: x.dropea.match.variantId, adlibCandidateKey: `${pais}:${pageId}:cod`, adId: x.deepDive.adLink?.split("id=")[1] ?? null, keywords: x.deepDive.gate?.searched.split(" ") ?? x.keywords, report: x.deepDive, capturedAt: now });
    pintarTienda(`tienda ${sw?.pageName ?? pageId} (page ${pageId}) → auditoría #${id}`, a);
    informes.push({ id, audit: a });
  }
  console.log(`\n  ${informes.length} auditoría(s) persistida(s) en hunter_cod_stores. Ver: npm run hunter:busqueda-cod -- --ver-tiendas\n`);
  if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), JSON.stringify(informes, null, 2));
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
