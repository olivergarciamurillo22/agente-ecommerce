// ============================================================
// BÚSQUEDA 3 · CAZA DIRECTA DE TIENDAS COD (10-09-2026)
// docs/HUNTER-DEEP-DIVE.md §Búsqueda 3
//
// Las búsquedas 1 y 2 parten del catálogo de Dropea. Esta parte de la Ad
// Library: busca quien habla de PAGO CONTRA REEMBOLSO (la señal más fuerte
// de operación COD como Casamable), agrupa por tienda, prioriza barato y
// solo audita a fondo el lote pequeño que decide Pedro.
//
// Fase 1 (barata, una pasada): N frases × ≤ P páginas de /ads_archive
// (ad_active_status=ALL, ad_reached_countries=ES). Se agrupa por page_id en
// memoria: activos, total, anuncio activo más antiguo, evidencia literal de la
// frase COD, dominios declarados, enlace. Puntuación barata de PRIORIDAD
// (no es veredicto): SWEEP_FORMULA. No se audita nada.
//
// Fase 2 (cara, lote explícito): por tienda, la radiografía completa
// (account.ts, ≤ 5 peticiones), la minería de productos y la diversidad del
// catálogo ya existentes; cada producto minado se intenta casar con Dropea
// (búsqueda local + gate estricto). Si está: el deep dive normal (precio
// real, margen, coherencia, competencia, veredicto). Si NO está: veredicto
// de FUERZA DE LA SEÑAL solo con lo que la cuenta demuestra
// (senal_fuerte_sin_proveedor / senal_debil_sin_proveedor), sin margen, sin
// «contactar a Dropea»: «requiere sourcing alternativo». Nada se inventa.
// ============================================================

import type { AdLibraryAd } from "../discovery/types";
import type { AdLibraryClient } from "../discovery/client";
import { DiscoveryBudget, type StopReason } from "../discovery/budget";
import { declaredDomains } from "../discovery/signals";
import { sentences, normalizeAngleText } from "../audit/angles";
import { productKeywords } from "../../product-hunter/internal/cruce";
import { readAccountXray, adLibraryLink, accountDateWindow, type AccountXray, type AccountProduct, type AccountXrayInput } from "./account";
import { productGate, type ProductGate } from "./product-gate";
import { parseRenderAdHtml, renderAdUrl, DEEP_DIVE_USER_AGENT } from "./render-ad";
import { runDeepDive, type DeepDiveReport, type DeepDiveInput } from "./deep-dive";

const DAY = 86_400;

/**
 * Frases por defecto (ampliadas el 10-09 tras 15 auditorías reales): la jerga
 * del COD español. Cada frase = hasta --paginas peticiones; una tienda que
 * sale en varias frases cuenta una sola vez. Se cambian con --frases.
 */
export const COD_PHRASES_DEFAULT = [
  "pago contra reembolso", "contrareembolso", "envío contra reembolso",
  "paga al recibir", "pago en efectivo al recibir", "pago cuando recibas", "paga cuando lo recibas", "paga cuando llegue",
  "paga en casa", "paga en tu domicilio", "pago en la puerta", "pago al momento de la entrega", "sin pago por adelantado",
];
/** Evidencia: el texto del anuncio tiene que decirlo de verdad (Meta busca «parecido»; esto exige la frase). */
export const COD_EVIDENCE = /\b(contra ?reembolso|contrarrembolso|pag[ao] (en efectivo )?al (recibir|recibirlo|entregar|momento de la entrega)|paga(s)? (en (tu )?(casa|domicilio)|cuando (lo )?(recibas|llegue|te llegue)|al (repartidor|mensajero)|a la entrega)|pago (en (la )?(entrega|puerta|casa|domicilio)|cuando (lo )?recibas|a la entrega)|efectivo al recibir|sin pago por adelantado|sin pagar (nada )?por adelantado)\b/;
export const SWEEP_MAX_PAGES_DEFAULT = 5;
export const SWEEP_DAYS_DEFAULT = 180;
export const SWEEP_FORMULA = "prioridad (0–100, NO veredicto) = min(anuncios activos, 10) × 5 + min(días del activo más antiguo, 180) / 180 × 50; solo tiendas con al menos un anuncio que diga la frase COD";

