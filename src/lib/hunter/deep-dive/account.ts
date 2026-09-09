// ============================================================
// NIVEL 2 · RADIOGRAFÍA DE LA CUENTA ANUNCIANTE (09-09-2026)
// docs/HUNTER-DEEP-DIVE.md
//
// En cuanto un candidato tiene match, en vez de buscar por palabra se pide
// a /ads_archive TODO lo de esa página con search_page_ids=<page_id>,
// activos e inactivos (ad_active_status=ALL), con fechas de inicio y fin.
// De ahí sale lo que no se ve mirando un solo anuncio:
//   · desde cuándo anuncia la tienda de verdad (el anuncio más antiguo de
//     toda la cuenta, no del producto que casó);
//   · volumen real: cuántos anuncios en total y cuántos activos ahora;
//   · qué ÁNGULOS repite y cuáles lleva más tiempo sin apagar: se clasifica
//     cada anuncio con las mismas reglas de texto del auditor (ANGLE_RULES)
//     y, por ángulo, el activo más antiguo; si no funcionaran, los habrían
//     apagado;
//   · a quién le habla la cuenta en conjunto: patrón de AVATAR por
//     heurística de texto (etiqueta + cita), y, si hay OPENROUTER_API_KEY,
//     una consolidación en texto por Claude (marcada como tal).
//
// Coste: 1 petición por cada 100 anuncios de la cuenta, con tope de páginas
// (ACCOUNT_MAX_PAGES) y presupuesto del discovery. search_page_ids es el
// mismo endpoint y el mismo límite de 100 por página que la búsqueda por
// palabra; la sonda del NAS lo confirma en vivo (paso 5).
// ============================================================

import type { AdLibraryAd } from "../discovery/types";
import type { AdLibraryClient } from "../discovery/client";
import { DiscoveryBudget, type StopReason } from "../discovery/budget";
import { ANGLE_RULES, normalizeAngleText, sentences, type AngleId } from "../audit/angles";

export const ACCOUNT_MAX_PAGES = 5;
/**
 * Ventana de fechas: la Ad Library exige min/max y SOLO admite
 * ad_delivery_date_min dentro de [2018-05-07 – hoy]. El 09-09-2026, en
 * producción, «2018-01-01» devolvió HTTP 400 code 100 subcode 2334029
 * («The ad_delivery_date_min is invalid. It must in [2018-05-07 - Today]»).
 * 2018-05-07 es el día en que Meta empezó a archivar anuncios: cubre toda
 * cuenta comercial en España.
 */
export const ACCOUNT_SINCE = "2018-05-07";
const DAY = 86_400;

/**
 * Límite superior: «hoy» según Meta. Su «Today» se evalúa en hora del
 * Pacífico, así que la fecha UTC del NAS (Madrid, UTC+2) iría un día por
 * delante entre las 00:00 y las 09:00 hora peninsular. Se toma la fecha de
 * (ahora − 8 h): nunca cae en el futuro para Meta y, como mucho, deja fuera
 * los anuncios estrenados hoy, que para la radiografía histórica no cuentan.
 */
export function accountDateWindow(now: number): { since: string; until: string } {
  const until = new Date((now - 8 * 3600) * 1000).toISOString().slice(0, 10);
  return { since: ACCOUNT_SINCE, until: until < ACCOUNT_SINCE ? ACCOUNT_SINCE : until };
}

export interface AccountAngle {
  id: AngleId;
  label: string;
  ads: number;
  activeAds: number;
  /** Inicio del anuncio ACTIVO más antiguo con este ángulo. */
  oldestActiveStart: string | null;
  longestActiveDays: number | null;
  /** Cita literal del anuncio activo más antiguo (evidencia). */
  evidence: { adId: string; quote: string } | null;
}

export interface AvatarSignal {
  label: string;
  ads: number;
  evidence: { adId: string; quote: string };
}

/** Ritmo de testeo de la cuenta: cuántos anuncios NUEVOS estrena por semana (últimos 30 días). */
export interface AccountTesting {
  newAds30d: number;
  newAds90d: number;
  perWeek30d: number;
  level: "alto" | "medio" | "bajo";
  /** Regla literal, para que el informe se pueda reconstruir. */
  rule: string;
}

