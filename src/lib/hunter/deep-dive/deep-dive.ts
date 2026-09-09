// ============================================================
// NIVEL 2 · DEEP DIVE de un candidato del cruce (09-09-2026)
// docs/HUNTER-DEEP-DIVE.md
//
// El informe que sustituye a «mirar el anuncio a mano 20 minutos»: por qué
// se vende, quién lo compra, qué ángulos ganan, desde cuándo, precio y margen
// REALES, cuántas tiendas compiten y qué más vende esa misma tienda.
//
// Verificado con datos reales (sonda 09-09 y producción):
//   · la URL de destino del anuncio NO está en la API ni en render_ad: no se
//     intenta; el DOMINIO sí (ad_creative_link_captions);
//   · /products.json de la tienda Shopify da el precio real;
//   · render_ad sirve la imagen (fbcdn, sin sesión);
//   · search_page_ids con ad_active_status=ALL trae toda la cuenta.
//
// Por candidato, en orden, cada paso con su motivo si no se pudo:
//   0a · búsqueda por palabra clave (1 petición, como el nivel 1): anuncios
//        frescos del candidato + las OTRAS páginas que anuncian lo mismo
//        (saturación cruzada);
//   0b · radiografía de la CUENTA (account.ts): antigüedad real, volumen,
//        ritmo de testeo vs. madurez del ángulo ganador, avatar, y los otros
//        productos que vende esa tienda (minería) con búsqueda en Dropea;
//   1  · dominio declarado en los captions (sin red);
//   2  · portada + catálogo público /products.json (readStore);
//   3  · producto del catálogo que casa con las palabras clave;
//   4  · precio REAL y margen contra el coste de Dropea; coherencia entre el
//        precio del catálogo y el que dice el propio anuncio (alerta si difieren);
//   5  · ángulos del TEXTO del anuncio (cita literal);
//   6  · creatividad: imagen (visión por OpenRouter) y, si es vídeo, guion
//        por OpenAI (solo audio: video.ts explica el límite);
//   7  · veredicto con reglas escritas, recomendación en una frase y enlace
//        público del anuncio para comprobarlo a mano.
// Fail-closed: sin catálogo no hay precio; sin precio no hay margen; nada se
// estima. Lo que no se pudo hacer se declara con su motivo.
// ============================================================

import type { AdLibraryAd, DiscoveryGroup } from "../discovery/types";
import type { AdLibraryClient } from "../discovery/client";
import { DiscoveryBudget } from "../discovery/budget";
import { declaredDomains } from "../discovery/signals";
import { groupAds } from "../discovery/grouping";
import { mergeGroupsByPage } from "../audit/store-audit";
import { readStore, type CatalogProduct, type StoreProfile } from "../audit/store";
import { extractAngles, type AngleReport } from "../audit/angles";
import { tokens } from "../../product-hunter/internal/dropea-catalog";
import { bestMatch } from "../../product-hunter/internal/cruce";
import { detectPricesInText } from "../../product-hunter/internal/price-detect";
import { parseRenderAdHtml, renderAdUrl, DEEP_DIVE_USER_AGENT } from "./render-ad";
import { readAccountXray, accountDateWindow, adLibraryLink, type AccountXray, type AccountXrayInput, type AccountProduct } from "./account";
import { DEEP_DIVE_VIDEO_MAX_BYTES, type VideoAnalysis, type VideoFn, type VideoStatus } from "./video";

const DAY = 86_400;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** La búsqueda por palabra mira los últimos 30 días, como el cruce del nivel 1. */
export const SEARCH_DAYS = 30;

export type DeepDiveVerdict = "ganador_probable" | "senal_debil" | "descartar" | "no_verificable";
export type Recommendation = "contactar_dropea_muestra" | "descartar" | "verificar_manual";

export interface CreativeAnalysis {
  model: string;
  hook: string | null;
  angle: string | null;
  pain: string | null;
  desire: string | null;
  avatar: string | null;
  visiblePrice: string | null;
  raw: string;
}

/** Función de visión inyectable: recibe la imagen y devuelve el análisis o null (con motivo). */
export type VisionFn = (image: { bytes: Uint8Array; mime: string }, context: { keywords: string[]; adText: string }) => Promise<CreativeAnalysis | null>;
/** Búsqueda local en el catálogo de Dropea por palabras clave (minería de otros productos). */
export type DropeaLookupFn = (keywords: string[]) => Array<{ variantId: number; name: string; costEur: number | null }>;