export interface SweepStore {
  pageId: string;
  pageName: string | null;
  adsFound: number;
  activeAds: number;
  /** Anuncios cuyo texto contiene de verdad la frase COD. */
  codAds: number;
  oldestActiveStart: string | null;
  oldestActiveDays: number | null;
  domains: string[];
  evidence: { adId: string; quote: string } | null;
  adLink: string | null;
  priority: number;
}

export interface SweepResult {
  country: string;
  phrases: string[];
  days: number;
  maxPages: number;
  requests: number;
  adsTotal: number;
  adsUnique: number;
  stores: SweepStore[];
  /** Páginas vistas que NO dicen la frase en ningún anuncio (Meta las devolvió por parecido): fuera de la tabla. */
  storesWithoutEvidence: number;
  stopReasons: Record<string, StopReason>;
  formula: string;
  capturedAt: number;
}

/** Cita literal de la frase COD dentro del anuncio. */
export function codQuote(ad: AdLibraryAd): string | null {
  for (const texto of [...ad.bodies, ...ad.titles, ...(ad.descriptions ?? [])]) {
    for (const frase of sentences(texto)) if (COD_EVIDENCE.test(normalizeAngleText(frase))) return frase.trim().slice(0, 180);
    if (COD_EVIDENCE.test(normalizeAngleText(texto))) return texto.trim().slice(0, 180);
  }
  return null;
}

export function sweepPriority(activeAds: number, oldestActiveDays: number | null): number {
  return Math.round((Math.min(activeAds, 10) * 5 + (Math.min(oldestActiveDays ?? 0, 180) / 180) * 50) * 10) / 10;
}

/** Agrupa por tienda y prioriza. Puro, testeable. */
export function groupSweep(ads: AdLibraryAd[], now: number): { stores: SweepStore[]; adsUnique: number; storesWithoutEvidence: number } {
  const vistos = new Set<string>();
  const unicos = ads.filter((a) => (vistos.has(a.id) ? false : (vistos.add(a.id), true)));
  const porPagina = new Map<string, AdLibraryAd[]>();
  for (const a of unicos) porPagina.set(a.pageId, [...(porPagina.get(a.pageId) ?? []), a]);
  const stores: SweepStore[] = [];
  let sinEvidencia = 0;
  for (const [pageId, lista] of porPagina) {
    const conCod = lista.map((a) => ({ a, q: codQuote(a) })).filter((x) => x.q);
    if (!conCod.length) { sinEvidencia++; continue; }
    const activos = lista.filter((a) => !a.stopTime);
    const inicios = activos.map((a) => (a.startTime ? Date.parse(a.startTime) : NaN)).filter(Number.isFinite).map((t) => Math.floor(t / 1000));
    const oldest = inicios.length ? Math.min(...inicios) : null;
    const days = oldest === null ? null : Math.max(0, Math.floor((now - oldest) / DAY));
    const activoMasAntiguo = activos.slice().sort((x, y) => Date.parse(x.startTime ?? "") - Date.parse(y.startTime ?? ""))[0] ?? lista[0];
    stores.push({
      pageId, pageName: lista.find((a) => a.pageName)?.pageName ?? null, adsFound: lista.length, activeAds: activos.length, codAds: conCod.length,
      oldestActiveStart: oldest === null ? null : new Date(oldest * 1000).toISOString().slice(0, 10), oldestActiveDays: days,
      domains: declaredDomains(lista).filter((d) => !/(^|\.)(facebook|instagram|whatsapp|fb|messenger)\.(com|me)$/i.test(d)).slice(0, 3),
      evidence: { adId: conCod[0].a.id, quote: conCod[0].q! }, adLink: adLibraryLink(activoMasAntiguo.id), priority: sweepPriority(activos.length, days),
    });
  }
  stores.sort((a, b) => b.priority - a.priority || b.activeAds - a.activeAds || (b.oldestActiveDays ?? -1) - (a.oldestActiveDays ?? -1));
  return { stores, adsUnique: unicos.length, storesWithoutEvidence: sinEvidencia };
}

