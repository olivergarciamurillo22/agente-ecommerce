// ============================================================
// MODO A · AUDITORÍA DE UNA TIENDA (07-09-2026) — docs/HUNTER-AUDITOR.md
//
// Dada la URL de una tienda: qué vende (catálogo público si es Shopify),
// cuántos anuncios activos tiene en la Ad Library y desde cuándo, y qué
// ángulos usa, citando el texto real del anuncio como evidencia.
//
// CÓMO SE ENCUENTRAN SUS ANUNCIOS, y por qué así: la Ad Library busca por
// texto o por page_id NUMÉRICO. De una web solo se saca el nombre de la
// marca y, a veces, un enlace facebook.com/<nombre>, que es un alias, no el
// número. Convertir el alias en número exige raspar Facebook (prohibido por
// las reglas del repo) o un token de página que no tenemos. Así que se busca
// por el nombre de la marca y se casa por dos vías honestas: que el
// anunciante se llame como la marca, o que el dominio declarado en sus
// anuncios sea el de la tienda. Lo que no casa por ninguna de las dos, no se
// atribuye.
//
// LÍMITE que conviene saber: search_terms busca en el TEXTO del anuncio, no en
// el nombre del anunciante. Un anuncio de la marca que no la mencione en el
// cuerpo, título o caption no aparecerá. La vía exacta es el page_id numérico:
// si el usuario lo pega (Transparencia de la página, o la URL de la Ad Library
// con view_all_page_id=…), se consulta por search_page_ids. Ese parámetro no
// se ha probado nunca en vivo en este repo: se declara.
//
// Todo lo que no se pudo completar se devuelve en `incomplete`, con motivo.
// ============================================================

import { AdLibraryClient } from "../discovery/client";
import { DiscoveryBudget, type StopReason } from "../discovery/budget";
import { DiscoveryHaltedError, asAdLibraryError } from "../discovery/errors";
import { groupAds } from "../discovery/grouping";
import { competitorSignals, declaredDomains, type CompetitorReport } from "../discovery/signals";
import type { AdLibraryAd, DiscoveryGroup } from "../discovery/types";
import { canRunDiscovery } from "../../safety";
import { computeMomentum } from "../discovery/momentum";
import { extractAngles, type AngleReport } from "./angles";
import { readStore, normalizeStoreUrl, type StoreCatalog, type StoreProfile } from "./store";

export interface CatalogSummary {
  status: StoreCatalog["status"];
  reason: string | null;
  products: number;
  truncated: boolean;
  priceMin: number | null;
  priceMax: number | null;
  /** Tipos de producto más repetidos, con cuántos hay de cada uno. */
  topTypes: Array<{ type: string; count: number }>;
  /** Proveedores (vendor) más repetidos: en dropshipping delatan la fuente. */
  topVendors: Array<{ vendor: string; count: number }>;
  sample: Array<{ title: string; price: number | null; url: string }>;
}

export interface FacebookResolution {
  urls: string[];
  /** De dónde salió: la propia web, el usuario, o nada. */
  source: "web" | "usuario" | null;
  /** Alias (facebook.com/<esto>) derivados de las URLs. */
  slugs: string[];
  note: string;
}

export interface AdLibraryAudit {
  status: "ok" | "sin_resultados" | "no_ejecutado" | "parada_emergencia" | "error";
  reason: string | null;
  searchTerms: string[];
  /** Cómo se decidió que un anunciante ES esta tienda. */
  matchedBy: Array<"nombre_marca" | "dominio_declarado" | "alias_facebook" | "page_id">;
  competitors: CompetitorReport[];
  activeAds: number;
  stopReason: StopReason | null;
  requests: number;
}

export interface StoreAuditReport {
  storeUrl: string;
  domain: string;
  brandName: string | null;
  profile: StoreProfile;
  catalog: CatalogSummary;
  facebook: FacebookResolution;
  adLibrary: AdLibraryAudit;
  angles: AngleReport | null;
  incomplete: Array<{ part: string; reason: string }>;
  storeRequests: number;
  elapsedSec: number;
  /** Lo que esta auditoría NO puede saber, para que nadie lo lea entre líneas. */
  notAvailable: readonly string[];
}

export const AUDIT_NOT_AVAILABLE = [
  "gasto publicitario, impresiones, CTR o ventas: la Ad Library no los da para anuncios comerciales",
  "el creativo en sí (imagen o vídeo): solo el texto y el enlace a la ficha",
  "el page_id numérico de la tienda: de su web solo sale un alias, y convertirlo exige raspar Facebook (prohibido); si se pega a mano se usa, pero search_page_ids no está probado en vivo",
  "ventas o tráfico de la tienda: el catálogo público no los expone",
] as const;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[™®©]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * «Casamable™», «➤ Ortopedia Madrid · La Casa del Enfermo» → un nombre de marca usable.
 * Solo se quitan prefijos genéricos de DOS palabras («tienda online», «www»):
 * «Tienda Uno» es un nombre, y quitarle «tienda» lo dejaría en un término inútil.
 */