export interface DeepDiveInput {
  keywords: string[];
  ads: AdLibraryAd[];
  costEur: number | null;
  activeAds: number | null;
  oldestActiveAt: number | null;
  now?: number;
  fetcher?: typeof fetch;
  /** Token de la Ad Library, SOLO para render_ad en memoria. Sin él no hay visión ni vídeo. */
  token?: string | null;
  vision?: VisionFn | null;
  /** Vídeo/audio (OpenAI solo aquí). null = sin clave; skipVideo = --sin-video. */
  video?: VideoFn | null;
  skipVideo?: boolean;
  /** Tope diario de vídeos: true = agotado (lo cuenta el CLI sobre hunter_deep_dives). */
  videoBudgetExhausted?: boolean;
  /** Dominio forzado (modo manual del CLI). */
  domainOverride?: string | null;
  /** Pasos 0a/0b: cliente de la Ad Library, page_id y país. Sin ellos se omiten (con motivo). */
  client?: AdLibraryClient | null;
  pageId?: string | null;
  country?: string | null;
  /** false = no repetir la búsqueda por palabra (ahorra 1 petición; sin saturación cruzada). */
  search?: boolean;
  accountSummarize?: AccountXrayInput["summarize"];
  accountMaxPages?: number;
  skipAccount?: boolean;
  dropeaLookup?: DropeaLookupFn | null;
}

export interface CatalogMatch {
  product: CatalogProduct;
  coverage: number;
  verdict: "si" | "dudoso";
}

export interface Competitor { pageId: string; pageName: string | null; activeAds: number; coverage: number; verdict: "si" | "dudoso"; adLink: string | null }

export interface PriceCoherence {
  status: "coincide" | "difiere" | "sin_precio_en_anuncio" | "sin_catalogo";
  adPrices: Array<{ amount: number; quote: string; adId: string }>;
  catalogMin: number | null;
  catalogMax: number | null;
  note: string;
}

export interface OtherProduct extends AccountProduct {
  dropea: { searched: boolean; matches: Array<{ variantId: number; name: string; costEur: number | null }> };
}

export interface DeepDiveReport {
  /** Enlace público del anuncio principal, para comprobarlo a mano con un clic. */
  adLink: string | null;
  adLinks: string[];
  /** Paso 0a · otras páginas que anuncian el mismo producto ahora (últimos 30 días, 1 página de búsqueda). */
  competitors: { count: number; pages: Competitor[]; basis: string } | null;
  /** Paso 0b · la cuenta entera (null si no se pudo, con motivo en incomplete). */
  account: AccountXray | null;
  /** Otros productos de la misma tienda (minería), con su búsqueda en Dropea. */
  otherProducts: OtherProduct[];
  domain: string | null;
  domainSource: "caption" | "manual" | null;
  store: { status: StoreProfile["homepageStatus"]; reason: string | null; isShopify: boolean; brand: string | null } | null;
  catalog: { status: string; reason: string | null; products: number; truncated: boolean } | null;
  match: CatalogMatch | null;
  priceEur: number | null;
  priceMaxEur: number | null;
  costEur: number | null;
  marginEur: number | null;
  marginPct: number | null;
  priceCoherence: PriceCoherence;
  angles: AngleReport | null;
  creative: CreativeAnalysis | null;
  creativeStatus: "analizada" | "sin_imagen" | "sin_token" | "sin_vision" | "video_no_soportado" | "error";
  video: VideoAnalysis | null;
  videoStatus: VideoStatus;
  activeAds: number | null;
  daysActive: number | null;
  verdict: DeepDiveVerdict;
  reasoning: string;
  recommendation: { action: Recommendation; reason: string };
  /** Veredicto final en texto claro: lo que Pedro leería en vez de mirar el anuncio 20 minutos. */
  summary: string;
  incomplete: Array<{ part: string; reason: string }>;
  requests: number;
  rules: string;
}

/** Reglas del veredicto, literales, para que el informe se pueda reconstruir. */
export const DEEP_DIVE_RULES =
  "ganador_probable = catálogo ok ∧ producto casado (cobertura ≥ 0,75) ∧ margen real ≥ 50 % ∧ activos ≥ 2 ∧ días ≥ 14 · " +
  "senal_debil = producto casado ∧ margen real ≥ 30 % pero falla activos, días o el match es dudoso · " +
  "descartar = producto casado ∧ margen real < 30 %, o producto no disponible · " +
  "no_verificable = sin dominio, catálogo no accesible, producto no encontrado o sin coste (no se estima nada)";

export const RECOMMENDATION_RULES =
  "contactar_dropea_muestra = ganador_probable ∧ precio del anuncio coherente con el catálogo ∧ ≤ 2 tiendas compitiendo · " +
  "verificar_manual = ganador_probable con precio incoherente o ≥ 3 competidores; senal_debil con margen ≥ 50 % y ángulo ganador ≥ 30 días (o cuenta no leída); no_verificable · " +
  "descartar = descartar, o senal_debil sin margen ≥ 50 % o sin ángulo maduro";