export interface SweepInput { client: AdLibraryClient; country?: string; phrases?: string[]; days?: number; maxPages?: number; now?: number; budget?: DiscoveryBudget; onPhrase?: (phrase: string, ads: number, pages: number, stop: StopReason) => void }

/** Fase 1: N frases × ≤ P páginas, agrupación en memoria. Coste: ≤ frases × páginas peticiones. */
export async function sweepCodStores(input: SweepInput): Promise<SweepResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const country = (input.country ?? "ES").toUpperCase();
  const phrases = (input.phrases?.length ? input.phrases : COD_PHRASES_DEFAULT).map((p) => p.trim()).filter(Boolean);
  const days = input.days ?? SWEEP_DAYS_DEFAULT;
  const maxPages = input.maxPages ?? SWEEP_MAX_PAGES_DEFAULT;
  const budget = input.budget ?? new DiscoveryBudget({ deadlineAt: Date.now() + 10 * 60_000, maxRequests: phrases.length * maxPages + 1 });
  const { until } = accountDateWindow(now);
  const since = new Date((now - days * DAY) * 1000).toISOString().slice(0, 10);
  const todos: AdLibraryAd[] = [];
  const stopReasons: Record<string, StopReason> = {};
  for (const phrase of phrases) {
    if (budget.check()) { stopReasons[phrase] = budget.check()!; break; }
    const r = await input.client.search({ term: phrase, country, since, until, activeStatus: "ALL", budget, maxPages });
    todos.push(...r.ads);
    stopReasons[phrase] = r.stopReason;
    input.onPhrase?.(phrase, r.ads.length, r.pages, r.stopReason);
    if (r.stopReason === "rate_limit" || r.stopReason === "cuota_meta" || r.stopReason === "deadline") break;
  }
  const g = groupSweep(todos, now);
  return { country, phrases, days, maxPages, requests: budget.requests, adsTotal: todos.length, adsUnique: g.adsUnique, stores: g.stores, storesWithoutEvidence: g.storesWithoutEvidence, stopReasons, formula: SWEEP_FORMULA, capturedAt: now };
}

// ------------------------------------------------------------
// Fase 2 · auditoría de una tienda
// ------------------------------------------------------------

export type SignalVerdict = "senal_fuerte_sin_proveedor" | "senal_debil_sin_proveedor";
export const SIGNAL_RULES = "senal_fuerte_sin_proveedor = anuncio activo más antiguo del producto ≥ 30 días ∧ ≥ 2 anuncios activos del producto ∧ catálogo de la cuenta no concentrado (no marca propia) · si no, senal_debil_sin_proveedor · sin margen ni «contactar a Dropea»: requiere sourcing alternativo";

export interface DropeaCandidate { variantId: number; name: string; costEur: number | null }
export type DropeaSearchFn = (term: string) => DropeaCandidate[];

/** Presencia de vídeo entre los anuncios activos del producto (render_ad, 1 petición por anuncio comprobado). */
export interface ProductVideo { status: "si" | "no" | "no_comprobado"; checked: number; withVideo: number; videoAdIds: string[]; reason: string | null }

export interface StoreProductAudit {
  product: AccountProduct;
  keywords: string[];
  video: ProductVideo;
  dropea: { searched: boolean; candidates: DropeaCandidate[]; match: DropeaCandidate | null; gate: ProductGate | null };
  /** Camino con Dropea: el deep dive completo. */
  deepDive: DeepDiveReport | null;
  /** Camino sin Dropea: fuerza de la señal, solo con lo que la cuenta demuestra. */
  signal: { verdict: SignalVerdict; reason: string } | null;
  recommendation: { action: "testear" | "no_testear" | "verificar_manual" | "contactar_dropea_muestra" | "descartar"; reason: string; sourcing: "dropea" | "alternativo" };
}