/** Madurez del ángulo ganador: el anuncio ACTIVO más antiguo de ese ángulo, sin interrupción. */
export interface AccountWinner {
  angle: AngleId;
  label: string;
  adId: string;
  since: string;
  daysActive: number;
  quote: string;
  adLink: string;
}

/** Un producto físico distinto detectado entre los anuncios ACTIVOS de la cuenta (agrupación por texto). */
export interface AccountProduct {
  label: string;
  keywords: string[];
  ads: number;
  adIds: string[];
  oldestActiveStart: string | null;
  longestActiveDays: number | null;
  sample: string;
  adLink: string;
  /** true si es el producto que originó la búsqueda (casa con las palabras clave del candidato). */
  isOriginal: boolean;
}

/**
 * Diversidad del catálogo de la cuenta (10-09): una tienda de dropshipping
 * prueba productos sin relación entre sí (purificador, báscula, luces LED,
 * gafas); una marca establecida vende solo su línea (ghd: planchas y más
 * planchas). Con ≥ 3 productos minados, si una misma raíz de palabra (fuera
 * la marca/página/dominio) domina ≥ 70 % de ellos o el solape medio de
 * palabras es ≥ 0,25, el catálogo es «concentrado»: posible marca propia.
 */
export interface CatalogDiversity {
  products: number;
  level: "concentrado" | "disperso" | "insuficiente";
  dominant: { stem: string; share: number } | null;
  meanJaccard: number | null;
  note: string;
  rule: string;
}

export interface AccountXray {
  pageId: string;
  pageName: string | null;
  totalAds: number;
  activeAds: number;
  inactiveAds: number;
  /** Anuncio más antiguo de TODA la cuenta (activo o no). */
  firstAdStart: string | null;
  daysAdvertising: number | null;
  /** Anuncio ACTIVO más antiguo de la cuenta. */
  oldestActiveStart: string | null;
  /** Ángulos, los de activos más antiguos primero: los «ganadores» de esa tienda. */
  angles: AccountAngle[];
  /** Señal de madurez (dos números separados a propósito): ritmo de testeo de la cuenta y madurez del ángulo ganador. */
  testing: AccountTesting | null;
  winner: AccountWinner | null;
  /** Productos distintos detectados entre los activos (minería de más ganadores de la misma tienda). */
  products: AccountProduct[];
  /** ¿Catálogo disperso (COD/dropshipping) o concentrado (posible marca propia)? */
  diversity: CatalogDiversity;
  avatar: { signals: AvatarSignal[]; summary: string | null; summarySource: "heuristica" | "claude" | null };
  requests: number;
  pages: number;
  truncated: boolean;
  stopReason: StopReason;
  nature: "heuristica_sobre_texto_real";
}

/** Reglas de AVATAR: a quién le habla el texto. Heurística con cita, no diagnóstico. */
export const AVATAR_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "personas mayores / seniors", patterns: [/\b(mayores|senior|abuel[oa]s?|tercera edad|jubilad[oa]s?|a partir de los 6\d)\b/] },
  { label: "madres, embarazo y bebés", patterns: [/\b(mam[aá]s?|embaraz\w+|postparto|beb[eé]s?|reci[eé]n nacid[oa])\b/] },
  { label: "familias con niños", patterns: [/\b(ni[nñ][oa]s|peques|hij[oa]s|colegio|infantil)\b/] },
  { label: "mujeres", patterns: [/\b(mujer(es)?|ella|femenin[oa]|chicas)\b/] },
  { label: "hombres", patterns: [/\b(hombres?|masculin[oa]|barba|afeitad[oa]|chicos)\b/] },
  { label: "dolor articular, espalda o cuello", patterns: [/\b(dolor(es)? de (espalda|cuello|rodilla|cervical|lumbar|coxis|cadera)|lumbares|cervicales|ci[aá]tica|artrosis|articulaci)/] },
  { label: "trabajo sentado / oficina / teletrabajo", patterns: [/\b(oficina|teletrabajo|escritorio|sentad[oa]s?|silla de oficina|jornada)\b/] },
  { label: "dueños de mascotas", patterns: [/\b(mascotas?|perr[oa]s?|gat[oa]s?|peludo)\b/] },
  { label: "hogar y cocina", patterns: [/\b(cocina|hogar|casa|limpieza|ba[nñ]o|sal[oó]n)\b/] },
  { label: "deporte y forma física", patterns: [/\b(gym|gimnasio|deport\w+|entren\w+|fitness|running|yoga)\b/] },
  { label: "conductores", patterns: [/\b(coche|conducir|conductor(es)?|volante|carretera)\b/] },
  { label: "salud y bienestar general", patterns: [/\b(salud|bienestar|descanso|dormir|sue[nñ]o|estr[eé]s|ansiedad)\b/] },
];