/** Casa las palabras clave del cruce contra los títulos del catálogo: cobertura por palabra ENTERA. */
export function matchCatalogProduct(keywords: string[], products: CatalogProduct[]): CatalogMatch | null {
  if (!keywords.length) return null;
  let best: CatalogMatch | null = null;
  for (const p of products) {
    const words = new Set(tokens(`${p.title} ${p.handle.replace(/-/g, " ")} ${p.productType ?? ""}`));
    const hits = keywords.filter((k) => words.has(k)).length;
    if (!hits) continue;
    const coverage = round2(hits / keywords.length);
    const verdict: CatalogMatch["verdict"] = coverage >= 0.75 && hits >= Math.min(2, keywords.length) ? "si" : "dudoso";
    if (!best || coverage > best.coverage || (coverage === best.coverage && (p.available ? 1 : 0) > (best.product.available ? 1 : 0))) best = { product: p, coverage, verdict };
  }
  return best;
}

/** Coherencia entre el precio real del catálogo y el que dice el propio anuncio. Puro, testeable. */
export function priceCoherence(ads: AdLibraryAd[], catalogMin: number | null, catalogMax: number | null): PriceCoherence {
  const adPrices: PriceCoherence["adPrices"] = [];
  for (const ad of ads) {
    const texto = [...ad.titles, ...ad.bodies, ...(ad.descriptions ?? [])].join(" · ");
    for (const p of detectPricesInText(texto)) if (!adPrices.some((x) => x.amount === p.amount)) adPrices.push({ amount: p.amount, quote: p.quote, adId: ad.id });
  }
  if (catalogMin === null) return { status: "sin_catalogo", adPrices, catalogMin, catalogMax, note: adPrices.length ? `el anuncio menciona ${adPrices.map((p) => `${p.amount} €`).join(", ")}, pero no hay precio de catálogo con el que compararlo` : "sin precio en el anuncio ni en el catálogo" };
  if (!adPrices.length) return { status: "sin_precio_en_anuncio", adPrices, catalogMin, catalogMax, note: `el texto del anuncio no dice precio; el del catálogo es ${catalogMin} €${catalogMax !== null && catalogMax !== catalogMin ? ` – ${catalogMax} €` : ""}` };
  const max = catalogMax ?? catalogMin;
  const tol = (n: number) => Math.max(0.5, n * 0.02);
  const coincide = adPrices.find((p) => (p.amount >= catalogMin - tol(catalogMin) && p.amount <= max + tol(max)));
  if (coincide) return { status: "coincide", adPrices, catalogMin, catalogMax, note: `el anuncio dice ${coincide.amount} € («${coincide.quote}») y el catálogo ${catalogMin} €${max !== catalogMin ? ` – ${max} €` : ""}: coherente` };
  const lista = adPrices.map((p) => `${p.amount} € («${p.quote}»)`).join(", ");
  return { status: "difiere", adPrices, catalogMin, catalogMax, note: `ALERTA: el anuncio dice ${lista} y el catálogo ${catalogMin} €${max !== catalogMin ? ` – ${max} €` : ""}: oferta solo por anuncio, pack distinto al del catálogo, o el matching cogió otro producto; el margen real de arriba es el del catálogo` };
}

