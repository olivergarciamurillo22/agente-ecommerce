// ============================================================
// SONDA DEL NIVEL 2 (deep dive) — se ejecuta DONDE esté el token de la Ad
// Library (el NAS). docs/HUNTER-DEEP-DIVE.md
//
//   npm run hunter:deep-dive:probe -- --termino "cojin gel silla"
//   npm run hunter:deep-dive:probe -- --termino "cojin gel silla" --ad-id 1234567890123456
//   npm run hunter:deep-dive:probe -- ... --json /app/data/deep-dive-probe.json
//
// Cuatro comprobaciones con UN anuncio real, 4–5 peticiones en total, sin
// persistir nada:
//   1 · JSON CRUDO de /ads_archive para ese anuncio (¿trae URL de destino?).
//   2 · render_ad CON token (server-side): ¿carga? ¿muro de login? ¿enlaces
//       salientes → tienda? ¿imágenes / vídeos?
//   3 · ficha pública SIN token (facebook.com/ads/library/?id=…): ¿403 con
//       desafío? (esperado; no se esquiva).
//   4 · si hay tienda: ¿responde a una petición simple? ¿es Shopify? ¿precio?
//       ¿y la primera imagen del anuncio se descarga sin sesión?
//
// El token NUNCA sale en la salida: se recorta de cualquier URL. Respeta
// EMERGENCY_STOP como todo lo que sale a Internet.
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