const adText = (ad: AdLibraryAd) => [...ad.bodies, ...ad.titles, ...(ad.descriptions ?? [])].join("\n");
const isActive = (ad: AdLibraryAd) => !ad.stopTime;
const startSec = (ad: AdLibraryAd) => { const t = ad.startTime ? Date.parse(ad.startTime) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };

/** Clasifica un anuncio en sus ángulos (ids) y devuelve la primera frase que casó por ángulo. */
export function anglesOfAd(ad: AdLibraryAd): Map<AngleId, string> {
  const out = new Map<AngleId, string>();
  for (const frase of sentences(adText(ad))) {
    const plano = normalizeAngleText(frase);
    for (const rule of ANGLE_RULES) if (!out.has(rule.id) && rule.patterns.some((re) => re.test(plano))) out.set(rule.id, frase.trim().slice(0, 180));
  }
  return out;
}

export function avatarSignals(ads: AdLibraryAd[]): AvatarSignal[] {
  const porLabel = new Map<string, AvatarSignal>();
  for (const ad of ads) {
    const vistos = new Set<string>();
    for (const frase of sentences(adText(ad))) {
      const plano = normalizeAngleText(frase);
      for (const rule of AVATAR_RULES) {
        if (vistos.has(rule.label) || !rule.patterns.some((re) => re.test(plano))) continue;
        vistos.add(rule.label);
        const prev = porLabel.get(rule.label);
        if (prev) prev.ads += 1; else porLabel.set(rule.label, { label: rule.label, ads: 1, evidence: { adId: ad.id, quote: frase.trim().slice(0, 180) } });
      }
    }
  }
  return [...porLabel.values()].sort((a, b) => b.ads - a.ads);
}

export const adLibraryLink = (adId: string) => `https://www.facebook.com/ads/library/?id=${adId}`;

/**
 * Ritmo de testeo: anuncios estrenados en los últimos 30 días, por semana.
 * ≥ 5/semana = alto (sigue probando o refresca creatividad por fatiga),
 * ≥ 1,5/semana = medio, si no bajo (mantiene lo que ya tiene).
 */
export const TESTING_RULE = "alto ≥ 5 anuncios nuevos/semana (últimos 30 días) · medio ≥ 1,5 · bajo < 1,5";
export function testingRhythm(ads: AdLibraryAd[], now: number): AccountTesting | null {
  const inicios = ads.map(startSec).filter((n): n is number => n !== null);
  if (!inicios.length) return null;
  const newAds30d = inicios.filter((t) => now - t <= 30 * DAY).length;
  const newAds90d = inicios.filter((t) => now - t <= 90 * DAY).length;
  const perWeek30d = Math.round((newAds30d / 30) * 7 * 10) / 10;
  return { newAds30d, newAds90d, perWeek30d, level: perWeek30d >= 5 ? "alto" : perWeek30d >= 1.5 ? "medio" : "bajo", rule: TESTING_RULE };
}