/** Recomendación explícita con motivo en una frase. Puro, testeable. */
export function recommend(x: { verdict: DeepDiveVerdict; reasoning: string; coherence: PriceCoherence["status"]; competitors: number | null; marginPct: number | null; winnerDays: number | null; incomplete: Array<{ part: string; reason: string }> }): { action: Recommendation; reason: string } {
  const comp = x.competitors === null ? "competencia no medida" : `${x.competitors} tienda${x.competitors === 1 ? "" : "s"} más anunciando lo mismo`;
  if (x.verdict === "ganador_probable") {
    if (x.coherence === "difiere") return { action: "verificar_manual", reason: `cumple las reglas, pero el precio del anuncio no cuadra con el del catálogo: comprobar a mano qué se vende de verdad antes de pedir muestra (${comp})` };
    if ((x.competitors ?? 0) >= 3) return { action: "verificar_manual", reason: `cumple las reglas, pero ya hay ${comp}: el público satura antes y el precio se aprieta; decidir a mano si entrar` };
    return { action: "contactar_dropea_muestra", reason: `producto casado, margen real ≥ 50 %, anuncios activos con recorrido y ${comp}: pedir muestra a Dropea` };
  }
  if (x.verdict === "descartar") return { action: "descartar", reason: x.reasoning };
  if (x.verdict === "senal_debil") {
    if ((x.marginPct ?? 0) >= 0.5 && (x.winnerDays ?? 0) >= 30) return { action: "verificar_manual", reason: `margen real ${Math.round((x.marginPct ?? 0) * 100)} % y un ángulo ganador con ${x.winnerDays} días activo, pero falla alguna regla (${x.reasoning.split("→").pop()?.trim() ?? "ver razonamiento"}): mirar el anuncio a mano` };
    if ((x.marginPct ?? 0) >= 0.5 && x.winnerDays === null) return { action: "verificar_manual", reason: `margen real ${Math.round((x.marginPct ?? 0) * 100)} % pero sin radiografía de la cuenta (no se pudo medir la madurez del ángulo) y falla alguna regla (${x.reasoning.split("→").pop()?.trim() ?? "ver razonamiento"}): mirar el anuncio a mano` };
    return { action: "descartar", reason: `señal débil ${(x.marginPct ?? 0) >= 0.5 ? "con ángulo ganador inmaduro (< 30 días)" : "sin margen ≥ 50 %"}: ${x.reasoning.split("→").pop()?.trim() ?? x.reasoning}` };
  }
  const faltan = x.incomplete.filter((i) => ["tienda", "catálogo", "producto", "margen"].includes(i.part)).map((i) => i.part);
  return { action: "verificar_manual", reason: `no verificable automáticamente (${faltan.length ? `falta: ${[...new Set(faltan)].join(", ")}` : x.reasoning}): abrir el anuncio y la tienda a mano` };
}