export interface StoreAudit {
  pageId: string;
  pageName: string | null;
  country: string;
  sweep: SweepStore | null;
  account: AccountXray | null;
  products: StoreProductAudit[];
  /** Veredicto por TIENDA: en texto claro, con la tabla de productos resumida. */
  summary: string;
  requests: number;
  incomplete: Array<{ part: string; reason: string }>;
  rules: string;
  capturedAt: number;
}

/**
 * Palabras con las que se busca un producto minado en Dropea: las del título
 * (hasta 3) más UNA del grupo que el título no diga («Báscula digital» +
 * «baño»): así el gate distingue báscula de baño de báscula de cocina.
 */
export function productSearchKeywords(p: AccountProduct): string[] {
  const delTitulo = productKeywords(p.label).slice(0, 3);
  const base = delTitulo.length >= 2 ? delTitulo : p.keywords.slice(0, 3);
  const extra = p.keywords.find((k) => !base.includes(k) && k.length >= 4);
  return extra ? [...base, extra] : base;
}

/** ¿Está en Dropea? Búsqueda local + gate estricto contra el nombre de Dropea (mismas reglas que el gate del catálogo). Puro. */
export function matchDropea(keywords: string[], candidates: DropeaCandidate[]): { match: DropeaCandidate | null; gate: ProductGate | null } {
  let best: { c: DropeaCandidate; gate: ProductGate; hits: number } | null = null;
  for (const c of candidates) {
    const pseudo = { title: c.name, handle: "", vendor: null, productType: null, priceMin: c.costEur, priceMax: c.costEur, variants: 1, images: 0, available: null, createdAt: null, url: "" };
    const gate = productGate(keywords, pseudo, 0, candidates.length);
    const hits = gate.present.length;
    if (!best || hits > best.hits || (hits === best.hits && gate.passed && !best.gate.passed)) best = { c, gate, hits };
  }
  if (!best) return { match: null, gate: null };
  return { match: best.gate.passed ? best.c : null, gate: best.gate };
}

export function signalVerdict(p: AccountProduct, account: AccountXray): { verdict: SignalVerdict; reason: string } {
  const dias = p.longestActiveDays ?? 0;
  const concentrado = account.diversity.level === "concentrado";
  const fuerte = dias >= 30 && p.ads >= 2 && !concentrado;
  const partes = [`${p.ads} anuncio(s) activo(s) del producto`, `el más antiguo ${dias} días`, concentrado ? "catálogo de la cuenta concentrado (posible marca propia)" : `catálogo ${account.diversity.level}`, account.testing ? `ritmo de testeo ${account.testing.level}` : "ritmo de testeo desconocido"];
  return { verdict: fuerte ? "senal_fuerte_sin_proveedor" : "senal_debil_sin_proveedor", reason: `${partes.join(" · ")} → ${fuerte ? "la tienda lo mantiene encendido con recorrido" : "falta recorrido, volumen o es marca propia"}; no disponible en Dropea, requiere sourcing alternativo (AliExpress u otro proveedor) si se quiere testear` };
}

export interface StoreAuditInput {
  client: AdLibraryClient;
  pageId: string;
  pageName?: string | null;
  country?: string;
  now?: number;
  sweep?: SweepStore | null;
  dropeaSearch: DropeaSearchFn | null;
  /** Máximo de productos minados a evaluar por tienda (los de activo más antiguo primero). */
  maxProducts?: number;
  accountSummarize?: AccountXrayInput["summarize"];
  accountMaxPages?: number;
  /** Lo que el deep dive normal necesita (visión, vídeo, token, fetcher…) para los productos que SÍ están en Dropea. */
  deepDive?: Partial<Pick<DeepDiveInput, "fetcher" | "token" | "vision" | "video" | "skipVideo" | "videoBudgetExhausted" | "dropeaLookup" | "search">>;
  /** Comprobar vídeo por producto (render_ad de hasta N anuncios activos; usa deepDive.token/fetcher). false = no gastar. */
  probeVideo?: boolean;
  maxVideoProbesPerProduct?: number;
}

