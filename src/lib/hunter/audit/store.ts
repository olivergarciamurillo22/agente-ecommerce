// ============================================================
// LECTOR DE TIENDAS AJENAS (07-09-2026) — docs/HUNTER-AUDITOR.md
//
// Dada la URL de una tienda: qué es (Shopify o no), cómo se llama, a qué
// página de Facebook enlaza y, si es Shopify, su catálogo público.
//
// REGLAS, las mismas del scraping público del Hunter (`scraping-publico.ts`):
//  - User-Agent propio y honesto, sin falsear cabeceras.
//  - Timeout corto, tope de tamaño, dos intentos como mucho.
//  - Un 401/403/429, una redirección a login o un captcha se declaran como
//    "no accesible" y se para: no se sortea ningún bloqueo.
//  - Solo `https:`.
//
// /products.json NO es scraping: Shopify lo expone a propósito para consumo
// público (cualquier tema lo usa). Aun así, se lee con límite de páginas.
// ============================================================

import { canRunDiscovery } from "../../safety";

export const STORE_READER_USER_AGENT = "Casamable-Hunter-Auditor/1.0 (+https://casamable.com/contacto)";
export const STORE_READER_TIMEOUT_MS = 8_000;
export const STORE_READER_HALTED = "EMERGENCY_STOP activo: no se lee ninguna web ajena";
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** Páginas de 250 productos que se leen como máximo: 1.000 productos sobran para un auditor. */
export const MAX_CATALOG_PAGES = 4;

export type CatalogStatus = "ok" | "no_shopify" | "no_accesible" | "vacio";

export interface CatalogProduct {
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  priceMin: number | null;
  priceMax: number | null;
  /** Precio «antes» (compare_at_price) más alto de las variantes, si la tienda lo muestra. */
  compareAtMax?: number | null;
  variants: number;
  images: number;
  available: boolean | null;
  createdAt: string | null;
  url: string;
}

export interface StoreCatalog {
  status: CatalogStatus;
  reason: string | null;
  products: CatalogProduct[];
  pagesRead: number;
  /** true si había más páginas y se paró por el tope. */
  truncated: boolean;
}

export interface StoreProfile {
  /** URL normalizada (https, sin ruta). */
  origin: string;
  domain: string;
  /** Nombre de la marca: og:site_name, si no og:title, si no <title>. */
  brandName: string | null;
  brandNameSource: "og:site_name" | "og:title" | "title" | null;
  /** Enlaces a facebook.com/<algo> encontrados en la web, ya limpios. */
  facebookUrls: string[];
  instagramUrls: string[];
  /** Pistas de que es Shopify, con lo que las delató. */
  shopifyHints: string[];
  isShopify: boolean;
  /** Si la web no se pudo leer: por qué. */
  homepageStatus: "ok" | "no_accesible";
  homepageReason: string | null;
  /** Texto visible de la portada (sin etiquetas, scripts ni estilos), recortado. Para señales de «empresa real» (búsqueda 3). */
  homepageText?: string;
}

export function visibleText(html: string, max = 8000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

export interface StoreRead {
  profile: StoreProfile;
  catalog: StoreCatalog;
  requests: number;
}

const strip = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

export function normalizeStoreUrl(input: string): { origin: string; domain: string } | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
    return { origin: `https://${url.hostname.toLowerCase()}`, domain };
  } catch {
    return null;
  }
}

function blockedReason(response: Response, body: string): string | null {
  if (response.status === 403 || response.status === 401 || response.status === 429) return `HTTP ${response.status}`;
  const target = response.url || response.headers.get("location") || "";
  if (/\/(login|signin|password)\b/i.test(target)) return "redirección a login (tienda protegida por contraseña)";
  // OJO: la palabra "captcha" NO delata un bloqueo. Toda portada Shopify lleva
  // un script "captcha-bootstrap" para sus formularios (comprobado en
  // casamable.es el 07-09). Un desafío real es una página pequeña que solo
  // dice "verifica que eres humano", o el interstitial de Cloudflare.
  const desafio = /verify you are human|robot check|security verification|attention required|cf-challenge|challenge-platform|just a moment/i.test(body);
  if (desafio && body.length < 20_000) return "desafío anti-bot detectado";
  return null;
}

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
  const m = html.match(re) ?? html.match(alt);
  return m ? strip(decode(m[1])) || null : null;
}