/** Palabras que hablan de CÓMO se vende, no de QUÉ: fuera al agrupar por producto. */
const PRODUCT_STOP = new Set(["de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "con", "sin", "para", "por", "en", "a", "al", "que", "es", "se", "su", "sus", "tu", "tus", "te", "lo", "le", "mi", "mis", "ya", "no", "si", "más", "mas", "muy", "como", "este", "esta", "esto", "ese", "esa", "eso", "hay", "hoy", "ahora", "aqui", "aquí", "solo", "sólo", "todo", "toda", "todos", "todas", "cada", "cualquier", "gratis", "envio", "envío", "envios", "oferta", "ofertas", "descuento", "rebaja", "rebajas", "precio", "precios", "euros", "eur", "unidades", "unidad", "pack", "compra", "compralo", "cómpralo", "pide", "pidelo", "pídelo", "consigue", "consiguelo", "aprovecha", "ultimas", "últimas", "ultimos", "últimos", "dias", "días", "garantia", "garantía", "devolucion", "devolución", "contra", "reembolso", "pago", "paga", "recibir", "entrega", "24h", "48h", "nuevo", "nueva", "nuevos", "nuevas", "mejor", "mejores", "mas", "menos", "desde", "hasta", "sobre", "entre", "porque", "cuando", "donde", "dónde", "quieres", "quiere", "puedes", "puede", "tienes", "tiene", "hacer", "haz", "ideal", "perfecto", "perfecta", "facil", "fácil", "rapido", "rápido", "calidad", "premium", "original", "oficial", "tienda", "online", "web", "link", "enlace", "bio", "click", "clic", "aqui", "www", "com", "shop", "casa", "hogar"]);
export function productTokens(ad: AdLibraryAd): string[] {
  const texto = [...ad.titles, ...sentences(ad.bodies.join("\n")).slice(0, 2), ...(ad.descriptions ?? []).slice(0, 1)].join(" ");
  const out = new Set<string>();
  for (const t of normalizeAngleText(texto).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)) if (t.length >= 4 && !PRODUCT_STOP.has(t) && !/^\d+$/.test(t)) out.add(t);
  return [...out];
}

/**
 * Agrupa los anuncios ACTIVOS por producto físico: dos anuncios son el mismo
 * producto si comparten ≥ 3 palabras de producto o ≥ 50 % de las del más corto.
 * Es una heurística de texto (la misma familia que la de ángulos) y así se declara.
 */
export function clusterProducts(ads: AdLibraryAd[], now: number, originalKeywords: string[] = []): AccountProduct[] {
  type C = { tokens: Map<string, number>; ads: AdLibraryAd[] };
  const clusters: C[] = [];
  for (const ad of ads.filter(isActive)) {
    const toks = productTokens(ad);
    if (!toks.length) continue;
    let hit: C | null = null;
    for (const c of clusters) {
      const shared = toks.filter((t) => c.tokens.has(t)).length;
      const minLen = Math.min(toks.length, c.tokens.size);
      if (shared >= 3 || (minLen > 0 && shared / minLen >= 0.5)) { hit = c; break; }
    }
    if (!hit) { hit = { tokens: new Map(), ads: [] }; clusters.push(hit); }
    hit.ads.push(ad);
    for (const t of toks) hit.tokens.set(t, (hit.tokens.get(t) ?? 0) + 1);
  }
  const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
  const orig = new Set(originalKeywords.map((k) => normalizeAngleText(k)));
  return clusters.map((c) => {
    const keywords = [...c.tokens.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([t]) => t);
    const inicios = c.ads.map(startSec).filter((n): n is number => n !== null);
    const oldest = inicios.length ? Math.min(...inicios) : null;
    const primero = c.ads.slice().sort((a, b) => (startSec(a) ?? Infinity) - (startSec(b) ?? Infinity))[0];
    const titulo = c.ads.map((a) => a.titles[0]).find(Boolean) ?? sentences(primero.bodies.join("\n"))[0] ?? "";
    const allTokens = [...c.tokens.keys()];
    const isOriginal = orig.size > 0 && [...orig].filter((k) => allTokens.some((t) => t === k || t.startsWith(k) || k.startsWith(t))).length / orig.size >= 0.5;
    return { label: titulo.slice(0, 120) || keywords.join(" "), keywords, ads: c.ads.length, adIds: c.ads.map((a) => a.id), oldestActiveStart: oldest === null ? null : iso(oldest), longestActiveDays: oldest === null ? null : Math.max(0, Math.floor((now - oldest) / DAY)), sample: (primero.bodies[0] ?? titulo).trim().slice(0, 180), adLink: adLibraryLink(primero.id), isOriginal };
  }).sort((a, b) => (b.longestActiveDays ?? -1) - (a.longestActiveDays ?? -1) || b.ads - a.ads);
}

export const DIVERSITY_RULE = "concentrado si ≥ 3 productos y (una raíz de palabra, fuera marca/página/dominio, aparece en ≥ 70 % de ellos ∨ solape medio de palabras ≥ 0,25); disperso en caso contrario; < 3 productos = insuficiente";
const stem5 = (t: string) => (t.length > 5 ? t.slice(0, 5) : t);

/** Diversidad del catálogo a partir de los productos minados. Puro, testeable. */
export function catalogDiversity(products: AccountProduct[], brandTokens: string[] = []): CatalogDiversity {
  const marca = new Set(brandTokens.map((t) => stem5(normalizeAngleText(t))).filter((t) => t.length >= 3));
  const sets = products.map((p) => new Set(p.keywords.map(stem5).filter((s) => !marca.has(s))));
  if (products.length < 3) return { products: products.length, level: "insuficiente", dominant: null, meanJaccard: null, note: `${products.length} producto(s) minado(s): no se puede juzgar la dispersión`, rule: DIVERSITY_RULE };
  const conteo = new Map<string, number>();
  for (const s of sets) for (const t of s) conteo.set(t, (conteo.get(t) ?? 0) + 1);
  let dominant: CatalogDiversity["dominant"] = null;
  for (const [t, n] of conteo) { const share = n / sets.length; if (!dominant || share > dominant.share) dominant = { stem: t, share: Math.round(share * 100) / 100 }; }
  let suma = 0, pares = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const a = sets[i], b = sets[j];
    const inter = [...a].filter((t) => b.has(t)).length; const uni = new Set([...a, ...b]).size;
    suma += uni ? inter / uni : 0; pares++;
  }
  const meanJaccard = pares ? Math.round((suma / pares) * 100) / 100 : 0;
  const concentrado = (dominant !== null && dominant.share >= 0.7) || meanJaccard >= 0.25;
  const note = concentrado
    ? `posible marca propia, no dropshipper — catálogo poco disperso: ${dominant && dominant.share >= 0.7 ? `la raíz «${dominant.stem}» aparece en el ${Math.round(dominant.share * 100)} % de los ${sets.length} productos` : `solape medio de palabras ${meanJaccard}`}`
    : `catálogo disperso (${sets.length} productos sin raíz dominante: máx. «${dominant?.stem ?? "—"}» ${Math.round((dominant?.share ?? 0) * 100)} %, solape medio ${meanJaccard}): señal normal de tienda COD`;
  return { products: sets.length, level: concentrado ? "concentrado" : "disperso", dominant, meanJaccard, note, rule: DIVERSITY_RULE };
}