/** ¿Alguno de los anuncios activos del producto es vídeo? Solo presencia (sin descargar ni analizar). */
export async function probeProductVideo(p: AccountProduct, ads: AdLibraryAd[], opts: { token: string | null; fetcher: typeof fetch; max?: number }): Promise<ProductVideo> {
  if (!opts.token) return { status: "no_comprobado", checked: 0, withVideo: 0, videoAdIds: [], reason: "sin token de la Ad Library no se puede pedir render_ad" };
  const activos = ads.filter((a) => p.adIds.includes(a.id) && !a.stopTime).slice(0, opts.max ?? 3);
  if (!activos.length) return { status: "no_comprobado", checked: 0, withVideo: 0, videoAdIds: [], reason: "sin anuncios activos del producto entre los bajados" };
  const videoAdIds: string[] = [];
  let checked = 0;
  for (const a of activos) {
    try {
      const r = await opts.fetcher(renderAdUrl(a.id, opts.token), { headers: { "user-agent": DEEP_DIVE_USER_AGENT, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      checked++;
      if (parseRenderAdHtml(await r.text()).videoUrls.length) videoAdIds.push(a.id);
    } catch { /* un render_ad caído no tumba la auditoría */ }
  }
  if (!checked) return { status: "no_comprobado", checked: 0, withVideo: 0, videoAdIds: [], reason: "render_ad no respondió" };
  return { status: videoAdIds.length ? "si" : "no", checked, withVideo: videoAdIds.length, videoAdIds, reason: null };
}

/** Elige el siguiente lote: los N primeros del barrido que aún no están auditados. Puro. */
export function pickNextBatch(stores: SweepStore[], audited: Set<string>, n: number): SweepStore[] {
  return stores.filter((s) => !audited.has(s.pageId)).slice(0, Math.max(0, n));
}

export async function auditCodStore(input: StoreAuditInput): Promise<StoreAudit> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const country = (input.country ?? "ES").toUpperCase();
  const incomplete: StoreAudit["incomplete"] = [];
  let requests = 0;
  let ads: AdLibraryAd[] = [];
  let account: AccountXray | null = null;
  const brand = [...(input.pageName ?? input.sweep?.pageName ?? "").split(/\s+/), ...(input.sweep?.domains ?? []).map((d) => d.split(".")[0])];
  try {
    account = await readAccountXray({ client: input.client, pageId: input.pageId, country, now, maxPages: input.accountMaxPages, brandTokens: brand, summarize: input.accountSummarize ?? null, onAds: (a) => { ads = a; } });
    requests += account.requests;
    if (account.truncated) incomplete.push({ part: "cuenta", reason: `la cuenta tiene más anuncios de los leídos (${account.totalAds} en ${account.pages} páginas): cota inferior` });
  } catch (err) {
    incomplete.push({ part: "cuenta", reason: `fallo al leer la cuenta: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
  }
  const products: StoreProductAudit[] = [];
  if (account) {
    if (!input.dropeaSearch) incomplete.push({ part: "dropea", reason: "sin catálogo local de Dropea: ningún producto se puede casar (hunter:dropea:sync)" });
    for (let p of account.products.slice(0, input.maxProducts ?? 4)) {
      const keywords = productSearchKeywords(p);
      let candidates: DropeaCandidate[] = [];
      let searched = false;
      if (input.dropeaSearch && keywords.length) { try { candidates = input.dropeaSearch(keywords.slice(0, 3).join(" ")).slice(0, 8); searched = true; } catch { candidates = []; } }
      const { match, gate } = matchDropea(keywords, candidates);
      let adsProducto = ads.filter((a) => p.adIds.includes(a.id));
      const oldest = p.oldestActiveStart ? Math.floor(Date.parse(p.oldestActiveStart) / 1000) : null;
      // Vídeo: presencia entre los activos del producto; el anuncio con vídeo pasa a ser el enlace principal y el primero del deep dive.
      let video: ProductVideo = { status: "no_comprobado", checked: 0, withVideo: 0, videoAdIds: [], reason: "comprobación de vídeo desactivada" };
      if (input.probeVideo !== false) {
        video = await probeProductVideo(p, ads, { token: input.deepDive?.token ?? null, fetcher: input.deepDive?.fetcher ?? fetch, max: input.maxVideoProbesPerProduct ?? 3 });
        requests += video.checked;
        if (video.videoAdIds.length) {
          p = { ...p, adLink: adLibraryLink(video.videoAdIds[0]) };
          adsProducto = [...adsProducto.filter((a) => video.videoAdIds.includes(a.id)), ...adsProducto.filter((a) => !video.videoAdIds.includes(a.id))];
        }
      }
      if (match) {
        const kw = productKeywords(match.name);
        const dd = await runDeepDive({ keywords: kw.length ? kw : keywords, ads: adsProducto, costEur: match.costEur, activeAds: p.ads, oldestActiveAt: oldest, now, client: input.client, pageId: input.pageId, country, accountPrecomputed: account, accountSummarize: null, ...(input.deepDive ?? {}) });
        requests += dd.requests;
        const rec: StoreProductAudit["recommendation"] = dd.recommendation.action === "contactar_dropea_muestra" ? { action: "contactar_dropea_muestra", reason: dd.recommendation.reason, sourcing: "dropea" }
          : dd.recommendation.action === "verificar_manual" ? { action: "verificar_manual", reason: dd.recommendation.reason, sourcing: "dropea" }
          : { action: "descartar", reason: dd.recommendation.reason, sourcing: "dropea" };
        products.push({ product: p, keywords, video, dropea: { searched, candidates, match, gate }, deepDive: dd, signal: null, recommendation: rec });
      } else {
        const signal = signalVerdict(p, account);
        const rec: StoreProductAudit["recommendation"] = signal.verdict === "senal_fuerte_sin_proveedor"
          ? { action: "testear", reason: `señal fuerte en la cuenta, pero NO está en Dropea: la decisión de sourcing (AliExpress u otro) es de Pedro; sin margen calculable`, sourcing: "alternativo" }
          : { action: "no_testear", reason: `señal débil y sin proveedor: no compensa buscar sourcing alternativo`, sourcing: "alternativo" };
        products.push({ product: p, keywords, video, dropea: { searched, candidates, match: null, gate }, deepDive: null, signal, recommendation: rec });
      }
    }
  }
  const audit: StoreAudit = { pageId: input.pageId, pageName: account?.pageName ?? input.pageName ?? input.sweep?.pageName ?? null, country, sweep: input.sweep ?? null, account, products, summary: "", requests, incomplete, rules: `${SIGNAL_RULES} · deep dive: reglas del informe de cada producto`, capturedAt: now };
  audit.summary = summarizeStore(audit);
  return audit;
}

export function summarizeStore(a: StoreAudit): string {
  const p: string[] = [];
  const nombre = a.pageName ? `«${a.pageName}»` : `page ${a.pageId}`;
  if (!a.account) { p.push(`${nombre}: cuenta no leída (${a.incomplete.map((i) => i.reason).join("; ") || "sin motivo"}).`); return p.join(" "); }
  const acc = a.account;
  p.push(`${nombre} (${a.country}): anuncia desde ${acc.firstAdStart ?? "?"} (${acc.daysAdvertising ?? "?"} días), ${acc.totalAds} anuncios, ${acc.activeAds} activos, ritmo de testeo ${acc.testing?.level ?? "?"}, catálogo ${acc.diversity.level}${acc.diversity.level === "concentrado" ? " (posible marca propia: baja prioridad)" : ""}.`);
  if (acc.winner) p.push(`Ángulo ganador de la cuenta: ${acc.winner.label.toLowerCase()}, «${acc.winner.quote}», ${acc.winner.daysActive} días activo.`);
  if (acc.avatar.summary) p.push(`Avatar: ${acc.avatar.summary}.`);
  if (!a.products.length) p.push("Sin productos minados entre los activos.");
  for (const x of a.products) {
    const dias = x.product.longestActiveDays ?? "?";
    const vid = x.video.status === "si" ? `, vídeo en ${x.video.withVideo}` : x.video.status === "no" ? ", sin vídeo" : "";
    if (x.deepDive) p.push(`· «${x.product.label}» (${x.product.ads} activos, ${dias} días${vid}) → EN DROPEA como «${x.dropea.match!.name}»: ${x.deepDive.verdict.replace(/_/g, " ")}${x.deepDive.marginPct !== null ? `, margen real ${Math.round(x.deepDive.marginPct * 100)} %` : ""} → ${x.recommendation.action.replace(/_/g, " ")}: ${x.recommendation.reason}.`);
    else p.push(`· «${x.product.label}» (${x.product.ads} activos, ${dias} días${vid}) → NO en Dropea: ${x.signal!.verdict.replace(/_/g, " ")} → ${x.recommendation.action.replace(/_/g, " ")}: ${x.signal!.reason}.`);
  }
  return p.join(" ");
}

// ------------------------------------------------------------
// Informe consolidado por rango de madurez (solo lectura, sin red)
// ------------------------------------------------------------

export interface ConsolidatedRow {
  auditId: number;
  pageId: string;
  store: string;
  domain: string | null;
  product: string;
  adLink: string;
  hasVideo: ProductVideo["status"];
  maturityDays: number;
  activeAds: number;
  inDropea: boolean;
  marginPct: number | null;
  verdict: string;
  diversity: string;
  auditedAt: string;
}

export const CONSOLIDATED_RULE = "entran: senal_fuerte_sin_proveedor, o en Dropea con veredicto ganador_probable; madurez = días del anuncio activo más antiguo del producto sin cambios, dentro de [--min-dias, --max-dias]; orden: más maduro primero";

/** Aplana las auditorías persistidas a una fila por producto que cumpla el filtro. Puro, testeable. */
export function consolidatedReport(audits: Array<{ id: number; capturedAt: number; audit: StoreAudit }>, opts: { minDays: number; maxDays: number }): ConsolidatedRow[] {
  const rows: ConsolidatedRow[] = [];
  for (const { id, capturedAt, audit } of audits) {
    for (const x of audit.products) {
      const fuerte = x.signal?.verdict === "senal_fuerte_sin_proveedor";
      const ganadorDropea = Boolean(x.deepDive && x.dropea.match && x.deepDive.verdict === "ganador_probable");
      if (!fuerte && !ganadorDropea) continue;
      const dias = x.product.longestActiveDays;
      if (dias === null || dias < opts.minDays || dias > opts.maxDays) continue;
      rows.push({
        auditId: id, pageId: audit.pageId, store: audit.pageName ?? audit.pageId, domain: x.deepDive?.domain ?? audit.sweep?.domains[0] ?? null,
        product: x.product.label, adLink: x.product.adLink, hasVideo: x.video?.status ?? "no_comprobado", maturityDays: dias, activeAds: x.product.ads,
        inDropea: ganadorDropea, marginPct: x.deepDive?.marginPct ?? null, verdict: ganadorDropea ? "ganador_probable (Dropea)" : "senal_fuerte_sin_proveedor",
        diversity: audit.account?.diversity.level ?? "insuficiente", auditedAt: new Date(capturedAt * 1000).toISOString().slice(0, 10),
      });
    }
  }
  return rows.sort((a, b) => b.maturityDays - a.maturityDays || b.activeAds - a.activeAds);
}