/** Enlaces sociales reales: fuera sharer, dialog, plugins, tr (píxel) y login. */
function socialLinks(html: string, host: "facebook.com" | "instagram.com"): string[] {
  const out = new Set<string>();
  const re = new RegExp(`https?://(?:www\\.|m\\.|es-es\\.)?${host.replace(".", "\\.")}/([A-Za-z0-9._%-]+)(?:/)?`, "gi");
  for (const m of html.matchAll(re)) {
    const slug = m[1].toLowerCase();
    if (["sharer", "sharer.php", "dialog", "plugins", "tr", "login", "share", "share.php", "hashtag", "explore", "p", "reel", "stories", "policies", "privacy", "help", "profile.php", "groups", "events", "watch", "marketplace", "pages"].includes(slug)) continue;
    if (/\.(js|css|png|jpg|svg)$/.test(slug)) continue;
    out.add(`https://www.${host}/${m[1]}`);
  }
  return [...out].slice(0, 5);
}

function shopifyHints(html: string, response: Response): string[] {
  const hints: string[] = [];
  if (/cdn\.shopify\.com/i.test(html)) hints.push("cdn.shopify.com en el HTML");
  if (/Shopify\.theme|Shopify\.shop|window\.Shopify/i.test(html)) hints.push("objeto Shopify en el HTML");
  if (/\/cdn\/shop\//i.test(html)) hints.push("rutas /cdn/shop/ de Shopify");
  const shopId = response.headers.get("x-shopid") ?? response.headers.get("x-shopify-stage");
  if (shopId) hints.push("cabecera x-shopid / x-shopify-stage");
  if (/powered by shopify/i.test(html)) hints.push("«Powered by Shopify»");
  return hints;
}

async function fetchText(url: string, fetcher: typeof fetch, accept: string, maxBytes: number): Promise<{ ok: true; response: Response; body: string } | { ok: false; reason: string; status: number }> {
  // GATE (safety.ts): con la parada de emergencia no se lee ninguna web ajena,
  // ni siquiera la portada. Mismo criterio que la Ad Library.
  if (!canRunDiscovery()) return { ok: false, reason: STORE_READER_HALTED, status: 0 };
  let ultimo = "sin respuesta";
  for (let intento = 0; intento < 2; intento++) {
    try {
      const response = await fetcher(url, {
        headers: { "user-agent": STORE_READER_USER_AGENT, accept },
        redirect: "follow",
        signal: AbortSignal.timeout(STORE_READER_TIMEOUT_MS),
      });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "respuesta demasiado grande", status: response.status };
      const body = (await response.text()).slice(0, maxBytes);
      const blocked = blockedReason(response, body);
      if (blocked) return { ok: false, reason: blocked, status: response.status };
      if (!response.ok) {
        ultimo = `HTTP ${response.status}`;
        if (response.status >= 500 && intento === 0) continue;
        return { ok: false, reason: ultimo, status: response.status };
      }
      return { ok: true, response, body };
    } catch (err) {
      ultimo = err instanceof Error ? err.message.slice(0, 120) : "error de red";
    }
  }
  return { ok: false, reason: ultimo, status: 0 };
}

export async function readStoreProfile(input: string, fetcher: typeof fetch = fetch): Promise<{ profile: StoreProfile; requests: number }> {
  const norm = normalizeStoreUrl(input);
  if (!norm) {
    return {
      profile: { origin: input, domain: input, brandName: null, brandNameSource: null, facebookUrls: [], instagramUrls: [], shopifyHints: [], isShopify: false, homepageStatus: "no_accesible", homepageReason: "URL no válida" },
      requests: 0,
    };
  }
  const r = await fetchText(`${norm.origin}/`, fetcher, "text/html", MAX_HTML_BYTES);
  if (!r.ok) {
    return {
      profile: { ...norm, brandName: null, brandNameSource: null, facebookUrls: [], instagramUrls: [], shopifyHints: [], isShopify: false, homepageStatus: "no_accesible", homepageReason: r.reason },
      // Con la parada no ha salido ninguna petición: no se cuenta.
      requests: r.reason === STORE_READER_HALTED ? 0 : 1,
    };
  }
  const html = r.body;
  const siteName = meta(html, "og:site_name");
  const ogTitle = meta(html, "og:title");
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleTag ? strip(decode(titleTag[1])) || null : null;
  const brand = siteName ? { v: siteName, s: "og:site_name" as const } : ogTitle ? { v: ogTitle, s: "og:title" as const } : title ? { v: title, s: "title" as const } : null;
  const hints = shopifyHints(html, r.response);
  return {
    profile: {
      ...norm,
      brandName: brand?.v ?? null,
      brandNameSource: brand?.s ?? null,
      facebookUrls: socialLinks(html, "facebook.com"),
      instagramUrls: socialLinks(html, "instagram.com"),
      shopifyHints: hints,
      isShopify: hints.length > 0,
      homepageStatus: "ok",
      homepageReason: null,
      homepageText: visibleText(html),
    },
    requests: 1,
  };
}