export function cleanBrandName(raw: string | null): string | null {
  if (!raw) return null;
  const primero = raw.split(/[|·•–—:,]/)[0];
  const limpio = fold(primero).replace(/^(www|tienda online|shop online|online shop|online store)\s+/, "").trim();
  if (!limpio || limpio.length < 3) return null;
  return limpio.slice(0, 60);
}

/** Un page_id numérico pegado a mano: facebook.com/123…, profile.php?id=123… o view_all_page_id=123…. */
export function facebookPageId(urls: string[]): string | null {
  for (const u of urls) {
    const m = u.match(/view_all_page_id=(\d{5,})/) ?? u.match(/[?&]id=(\d{5,})/) ?? u.match(/facebook\.com\/(\d{5,})(?:[/?#]|$)/i);
    if (m) return m[1];
  }
  return null;
}

/** facebook.com/<slug> → slug, sin números de id ni rutas. */
export function facebookSlugs(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    const m = u.match(/facebook\.com\/([A-Za-z0-9._%-]+)/i);
    if (!m) continue;
    const slug = decodeURIComponent(m[1]).toLowerCase();
    if (/^\d+$/.test(slug) || slug === "profile.php") continue;
    out.add(slug);
  }
  return [...out].slice(0, 3);
}

export function summarizeCatalog(catalog: StoreCatalog): CatalogSummary {
  const precios = catalog.products.flatMap((p) => [p.priceMin, p.priceMax]).filter((n): n is number => typeof n === "number");
  const cuenta = (vals: Array<string | null>) => {
    const m = new Map<string, number>();
    for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  };
  return {
    status: catalog.status,
    reason: catalog.reason,
    products: catalog.products.length,
    truncated: catalog.truncated,
    priceMin: precios.length ? Math.min(...precios) : null,
    priceMax: precios.length ? Math.max(...precios) : null,
    topTypes: cuenta(catalog.products.map((p) => p.productType)).map(([type, count]) => ({ type, count })),
    topVendors: cuenta(catalog.products.map((p) => p.vendor)).map(([vendor, count]) => ({ vendor, count })),
    sample: catalog.products.slice(0, 8).map((p) => ({ title: p.title, price: p.priceMin, url: p.url })),
  };
}

/**
 * El buscador agrupa por «página + línea de producto». Para auditar UNA tienda
 * la unidad es la página: sus grupos se funden en uno (anuncios unidos, activos
 * sumados, el más antiguo como fecha de inicio, ruido solo si lo son todos).
 */
export function mergeGroupsByPage(groups: DiscoveryGroup[]): DiscoveryGroup[] {
  const porPagina = new Map<string, DiscoveryGroup>();
  for (const g of groups) {
    const prev = porPagina.get(g.pageId);
    if (!prev) { porPagina.set(g.pageId, { ...g, ads: [...g.ads] }); continue; }
    const vistos = new Set(prev.ads.map((x) => x.id));
    for (const ad of g.ads) if (!vistos.has(ad.id)) prev.ads.push(ad);
    prev.activeAds = prev.ads.length;
    prev.oldestActiveAt = prev.oldestActiveAt === null ? g.oldestActiveAt : g.oldestActiveAt === null ? prev.oldestActiveAt : Math.min(prev.oldestActiveAt, g.oldestActiveAt);
    if (!g.noise) { prev.noise = false; prev.noiseReason = null; }
    if (!prev.pageName && g.pageName) prev.pageName = g.pageName;
  }
  return [...porPagina.values()];
}

/** ¿Este grupo de anuncios pertenece a la tienda? Solo por pruebas honestas. */
export function matchGroupToStore(group: DiscoveryGroup, store: { brand: string | null; domain: string; slugs: string[]; pageId?: string | null }): Array<"nombre_marca" | "dominio_declarado" | "alias_facebook" | "page_id"> {
  const razones: Array<"nombre_marca" | "dominio_declarado" | "alias_facebook" | "page_id"> = [];
  if (store.pageId && group.pageId === store.pageId) razones.push("page_id");
  const nombre = fold(group.pageName ?? "");
  if (store.brand && nombre && (nombre === store.brand || nombre.includes(store.brand) || store.brand.includes(nombre))) razones.push("nombre_marca");
  const dominios = declaredDomains(group.ads);
  if (dominios.some((d) => d === store.domain || d.endsWith(`.${store.domain}`) || store.domain.endsWith(`.${d}`))) razones.push("dominio_declarado");
  const nombreCompacto = nombre.replace(/\s+/g, "");
  if (store.slugs.some((s) => s.replace(/[._-]/g, "") === nombreCompacto && nombreCompacto.length >= 4)) razones.push("alias_facebook");
  return razones;
}

export interface StoreAuditInput {
  storeUrl: string;
  /** Enlace de Facebook pegado por el usuario si la web no lo trae. Si trae un page_id numérico, se usa. */
  facebookUrl?: string | null;
  /** page_id numérico conocido de antemano (modo A manual). */
  pageId?: string | null;
  country?: string;
  days?: number;
  token: string;
  now?: number;
  client?: AdLibraryClient;
  /** Presupuesto de la Ad Library. Si no se da, uno de 3 minutos y 60 peticiones. */
  budget?: DiscoveryBudget;
  /** Para leer la tienda (portada y catálogo). Inyectable en tests. */
  fetcher?: typeof fetch;
  /** Modo B: anuncios ya obtenidos por el buscador. Con esto NO se vuelve a la Ad Library. */
  knownAds?: AdLibraryAd[];
  knownPageId?: string | null;
  maxCatalogPages?: number;
}

export async function runStoreAudit(input: StoreAuditInput): Promise<StoreAuditReport> {
  // GATE (safety.ts): con la parada no se lee ni la tienda ni la Ad Library.
  if (!canRunDiscovery()) throw new DiscoveryHaltedError();
  const started = Date.now();
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const country = input.country ?? "ES";
  const days = input.days ?? 30;
  const fetcher = input.fetcher ?? fetch;
  const incomplete: Array<{ part: string; reason: string }> = [];

  // 1 · La tienda: portada + catálogo.
  const norm = normalizeStoreUrl(input.storeUrl);
  const store = await readStore(input.storeUrl, fetcher, input.maxCatalogPages);
  const domain = norm?.domain ?? store.profile.domain;
  const brand = cleanBrandName(store.profile.brandName);
  if (store.profile.homepageStatus !== "ok") incomplete.push({ part: "portada", reason: store.profile.homepageReason ?? "no accesible" });
  if (store.catalog.status !== "ok") incomplete.push({ part: "catálogo", reason: store.catalog.status === "no_shopify" ? "la tienda no es Shopify (o no publica /products.json): catálogo no accesible" : (store.catalog.reason ?? store.catalog.status) });
  if (!brand) incomplete.push({ part: "nombre de marca", reason: "la web no declara og:site_name ni un título usable" });

  // 2 · Facebook: la web primero; si no, lo que pegó el usuario.
  let facebook: FacebookResolution;
  if (store.profile.facebookUrls.length) {
    facebook = { urls: store.profile.facebookUrls, source: "web", slugs: facebookSlugs(store.profile.facebookUrls), note: "enlace encontrado en la propia web" };
  } else if (input.facebookUrl && /facebook\.com\//i.test(input.facebookUrl)) {
    facebook = { urls: [input.facebookUrl.trim()], source: "usuario", slugs: facebookSlugs([input.facebookUrl]), note: "la web no enlaza a Facebook: se usa el enlace pegado por el usuario" };
  } else {
    facebook = { urls: [], source: null, slugs: [], note: "la web no enlaza a Facebook y nadie pegó el enlace: la búsqueda en la Ad Library va solo por nombre de marca y dominio" };
    incomplete.push({ part: "página de Facebook", reason: "sin enlace en la web; pega el link de la página como alternativa" });
  }

  // 3 · Ad Library: o los anuncios ya conocidos (modo B), o búsqueda por nombre.
  const adLibrary: AdLibraryAudit = { status: "no_ejecutado", reason: null, searchTerms: [], matchedBy: [], competitors: [], activeAds: 0, stopReason: null, requests: 0 };
  let matchedAds: AdLibraryAd[] = [];

  const terms = [...new Set([brand, domain.replace(/\.[a-z]+$/i, ""), ...facebook.slugs.map((s) => s.replace(/[._-]+/g, " "))].filter((t): t is string => Boolean(t && t.length >= 3)))].slice(0, 3);
  adLibrary.searchTerms = terms;
  // page_id numérico: el pegado a mano, o el que venga en el enlace (view_all_page_id=…).
  const pageId = input.pageId?.trim() || facebookPageId([...(input.facebookUrl ? [input.facebookUrl] : []), ...facebook.urls]) || input.knownPageId || null;
  if (pageId && facebook.source === "usuario") facebook.note = `page_id numérico ${pageId} tomado del enlace pegado: se consulta la Ad Library por search_page_ids`;

  if (input.knownAds && input.knownAds.length) {
    matchedAds = input.knownAds;
    adLibrary.status = "ok";
    adLibrary.matchedBy = input.knownPageId ? ["page_id"] : ["nombre_marca"];
    adLibrary.reason = "anuncios obtenidos por el buscador por palabra (sin volver a la Ad Library)";
  } else if (!canRunDiscovery()) {
    adLibrary.status = "parada_emergencia";
    adLibrary.reason = new DiscoveryHaltedError().message;
    incomplete.push({ part: "anuncios en la Ad Library", reason: "EMERGENCY_STOP activo" });
  } else if (!terms.length && !pageId) {
    adLibrary.reason = "sin nombre de marca ni dominio con el que buscar";
    incomplete.push({ part: "anuncios en la Ad Library", reason: adLibrary.reason });
  } else {
    const client = input.client ?? new AdLibraryClient(input.token);
    const budget = input.budget ?? new DiscoveryBudget({ deadlineAt: started + 3 * 60_000, maxRequests: 60 });
    const until = new Date(now * 1000).toISOString().slice(0, 10);
    const since = new Date((now - days * 86400) * 1000).toISOString().slice(0, 10);
    const todos: AdLibraryAd[] = [];
    let fallo: string | null = null;
    try {
      // Primero por page_id si lo hay (exacto); si devuelve algo, no hace falta buscar por texto.
      if (pageId) {
        const r = await client.search({ term: "", pageIds: [pageId], country, since, until, budget, maxPages: 3 });
        todos.push(...r.ads);
        adLibrary.requests = budget.requests;
        if (r.stopReason !== "completado") { adLibrary.stopReason = r.stopReason; fallo = r.error; }
        if (r.ads.length) adLibrary.searchTerms = [`page_id ${pageId}`];
      }
      if (!todos.length && !fallo) {
        for (const term of terms) {
          const freno = budget.check();
          if (freno) { adLibrary.stopReason = freno; break; }
          const r = await client.search({ term, country, since, until, budget, maxPages: 3 });
          todos.push(...r.ads);
          adLibrary.requests = budget.requests;
          if (r.stopReason !== "completado") { adLibrary.stopReason = r.stopReason; fallo = r.error; break; }
        }
      }
      const unicos = [...new Map(todos.map((a) => [a.id, a])).values()];
      const grupos = mergeGroupsByPage(groupAds(unicos, now, country));
      const razonesTotales = new Set<AdLibraryAudit["matchedBy"][number]>();
      for (const g of grupos) {
        const razones = matchGroupToStore(g, { brand, domain, slugs: facebook.slugs, pageId });
        if (!razones.length) continue;
        razones.forEach((r) => razonesTotales.add(r));
        matchedAds.push(...g.ads);
        adLibrary.competitors.push(
          competitorSignals({
            snapshot: { ...g, candidateId: 0, momentum: "sin_historico", previousActiveAds: null, previousCapturedAt: null, momentumTrace: computeMomentum({ activeAds: g.activeAds, previousActiveAds: null, previousCapturedAt: null, now }) },
            now,
            countriesSeen: [],
          })
        );
      }
      adLibrary.matchedBy = [...razonesTotales];
      // Un fallo de Meta (campo rechazado, HTTP 400…) NO es «no anuncia»: se dice tal cual.
      adLibrary.status = matchedAds.length ? "ok" : fallo ? "error" : "sin_resultados";
      if (!matchedAds.length) {
        adLibrary.reason = fallo
          ? `la consulta a la Ad Library falló (${fallo}): no se puede afirmar que la tienda no anuncie`
          : unicos.length
            ? `la Ad Library devolvió ${unicos.length} anuncios para «${adLibrary.searchTerms.join("», «")}», pero ninguno se pudo atribuir a esta tienda por nombre ni por dominio`
            : `la Ad Library no devolvió anuncios activos para «${adLibrary.searchTerms.join("», «")}»`;
        incomplete.push({ part: "anuncios en la Ad Library", reason: adLibrary.reason });
      }
    } catch (err) {
      const e = asAdLibraryError(err);
      adLibrary.status = e.kind === "parada_emergencia" ? "parada_emergencia" : "error";
      adLibrary.reason = e.message;
      adLibrary.stopReason = e.kind === "parada_emergencia" ? "parada_emergencia" : e.kind === "token_invalido" ? "token_invalido" : "error";
      incomplete.push({ part: "anuncios en la Ad Library", reason: e.message });
    }
  }
  adLibrary.activeAds = adLibrary.competitors.reduce((n, c) => n + c.activeAds, 0) || (input.knownAds ? matchedAds.length : 0);

  // 4 · Ángulos, citando el texto real.
  const angles = matchedAds.length ? extractAngles(matchedAds) : null;

  return {
    storeUrl: input.storeUrl,
    domain,
    brandName: brand,
    profile: store.profile,
    catalog: summarizeCatalog(store.catalog),
    facebook,
    adLibrary,
    angles,
    incomplete,
    storeRequests: store.requests,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    notAvailable: AUDIT_NOT_AVAILABLE,
  };
}