export async function runDeepDive(input: DeepDiveInput): Promise<DeepDiveReport> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const fetcher = input.fetcher ?? fetch;
  const incomplete: DeepDiveReport["incomplete"] = [];
  let requests = 0;
  const daysActive = input.oldestActiveAt !== null ? Math.max(0, Math.floor((now - input.oldestActiveAt) / DAY)) : null;
  const country = input.country ?? "ES";
  let ads = input.ads;
  let pageId = input.pageId ?? null;

  // 0a · búsqueda por palabra clave: anuncios frescos + saturación cruzada.
  let competitors: DeepDiveReport["competitors"] = null;
  if (input.client && input.keywords.length && input.search !== false) {
    try {
      const budget = new DiscoveryBudget({ deadlineAt: Date.now() + 60_000, maxRequests: 2 });
      const { until } = accountDateWindow(now);
      const since = new Date((now - SEARCH_DAYS * DAY) * 1000).toISOString().slice(0, 10);
      const r = await input.client.search({ term: input.keywords.join(" "), country, since, until, budget, maxPages: 1 });
      requests += budget.requests;
      const groups = mergeGroupsByPage(groupAds(r.ads, now, country));
      const matched = (pageId ? groups.find((g) => g.pageId === pageId) : null) ?? bestMatch(input.keywords, groups)?.group ?? null;
      if (matched) {
        if (!pageId) pageId = matched.pageId;
        if (!ads.length) ads = matched.ads;
      }
      const pages: Competitor[] = [];
      for (const g of groups) {
        if (g.pageId === (matched?.pageId ?? pageId)) continue;
        const m = bestMatch(input.keywords, [g]);
        if (!m || m.verdict === "no") continue;
        pages.push({ pageId: g.pageId, pageName: g.pageName, activeAds: g.activeAds, coverage: m.coverage, verdict: m.verdict, adLink: g.ads[0] ? adLibraryLink(g.ads[0].id) : null });
      }
      pages.sort((a, b) => b.coverage - a.coverage || b.activeAds - a.activeAds);
      competitors = { count: pages.length, pages: pages.slice(0, 10), basis: `búsqueda «${input.keywords.join(" ")}» en ${country}, últimos ${SEARCH_DAYS} días, 1 página (${r.ads.length} anuncios, ${groups.length} páginas); competidor = otra página cuyo texto casa con las palabras clave` };
      if (r.error) incomplete.push({ part: "competencia", reason: `la búsqueda por palabra devolvió un error (${r.error}): la saturación puede estar incompleta` });
    } catch (err) {
      incomplete.push({ part: "competencia", reason: `fallo en la búsqueda por palabra: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
    }
  } else if (!input.client) incomplete.push({ part: "competencia", reason: "sin cliente de la Ad Library no se mide cuántas tiendas anuncian lo mismo" });
  else if (input.search === false) incomplete.push({ part: "competencia", reason: "búsqueda por palabra desactivada: sin saturación cruzada" });

  // 0b · radiografía de la cuenta (todos los anuncios de la página, activos e inactivos)
  let account: AccountXray | null = null;
  if (input.skipAccount) incomplete.push({ part: "cuenta", reason: "radiografía de la cuenta omitida (--sin-cuenta)" });
  else if (!input.client || !pageId) incomplete.push({ part: "cuenta", reason: !pageId ? "sin page_id del anunciante (modo manual o candidato sin página)" : "sin cliente de la Ad Library (falta el token)" });
  else {
    try {
      account = await readAccountXray({ client: input.client, pageId, country, now, maxPages: input.accountMaxPages, summarize: input.accountSummarize ?? null, originalKeywords: input.keywords });
      requests += account.requests;
      if (account.truncated) incomplete.push({ part: "cuenta", reason: `la cuenta tiene más anuncios de los leídos (${account.totalAds} en ${account.pages} páginas): antigüedad y volumen son cota inferior` });
      if (account.stopReason !== "completado") incomplete.push({ part: "cuenta", reason: `lectura de la cuenta cortada: ${account.stopReason}` });
    } catch (err) {
      incomplete.push({ part: "cuenta", reason: `fallo al leer la cuenta: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
    }
  }
  // Minería: otros productos de la misma tienda, con búsqueda local en Dropea.
  const otherProducts: OtherProduct[] = [];
  if (account) {
    for (const p of account.products.filter((x) => !x.isOriginal).slice(0, 8)) {
      let matches: OtherProduct["dropea"]["matches"] = [];
      let searched = false;
      if (input.dropeaLookup) { try { matches = input.dropeaLookup(p.keywords.slice(0, 3)).slice(0, 5); searched = true; } catch { matches = []; } }
      otherProducts.push({ ...p, dropea: { searched, matches } });
    }
  }

  // 1 · dominio
  let domain: string | null = null;
  let domainSource: DeepDiveReport["domainSource"] = null;
  if (input.domainOverride) { domain = input.domainOverride.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; domainSource = "manual"; }
  else {
    const dominios = declaredDomains(ads).filter((d) => !/(^|\.)(facebook|instagram|whatsapp|fb|messenger)\.(com|me)$/i.test(d));
    if (dominios.length) { domain = dominios[0]; domainSource = "caption"; }
  }
  if (!domain) incomplete.push({ part: "tienda", reason: ads.length ? "el anuncio no declara ningún dominio en sus captions (y la URL de destino no está disponible en la API ni en render_ad)" : "sin anuncios del candidato (ni guardados ni de la búsqueda): no hay captions de los que sacar el dominio" });

  // 2 · portada + catálogo
  let store: DeepDiveReport["store"] = null;
  let catalog: DeepDiveReport["catalog"] = null;
  let products: CatalogProduct[] = [];
  if (domain) {
    const r = await readStore(domain, fetcher);
    requests += r.requests;
    store = { status: r.profile.homepageStatus, reason: r.profile.homepageReason, isShopify: r.profile.isShopify, brand: r.profile.brandName };
    catalog = { status: r.catalog.status, reason: r.catalog.reason, products: r.catalog.products.length, truncated: r.catalog.truncated };
    products = r.catalog.products;
    if (r.catalog.status !== "ok") incomplete.push({ part: "catálogo", reason: r.catalog.status === "no_shopify" ? `${domain} no es Shopify o no publica /products.json: catálogo no accesible` : (r.catalog.reason ?? r.catalog.status) });
  }

  // 3 · producto
  const match = products.length ? matchCatalogProduct(input.keywords, products) : null;
  if (products.length && !match) incomplete.push({ part: "producto", reason: `ninguno de los ${products.length} productos del catálogo contiene las palabras «${input.keywords.join(" ")}»` });

  // 4 · precio y margen REALES + coherencia con el anuncio
  const priceEur = match?.product.priceMin ?? null;
  const priceMaxEur = match?.product.priceMax ?? null;
  let marginEur: number | null = null, marginPct: number | null = null;
  if (priceEur !== null && input.costEur !== null && priceEur > 0) { marginEur = round2(priceEur - input.costEur); marginPct = round2(marginEur / priceEur); }
  else if (match && input.costEur === null) incomplete.push({ part: "margen", reason: "sin coste de Dropea para este producto" });
  if (match && match.product.available === false) incomplete.push({ part: "disponibilidad", reason: "el producto figura como no disponible en la tienda" });
  const coherence = priceCoherence(ads, priceEur, priceMaxEur);
  if (coherence.status === "difiere") incomplete.push({ part: "precio", reason: coherence.note });

  // 5 · ángulos del texto (cita literal)
  const angles = ads.length ? extractAngles(ads) : null;

  // 6 · creatividad: imagen (visión) y vídeo (guion)
  let creative: CreativeAnalysis | null = null;
  let creativeStatus: DeepDiveReport["creativeStatus"] = "sin_vision";
  let video: VideoAnalysis | null = null;
  let videoStatus: VideoStatus = "sin_video";
  const adId = ads[0]?.id ?? null;
  const adText = ads.flatMap((a) => [...a.bodies, ...a.titles]).join(" | ").slice(0, 1500);
  const quiereVision = Boolean(input.vision);
  const quiereVideo = !input.skipVideo && Boolean(input.video);
  if (!adId) { creativeStatus = quiereVision ? "sin_imagen" : "sin_vision"; }
  else if (!input.token) { creativeStatus = quiereVision ? "sin_token" : "sin_vision"; if (quiereVision || quiereVideo) incomplete.push({ part: "creatividad", reason: "sin token de la Ad Library no se puede pedir render_ad" }); }
  else {
    // Con token siempre se pide render_ad (1 petición): aunque no haya visión ni clave de OpenAI, hay que saber si es vídeo para decirlo.
    try {
      requests++;
      const r = await fetcher(renderAdUrl(adId, input.token), { headers: { "user-agent": DEEP_DIVE_USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      const parsed = parseRenderAdHtml(await r.text());
      // Imagen → visión (OpenRouter)
      if (!input.vision) creativeStatus = "sin_vision";
      else if (!parsed.imageUrls.length) { creativeStatus = parsed.videoUrls.length ? "video_no_soportado" : "sin_imagen"; incomplete.push({ part: "creatividad", reason: parsed.videoUrls.length ? "el anuncio es un vídeo sin imagen fija: la visión no tiene qué mirar (el guion va por el paso de vídeo)" : parsed.blocked ? `render_ad devolvió ${parsed.blocked}` : "render_ad no trajo ninguna imagen" }); }
      else {
        requests++;
        const ri = await fetcher(parsed.imageUrls[0], { headers: { "user-agent": DEEP_DIVE_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        if (!ri.ok) { creativeStatus = "sin_imagen"; incomplete.push({ part: "creatividad", reason: `la imagen del anuncio respondió HTTP ${ri.status}` }); }
        else {
          const bytes = new Uint8Array(await ri.arrayBuffer());
          const mime = ri.headers.get("content-type")?.split(";")[0] || "image/jpeg";
          creative = await input.vision({ bytes, mime }, { keywords: input.keywords, adText });
          creativeStatus = creative ? "analizada" : "error";
          if (!creative) incomplete.push({ part: "creatividad", reason: "la IA de visión no devolvió un análisis válido" });
        }
      }
      // Vídeo → guion (OpenAI, solo audio)
      if (!parsed.videoUrls.length) videoStatus = "sin_video";
      else if (input.skipVideo) { videoStatus = "desactivado"; incomplete.push({ part: "vídeo", reason: "vídeo detectado, análisis de audio desactivado (--sin-video)" }); }
      else if (!input.video) { videoStatus = "sin_openai_key"; incomplete.push({ part: "vídeo", reason: "vídeo detectado, análisis de audio/movimiento no disponible: sin OPENAI_API_KEY" }); }
      else if (input.videoBudgetExhausted) { videoStatus = "tope_diario"; incomplete.push({ part: "vídeo", reason: "vídeo detectado, tope diario de transcripciones alcanzado (DEEP_DIVE_VIDEO_DAILY_LIMIT)" }); }
      else {
        try {
          requests++;
          const rv = await fetcher(parsed.videoUrls[0], { headers: { "user-agent": DEEP_DIVE_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
          if (!rv.ok) { videoStatus = "video_no_descargable"; incomplete.push({ part: "vídeo", reason: `vídeo detectado, no descargable sin sesión (HTTP ${rv.status}): análisis de audio/movimiento no disponible` }); }
          else {
            const bytes = new Uint8Array(await rv.arrayBuffer());
            const mime = rv.headers.get("content-type")?.split(";")[0] || "video/mp4";
            if (!bytes.byteLength) { videoStatus = "video_no_descargable"; incomplete.push({ part: "vídeo", reason: "vídeo detectado, el archivo llegó vacío" }); }
            else if (bytes.byteLength > DEEP_DIVE_VIDEO_MAX_BYTES) { videoStatus = "video_demasiado_grande"; incomplete.push({ part: "vídeo", reason: `vídeo de ${Math.round(bytes.byteLength / 1048576)} MB: supera los 25 MB que acepta la transcripción` }); }
            else {
              video = await input.video({ bytes, mime }, { keywords: input.keywords, adText });
              if (!video) { videoStatus = "error"; incomplete.push({ part: "vídeo", reason: "la transcripción no devolvió nada válido" }); }
              else if (!video.transcript) { videoStatus = "sin_audio"; incomplete.push({ part: "vídeo", reason: "vídeo sin voz (mudo o solo música): no hay guion que leer; lo visual no se analiza" }); }
              else { videoStatus = "analizada_audio"; incomplete.push({ part: "vídeo", reason: `guion analizado; ${video.limits}` }); }
            }
          }
        } catch (err) {
          videoStatus = "error";
          incomplete.push({ part: "vídeo", reason: `fallo al obtener o transcribir el vídeo: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
        }
      }
    } catch (err) {
      creativeStatus = "error";
      incomplete.push({ part: "creatividad", reason: `fallo al obtener o analizar la creatividad: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
    }
  }

  // 7 · veredicto, recomendación y texto claro
  const { verdict, reasoning: base } = decide({ catalogOk: catalog?.status === "ok", match, marginPct, activeAds: input.activeAds, daysActive, costEur: input.costEur, domain, priceEur });
  const reasoning = account ? `${base} · cuenta: ${accountSummary(account)}` : base;
  const recommendation = recommend({ verdict, reasoning: base, coherence: coherence.status, competitors: competitors?.count ?? null, marginPct, winnerDays: account?.winner?.daysActive ?? null, incomplete });
  const adLink = adId ? adLibraryLink(adId) : null;
  const adLinks = [...new Set(ads.map((a) => adLibraryLink(a.id)))].slice(0, 10);

  const report: DeepDiveReport = { adLink, adLinks, competitors, account, otherProducts, domain, domainSource, store, catalog, match, priceEur, priceMaxEur, costEur: input.costEur, marginEur, marginPct, priceCoherence: coherence, angles, creative, creativeStatus, video, videoStatus, activeAds: input.activeAds, daysActive, verdict, reasoning, recommendation, summary: "", incomplete, requests, rules: `${DEEP_DIVE_RULES} · recomendación: ${RECOMMENDATION_RULES}` };
  report.summary = summarize(report, input.keywords);
  return report;
}

/** Resumen de la cuenta para el razonamiento (informa; no cambia el veredicto: las reglas siguen siendo las escritas). */
export function accountSummary(a: AccountXray): string {
  const edad = a.daysAdvertising === null ? "antigüedad desconocida" : `anuncia desde ${a.firstAdStart} (${a.daysAdvertising} días)`;
  const vol = `${a.totalAds} anuncios, ${a.activeAds} activos${a.truncated ? " (cota inferior)" : ""}`;
  const top = a.angles.filter((g) => g.longestActiveDays !== null).slice(0, 2).map((g) => `${g.label.toLowerCase()} ${g.longestActiveDays} días`);
  return [edad, vol, top.length ? `ángulos más longevos: ${top.join(", ")}` : "sin ángulo activo clasificado"].join(" · ");
}

/** El veredicto en texto claro. Solo junta datos ya verificados; no redacta nada nuevo. */
export function summarize(r: DeepDiveReport, keywords: string[]): string {
  const p: string[] = [];
  const producto = r.match ? `«${r.match.product.title}»` : `«${keywords.join(" ")}»`;
  p.push(`${producto}${r.domain ? ` en ${r.domain}` : ""}: ${r.verdict.replace("_", " ").toUpperCase()}. Recomendación: ${r.recommendation.action.replace(/_/g, " ")} — ${r.recommendation.reason}.`);
  const gancho = r.account?.winner ? `Gancho/ángulo ganador: ${r.account.winner.label.toLowerCase()}, «${r.account.winner.quote}», activo sin cambios desde ${r.account.winner.since} (${r.account.winner.daysActive} días).` : r.angles?.angles[0] ? `Ángulo principal del anuncio: ${r.angles.angles[0].label.toLowerCase()}, «${r.angles.angles[0].evidence[0]?.quote ?? ""}».` : "Sin ángulo clasificable en el texto.";
  p.push(gancho);
  const avatar = r.account?.avatar.summary ? `A quién le habla: ${r.account.avatar.summary}${r.account.avatar.summarySource === "claude" ? " (redactado por Claude a partir de los textos)" : " (heurística de texto)"}.` : r.creative?.avatar ? `A quién le habla (según la imagen): ${r.creative.avatar}.` : r.video?.interpretation?.avatar ? `A quién le habla (según el guion): ${r.video.interpretation.avatar}.` : "Avatar: sin señales suficientes.";
  p.push(avatar);
  if (r.account) p.push(`La tienda anuncia desde ${r.account.firstAdStart ?? "?"} (${r.account.daysAdvertising ?? "?"} días): ${r.account.totalAds} anuncios, ${r.account.activeAds} activos. Ritmo de testeo ${r.account.testing?.level ?? "?"} (${r.account.testing?.newAds30d ?? "?"} nuevos en 30 días, ${r.account.testing?.perWeek30d ?? "?"}/semana); madurez del ángulo ganador: ${r.account.winner ? `${r.account.winner.daysActive} días` : "sin ángulo activo"}.`);
  p.push(`Precio real ${r.priceEur !== null ? `${r.priceEur} €` : "no verificable"}${r.costEur !== null ? `, coste Dropea ${r.costEur} €` : ""}${r.marginPct !== null ? `, margen real ${Math.round(r.marginPct * 100)} %` : ", margen no calculable"}. ${r.priceCoherence.status === "difiere" ? r.priceCoherence.note : `Precio del anuncio: ${r.priceCoherence.status.replace(/_/g, " ")}.`}`);
  p.push(r.competitors ? `Competencia: ${r.competitors.count} tienda${r.competitors.count === 1 ? "" : "s"} más anunciando lo mismo ahora${r.competitors.pages.length ? ` (${r.competitors.pages.slice(0, 3).map((c) => c.pageName ?? c.pageId).join(", ")})` : ""}.` : "Competencia: no medida.");
  if (r.video) p.push(`Vídeo: gancho hablado «${r.video.hookFirstSeconds ?? "—"}», ${r.video.durationSec ?? "?"} s, ${r.video.wordsPerMinute ?? "?"} palabras/min${r.video.interpretation?.cta ? `, CTA «${r.video.interpretation.cta}»` : ""}. ${r.video.limits}.`);
  else if (r.videoStatus !== "sin_video") p.push(`Vídeo detectado, análisis de audio/movimiento no disponible (${r.videoStatus.replace(/_/g, " ")}).`);
  if (r.otherProducts.length) p.push(`Otros productos activos en la misma tienda: ${r.otherProducts.slice(0, 4).map((o) => `«${o.label}» (${o.longestActiveDays ?? "?"} días${o.dropea.matches.length ? `, en Dropea: ${o.dropea.matches[0].name}` : o.dropea.searched ? ", no en Dropea" : ""})`).join("; ")}.`);
  if (r.adLink) p.push(`Comprobar a mano: ${r.adLink}`);
  return p.join(" ");
}

function decide(x: { catalogOk: boolean; match: CatalogMatch | null; marginPct: number | null; activeAds: number | null; daysActive: number | null; costEur: number | null; domain: string | null; priceEur: number | null }): { verdict: DeepDiveVerdict; reasoning: string } {
  if (!x.domain) return { verdict: "no_verificable", reasoning: "sin dominio declarado en el anuncio: no hay tienda que leer" };
  if (!x.catalogOk) return { verdict: "no_verificable", reasoning: `catálogo de ${x.domain} no accesible: no se puede verificar precio ni producto` };
  if (!x.match) return { verdict: "no_verificable", reasoning: "el catálogo no contiene un producto que case con las palabras clave" };
  if (x.match.product.available === false) return { verdict: "descartar", reasoning: `«${x.match.product.title}» figura como no disponible en la tienda` };
  if (x.costEur === null || x.marginPct === null) return { verdict: "no_verificable", reasoning: `producto «${x.match.product.title}» a ${x.priceEur ?? "?"} €, pero sin coste de Dropea no hay margen real` };
  const pct = Math.round(x.marginPct * 100);
  const base = `«${x.match.product.title}» a ${x.priceEur} € en ${x.domain} (match ${x.match.verdict}, cobertura ${Math.round(x.match.coverage * 100)} %) · coste ${x.costEur} € · margen real ${pct} % · ${x.activeAds ?? "?"} activos · ${x.daysActive ?? "?"} días`;
  if (x.marginPct < 0.3) return { verdict: "descartar", reasoning: `${base} → margen real por debajo del 30 %` };
  const fuerte = x.match.verdict === "si" && x.marginPct >= 0.5 && (x.activeAds ?? 0) >= 2 && (x.daysActive ?? 0) >= 14;
  if (fuerte) return { verdict: "ganador_probable", reasoning: `${base} → cumple las cuatro condiciones` };
  const faltan: string[] = [];
  if (x.match.verdict !== "si") faltan.push("match dudoso");
  if (x.marginPct < 0.5) faltan.push("margen < 50 %");
  if ((x.activeAds ?? 0) < 2) faltan.push("menos de 2 activos");
  if ((x.daysActive ?? 0) < 14) faltan.push("menos de 14 días");
  return { verdict: "senal_debil", reasoning: `${base} → falta: ${faltan.join(", ")}` };
}

export type { DiscoveryGroup };