/** Radiografía a partir de los anuncios ya bajados (sin red): separable para tests. */
export function xrayFromAds(pageId: string, ads: AdLibraryAd[], now: number, meta: { requests: number; pages: number; truncated: boolean; stopReason: StopReason }, originalKeywords: string[] = [], brandTokens: string[] = []): AccountXray {
  const vistos = new Set<string>();
  const unicos = ads.filter((a) => (vistos.has(a.id) ? false : (vistos.add(a.id), true))); // el primero manda (paginación: el mismo id no vuelve a contar)
  const activos = unicos.filter(isActive);
  const inicios = unicos.map(startSec).filter((n): n is number => n !== null);
  const iniciosActivos = activos.map(startSec).filter((n): n is number => n !== null);
  const first = inicios.length ? Math.min(...inicios) : null;
  const oldestActive = iniciosActivos.length ? Math.min(...iniciosActivos) : null;
  const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString().slice(0, 10));

  const porAngulo = new Map<AngleId, AccountAngle & { _oldest: number | null }>();
  for (const ad of unicos) {
    const start = startSec(ad);
    for (const [id, frase] of anglesOfAd(ad)) {
      const rule = ANGLE_RULES.find((r) => r.id === id)!;
      const a = porAngulo.get(id) ?? { id, label: rule.label, ads: 0, activeAds: 0, oldestActiveStart: null, longestActiveDays: null, evidence: null, _oldest: null };
      a.ads += 1;
      if (isActive(ad)) {
        a.activeAds += 1;
        if (start !== null && (a._oldest === null || start < a._oldest)) { a._oldest = start; a.oldestActiveStart = iso(start); a.longestActiveDays = Math.max(0, Math.floor((now - start) / DAY)); a.evidence = { adId: ad.id, quote: frase }; }
      }
      if (!a.evidence) a.evidence = { adId: ad.id, quote: frase };
      porAngulo.set(id, a);
    }
  }
  const angles = [...porAngulo.values()]
    .sort((x, y) => (y.longestActiveDays ?? -1) - (x.longestActiveDays ?? -1) || y.activeAds - x.activeAds || y.ads - x.ads)
    .map(({ _oldest, ...rest }) => rest);
  const top = angles.find((g) => g.longestActiveDays !== null && g.evidence && g.oldestActiveStart);
  const winner: AccountWinner | null = top ? { angle: top.id, label: top.label, adId: top.evidence!.adId, since: top.oldestActiveStart!, daysActive: top.longestActiveDays!, quote: top.evidence!.quote, adLink: adLibraryLink(top.evidence!.adId) } : null;

  return {
    pageId, pageName: unicos.find((a) => a.pageName)?.pageName ?? null,
    totalAds: unicos.length, activeAds: activos.length, inactiveAds: unicos.length - activos.length,
    firstAdStart: iso(first), daysAdvertising: first === null ? null : Math.max(0, Math.floor((now - first) / DAY)),
    oldestActiveStart: iso(oldestActive),
    angles,
    testing: testingRhythm(unicos, now),
    winner,
    products: clusterProducts(unicos, now, originalKeywords),
    diversity: catalogDiversity(clusterProducts(unicos, now, originalKeywords), [...brandTokens, ...(unicos.find((a) => a.pageName)?.pageName ?? "").split(/\s+/)]),
    avatar: { signals: avatarSignals(unicos).slice(0, 5), summary: null, summarySource: null },
    requests: meta.requests, pages: meta.pages, truncated: meta.truncated, stopReason: meta.stopReason,
    nature: "heuristica_sobre_texto_real",
  };
}