async function main(): Promise<void> {
  const { canRunDiscovery } = await import("../src/lib/safety");
  const { ADLIB_FIELDS } = await import("../src/lib/hunter/discovery/types");
  const { META_ADS_DEFAULT_API_VERSION } = await import("../src/lib/meta-ads/config");
  const { renderAdUrl, parseRenderAdHtml, redactToken, DEEP_DIVE_USER_AGENT } = await import("../src/lib/hunter/deep-dive/render-ad");
  const { readStoreProfile } = await import("../src/lib/hunter/audit/store");

  const termino = arg("termino");
  const adIdPedido = arg("ad-id");
  if (!termino && !adIdPedido) { console.error('Uso: npm run hunter:deep-dive:probe -- --termino "cojin gel silla" [--ad-id N] [--pais ES] [--json informe.json]'); process.exit(2); }
  if (!canRunDiscovery()) { console.error("✗ EMERGENCY_STOP activo: la sonda no sale a Internet."); process.exit(2); }
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  if (!token) { console.error("✗ Falta META_AD_LIBRARY_ACCESS_TOKEN. Esta sonda se ejecuta donde esté el token (el NAS)."); process.exit(2); }
  const pais = (arg("pais") ?? "ES").toUpperCase();
  const version = process.env.META_AD_LIBRARY_API_VERSION || process.env.META_GRAPH_API_VERSION || process.env.META_ADS_API_VERSION || META_ADS_DEFAULT_API_VERSION;
  const informe: Record<string, unknown> = { fecha: new Date().toISOString(), termino, pais, version };
  const p = (s: string) => console.log(s);
  p(`\n──── SONDA DEEP DIVE · «${termino ?? adIdPedido}» · ${pais} ────\n`);

  // 1 · JSON crudo de /ads_archive.
  const url = new URL(`https://graph.facebook.com/${version}/ads_archive`);
  url.searchParams.set("search_terms", termino ?? "");
  url.searchParams.set("ad_reached_countries", JSON.stringify([pais]));
  url.searchParams.set("ad_type", "ALL"); url.searchParams.set("ad_active_status", "ACTIVE");
  url.searchParams.set("fields", ADLIB_FIELDS.join(",")); url.searchParams.set("limit", "5");
  const r1 = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const crudo = await r1.json() as { data?: Array<Record<string, unknown>>; error?: unknown };
  const anuncios = crudo.data ?? [];
  informe.paso1 = { http: r1.status, anunciosDevueltos: anuncios.length, error: crudo.error ?? null, camposDevueltos: anuncios[0] ? Object.keys(anuncios[0]) : [], camposPedidos: ADLIB_FIELDS, jsonCrudoPrimerAnuncio: anuncios[0] ? JSON.parse(redactToken(JSON.stringify(anuncios[0]))) : null };
  p(`1 · /ads_archive HTTP ${r1.status} · ${anuncios.length} anuncio(s)`);
  if (anuncios[0]) {
    p(`    campos devueltos: ${Object.keys(anuncios[0]).join(", ")}`);
    p(`    ¿algún campo con URL de destino?: ${Object.keys(anuncios[0]).some((k) => /link_url|website|landing|destination/i.test(k)) ? "SÍ" : "NO (solo captions con el dominio declarado, y ad_snapshot_url)"}`);
    p(`    JSON crudo (token recortado):\n${JSON.stringify(informe.paso1 && (informe.paso1 as { jsonCrudoPrimerAnuncio: unknown }).jsonCrudoPrimerAnuncio, null, 2).split("\n").map((l) => "      " + l).join("\n")}`);
  }
  const anuncio = anuncios.find((a) => !adIdPedido || String(a.id) === adIdPedido) ?? anuncios[0];
  if (!anuncio) { p("\n✗ Sin anuncio con el que seguir: la sonda para aquí."); escribir(informe); return; }
  const adId = String(anuncio.id);

  // 2 · render_ad con token.
  const r2 = await fetch(renderAdUrl(adId, token), { headers: { "user-agent": DEEP_DIVE_USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  const html2 = await r2.text();
  const parsed = parseRenderAdHtml(html2);
  informe.paso2 = { adId, http: r2.status, bytes: parsed.bytes, blocked: parsed.blocked, outboundHosts: parsed.outboundHosts, outboundUrls: parsed.outboundUrls.slice(0, 5), imagenes: parsed.imageUrls.length, videos: parsed.videoUrls.length, primeraImagen: parsed.imageUrls[0] ?? null, primerVideo: parsed.videoUrls[0] ?? null, textoVisible: parsed.visibleText };
  p(`\n2 · render_ad (con token) HTTP ${r2.status} · ${parsed.bytes} bytes · bloqueo: ${parsed.blocked ?? "ninguno"}`);
  p(`    destinos: ${parsed.outboundHosts.length ? parsed.outboundHosts.join(", ") : "NINGUNO en el HTML"}`);
  p(`    imágenes: ${parsed.imageUrls.length} · vídeos: ${parsed.videoUrls.length}`);
  p(`    texto visible: «${parsed.visibleText.slice(0, 200)}»`);

  // 3 · ficha pública sin token (esperado: 403 con desafío; no se esquiva).
  const r3 = await fetch(`https://www.facebook.com/ads/library/?id=${adId}`, { headers: { "user-agent": DEEP_DIVE_USER_AGENT, accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const html3 = await r3.text();
  const p3 = parseRenderAdHtml(html3);
  informe.paso3 = { http: r3.status, bytes: html3.length, blocked: p3.blocked, location: r3.headers.get("location") };
  p(`\n3 · ficha pública sin token HTTP ${r3.status} · ${html3.length} bytes · bloqueo: ${p3.blocked ?? "ninguno"}`);

  // 4 · tienda de destino e imagen.
  const destino = parsed.outboundUrls[0] ?? null;
  if (destino) {
    const perfil = await readStoreProfile(destino);
    let precio: unknown = null;
    const m = destino.match(/\/products\/([a-z0-9-]+)/i);
    if (m && perfil.profile.homepageStatus === "ok") {
      try {
        const rj = await fetch(`${perfil.profile.origin}/products/${m[1]}.js`, { headers: { "user-agent": DEEP_DIVE_USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        if (rj.ok) { const j = await rj.json() as { title?: string; price?: number; compare_at_price?: number | null; available?: boolean }; precio = { titulo: j.title, precioEur: typeof j.price === "number" ? j.price / 100 : null, antesEur: typeof j.compare_at_price === "number" ? j.compare_at_price / 100 : null, disponible: j.available ?? null, via: "/products/<handle>.js (público de Shopify)" }; }
        else precio = { via: "/products/<handle>.js", http: rj.status };
      } catch (e) { precio = { via: "/products/<handle>.js", error: e instanceof Error ? e.message : String(e) }; }
    }
    informe.paso4 = { destino, portada: perfil.profile.homepageStatus, motivo: perfil.profile.homepageReason, shopify: perfil.profile.isShopify, pistas: perfil.profile.shopifyHints, marca: perfil.profile.brandName, precio };
    p(`\n4 · tienda ${new URL(destino).hostname}: portada ${perfil.profile.homepageStatus}${perfil.profile.homepageReason ? ` (${perfil.profile.homepageReason})` : ""} · Shopify: ${perfil.profile.isShopify} · precio: ${JSON.stringify(precio)}`);
  } else {
    informe.paso4 = { destino: null, nota: "sin enlace saliente en render_ad: tienda no localizable automáticamente" };
    p(`\n4 · tienda: NO localizable automáticamente (render_ad no trajo enlace saliente)`);
  }
  if (parsed.imageUrls[0]) {
    try {
      const ri = await fetch(parsed.imageUrls[0], { method: "GET", headers: { "user-agent": DEEP_DIVE_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
      const buf = await ri.arrayBuffer();
      informe.imagen = { http: ri.status, contentType: ri.headers.get("content-type"), bytes: buf.byteLength };
      p(`    imagen del anuncio: HTTP ${ri.status} · ${ri.headers.get("content-type")} · ${buf.byteLength} bytes ${ri.ok && buf.byteLength > 1000 ? "→ descargable sin sesión" : "→ NO descargable"}`);
    } catch (e) { informe.imagen = { error: e instanceof Error ? e.message : String(e) }; p(`    imagen del anuncio: error ${e instanceof Error ? e.message : String(e)}`); }
  }
  escribir(informe);
  p("\n  Sonda terminada. Pega este JSON (ya sin token) en el chat.\n");

  function escribir(inf: Record<string, unknown>): void {
    const texto = redactToken(JSON.stringify(inf, null, 2));
    if (arg("json")) fs.writeFileSync(path.resolve(arg("json")!), texto);
    console.log(`\n──── INFORME JSON (token recortado) ────\n${texto}`);
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