interface ShopifyProductJson {
  title?: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  created_at?: string;
  variants?: Array<{ price?: string | number; available?: boolean }>;
  images?: unknown[];
}

function toProduct(origin: string, p: ShopifyProductJson): CatalogProduct | null {
  const title = strip(String(p.title ?? ""));
  const handle = strip(String(p.handle ?? ""));
  if (!title || !handle) return null;
  const precios = (p.variants ?? []).map((v) => Number(v.price)).filter((n) => Number.isFinite(n) && n >= 0);
  const disponibles = (p.variants ?? []).map((v) => v.available).filter((v): v is boolean => typeof v === "boolean");
  const antes = (p.variants ?? []).map((v) => Number((v as { compare_at_price?: unknown }).compare_at_price)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    title: title.slice(0, 200),
    handle: handle.slice(0, 200),
    vendor: p.vendor ? strip(String(p.vendor)).slice(0, 120) : null,
    productType: p.product_type ? strip(String(p.product_type)).slice(0, 120) : null,
    priceMin: precios.length ? Math.min(...precios) : null,
    priceMax: precios.length ? Math.max(...precios) : null,
    compareAtMax: antes.length ? Math.max(...antes) : null,
    variants: (p.variants ?? []).length,
    images: Array.isArray(p.images) ? p.images.length : 0,
    available: disponibles.length ? disponibles.some(Boolean) : null,
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
    url: `${origin}/products/${handle}`,
  };
}

/**
 * Catálogo público de Shopify: /products.json?limit=250&page=N. Si el primer
 * intento no devuelve JSON con `products[]`, la tienda no es Shopify (o lo
 * tiene cerrado) y se dice; no se adivina un catálogo.
 */
export async function readShopifyCatalog(origin: string, fetcher: typeof fetch = fetch, maxPages = MAX_CATALOG_PAGES): Promise<{ catalog: StoreCatalog; requests: number }> {
  const products: CatalogProduct[] = [];
  let requests = 0;
  let pagesRead = 0;
  for (let page = 1; page <= maxPages; page++) {
    requests++;
    const r = await fetchText(`${origin}/products.json?limit=250&page=${page}`, fetcher, "application/json", MAX_JSON_BYTES);
    if (!r.ok) {
      if (page === 1) return { catalog: { status: r.status === 404 ? "no_shopify" : "no_accesible", reason: r.reason, products: [], pagesRead: 0, truncated: false }, requests };
      break; // páginas posteriores: nos quedamos con lo leído
    }
    let json: { products?: unknown } | null = null;
    try {
      json = JSON.parse(r.body) as { products?: unknown };
    } catch {
      json = null;
    }
    if (!json || !Array.isArray(json.products)) {
      if (page === 1) return { catalog: { status: "no_shopify", reason: "la ruta /products.json no devuelve un catálogo Shopify", products: [], pagesRead: 0, truncated: false }, requests };
      break;
    }
    pagesRead++;
    const lote = (json.products as ShopifyProductJson[]).map((p) => toProduct(origin, p)).filter((p): p is CatalogProduct => p !== null);
    products.push(...lote);
    if (lote.length < 250) return { catalog: { status: products.length ? "ok" : "vacio", reason: products.length ? null : "la tienda no publica productos", products, pagesRead, truncated: false }, requests };
  }
  return { catalog: { status: products.length ? "ok" : "vacio", reason: null, products, pagesRead, truncated: products.length >= 250 * maxPages }, requests };
}

/** Perfil + catálogo en una sola llamada. */
export async function readStore(input: string, fetcher: typeof fetch = fetch, maxPages = MAX_CATALOG_PAGES): Promise<StoreRead> {
  const { profile, requests } = await readStoreProfile(input, fetcher);
  if (profile.homepageStatus !== "ok") {
    return { profile, catalog: { status: "no_accesible", reason: profile.homepageReason, products: [], pagesRead: 0, truncated: false }, requests };
  }
  // Se intenta el catálogo aunque no haya pistas de Shopify: hay temas que no
  // las dejan en la portada y /products.json responde igual.
  const cat = await readShopifyCatalog(profile.origin, fetcher, maxPages);
  if (cat.catalog.status === "ok" && !profile.isShopify) profile.shopifyHints.push("/products.json responde con catálogo");
  return { profile: { ...profile, isShopify: profile.isShopify || cat.catalog.status === "ok" }, catalog: cat.catalog, requests: requests + cat.requests };
}