export interface AccountXrayInput {
  client: AdLibraryClient;
  pageId: string;
  country: string;
  now: number;
  budget?: DiscoveryBudget;
  maxPages?: number;
  /** Palabras clave del candidato original, para marcar cuál de los productos detectados es el suyo. */
  originalKeywords?: string[];
  /** Marca/dominio de la tienda: sus palabras no cuentan como «raíz dominante» al medir la dispersión del catálogo. */
  brandTokens?: string[];
  /** Recibe los anuncios bajados (búsqueda 3: para no volver a pedirlos). */
  onAds?: (ads: AdLibraryAd[]) => void;
  /** Consolidación del avatar en texto (Claude por OpenRouter). Opcional; si falla, queda la heurística. */
  summarize?: ((bodies: string[], signals: AvatarSignal[]) => Promise<string | null>) | null;
}

export async function readAccountXray(input: AccountXrayInput): Promise<AccountXray> {
  const budget = input.budget ?? new DiscoveryBudget({ deadlineAt: Date.now() + 2 * 60_000, maxRequests: (input.maxPages ?? ACCOUNT_MAX_PAGES) + 1 });
  const { since, until } = accountDateWindow(input.now);
  const antes = budget.requests;
  const r = await input.client.search({ term: "", pageIds: [input.pageId], country: input.country, since, until, activeStatus: "ALL", budget, maxPages: input.maxPages ?? ACCOUNT_MAX_PAGES });
  input.onAds?.(r.ads);
  const xray = xrayFromAds(input.pageId, r.ads, input.now, { requests: budget.requests - antes, pages: r.pages, truncated: r.pages >= (input.maxPages ?? ACCOUNT_MAX_PAGES) && r.stopReason === "completado", stopReason: r.stopReason }, input.originalKeywords ?? [], input.brandTokens ?? []);
  if (input.summarize && r.ads.length) {
    try {
      const bodies = [...new Set(r.ads.flatMap((a) => a.bodies).map((b) => b.trim()).filter(Boolean))].slice(0, 40);
      const s = await input.summarize(bodies, xray.avatar.signals);
      if (s) { xray.avatar.summary = s.slice(0, 600); xray.avatar.summarySource = "claude"; }
    } catch { /* la consolidación es opcional: queda la heurística */ }
  }
  if (!xray.avatar.summary && xray.avatar.signals.length) {
    xray.avatar.summary = xray.avatar.signals.slice(0, 3).map((s) => `${s.label} (${s.ads} anuncio${s.ads === 1 ? "" : "s"})`).join(" · ");
    xray.avatar.summarySource = "heuristica";
  }
  return xray;
}
