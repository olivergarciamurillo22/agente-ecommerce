// ============================================================
// NIVEL 2 · DEEP DIVE de un candidato del cruce (09-09-2026)
// docs/HUNTER-DEEP-DIVE.md
//
// Diseño reducido tras la sonda real del 09-09 («cojin gel silla»):
//   · la URL de destino del anuncio NO está en la API ni en render_ad
//     (outboundUrls: []), así que NO se intenta;
//   · el DOMINIO sí: ad_creative_link_captions (ya en el nivel 1) traía
//     cloudcore.es;
//   · cloudcore.es/products.json responde (Shopify): el cojín está a 34,99 €.
//
// Por candidato, en orden, cada paso con su motivo si no se pudo:
//   1 · dominio declarado en los captions (sin red);
//   2 · portada + catálogo público /products.json (readStore, ya existente);
//   3 · producto del catálogo que casa con las palabras clave del cruce;
//   4 · precio REAL de ese producto y margen contra el coste de Dropea;
//   5 · ángulos del TEXTO del anuncio (extractAngles, con cita literal);
//   6 · (opcional) imagen del anuncio vía render_ad + visión por OpenRouter
//       (anthropic/claude-haiku-4.5 admite imágenes; confirmado el 09-09);
//   7 · veredicto con reglas escritas y su razonamiento.
// Fail-closed: sin catálogo no hay precio; sin precio no hay margen; nada se
// estima. Vídeo: no soportado por ahora (se dice, no se descarta el informe).
// ============================================================

import type { AdLibraryAd } from "../discovery/types";
import { declaredDomains } from "../discovery/signals";
import { readStore, type CatalogProduct, type StoreProfile } from "../audit/store";
import { extractAngles, type AngleReport } from "../audit/angles";
import { tokens } from "../../product-hunter/internal/dropea-catalog";
import { parseRenderAdHtml, renderAdUrl, DEEP_DIVE_USER_AGENT } from "./render-ad";

const DAY = 86_400;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type DeepDiveVerdict = "ganador_probable" | "senal_debil" | "descartar" | "no_verificable";

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

export interface DeepDiveInput {
  keywords: string[];
  ads: AdLibraryAd[];
  costEur: number | null;
  activeAds: number | null;
  oldestActiveAt: number | null;
  now?: number;
  fetcher?: typeof fetch;
  /** Token de la Ad Library, SOLO para render_ad en memoria. Sin él no hay visión. */
  token?: string | null;
  vision?: VisionFn | null;
  /** Dominio forzado (modo manual del CLI). */
  domainOverride?: string | null;
}

export interface CatalogMatch {
  product: CatalogProduct;
  coverage: number;
  verdict: "si" | "dudoso";
}

export interface DeepDiveReport {
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
  angles: AngleReport | null;
  creative: CreativeAnalysis | null;
  creativeStatus: "analizada" | "sin_imagen" | "sin_token" | "sin_vision" | "video_no_soportado" | "error";
  activeAds: number | null;
  daysActive: number | null;
  verdict: DeepDiveVerdict;
  reasoning: string;
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

export async function runDeepDive(input: DeepDiveInput): Promise<DeepDiveReport> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const fetcher = input.fetcher ?? fetch;
  const incomplete: DeepDiveReport["incomplete"] = [];
  let requests = 0;
  const daysActive = input.oldestActiveAt !== null ? Math.max(0, Math.floor((now - input.oldestActiveAt) / DAY)) : null;

  // 1 · dominio
  let domain: string | null = null;
  let domainSource: DeepDiveReport["domainSource"] = null;
  if (input.domainOverride) { domain = input.domainOverride.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; domainSource = "manual"; }
  else {
    const dominios = declaredDomains(input.ads).filter((d) => !/(^|\.)(facebook|instagram|whatsapp|fb|messenger)\.(com|me)$/i.test(d));
    if (dominios.length) { domain = dominios[0]; domainSource = "caption"; }
  }
  if (!domain) incomplete.push({ part: "tienda", reason: "el anuncio no declara ningún dominio en sus captions (y la URL de destino no está disponible en la API ni en render_ad)" });

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

  // 4 · precio y margen REALES
  const priceEur = match?.product.priceMin ?? null;
  const priceMaxEur = match?.product.priceMax ?? null;
  let marginEur: number | null = null, marginPct: number | null = null;
  if (priceEur !== null && input.costEur !== null && priceEur > 0) { marginEur = round2(priceEur - input.costEur); marginPct = round2(marginEur / priceEur); }
  else if (match && input.costEur === null) incomplete.push({ part: "margen", reason: "sin coste de Dropea para este producto" });
  if (match && match.product.available === false) incomplete.push({ part: "disponibilidad", reason: "el producto figura como no disponible en la tienda" });

  // 5 · ángulos del texto (cita literal)
  const angles = input.ads.length ? extractAngles(input.ads) : null;

  // 6 · visión (opcional)
  let creative: CreativeAnalysis | null = null;
  let creativeStatus: DeepDiveReport["creativeStatus"] = "sin_vision";
  const adId = input.ads[0]?.id ?? null;
  if (!input.vision) creativeStatus = "sin_vision";
  else if (!input.token) { creativeStatus = "sin_token"; incomplete.push({ part: "creatividad", reason: "sin token de la Ad Library no se puede pedir render_ad" }); }
  else if (!adId) { creativeStatus = "sin_imagen"; }
  else {
    try {
      requests++;
      const r = await fetcher(renderAdUrl(adId, input.token), { headers: { "user-agent": DEEP_DIVE_USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      const parsed = parseRenderAdHtml(await r.text());
      if (parsed.videoUrls.length && !parsed.imageUrls.length) { creativeStatus = "video_no_soportado"; incomplete.push({ part: "creatividad", reason: "el anuncio es un vídeo: no soportado por ahora (sin ffmpeg)" }); }
      else if (!parsed.imageUrls.length) { creativeStatus = "sin_imagen"; incomplete.push({ part: "creatividad", reason: parsed.blocked ? `render_ad devolvió ${parsed.blocked}` : "render_ad no trajo ninguna imagen" }); }
      else {
        requests++;
        const ri = await fetcher(parsed.imageUrls[0], { headers: { "user-agent": DEEP_DIVE_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        if (!ri.ok) { creativeStatus = "sin_imagen"; incomplete.push({ part: "creatividad", reason: `la imagen del anuncio respondió HTTP ${ri.status}` }); }
        else {
          const bytes = new Uint8Array(await ri.arrayBuffer());
          const mime = ri.headers.get("content-type")?.split(";")[0] || "image/jpeg";
          const adText = input.ads.flatMap((a) => [...a.bodies, ...a.titles]).join(" | ").slice(0, 1500);
          creative = await input.vision({ bytes, mime }, { keywords: input.keywords, adText });
          creativeStatus = creative ? "analizada" : "error";
          if (!creative) incomplete.push({ part: "creatividad", reason: "la IA de visión no devolvió un análisis válido" });
        }
      }
    } catch (err) {
      creativeStatus = "error";
      incomplete.push({ part: "creatividad", reason: `fallo al obtener o analizar la imagen: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
    }
  }

  // 7 · veredicto
  const { verdict, reasoning } = decide({ catalogOk: catalog?.status === "ok", match, marginPct, activeAds: input.activeAds, daysActive, costEur: input.costEur, domain, priceEur });

  return { domain, domainSource, store, catalog, match, priceEur, priceMaxEur, costEur: input.costEur, marginEur, marginPct, angles, creative, creativeStatus, activeAds: input.activeAds, daysActive, verdict, reasoning, incomplete, requests, rules: DEEP_DIVE_RULES };
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
