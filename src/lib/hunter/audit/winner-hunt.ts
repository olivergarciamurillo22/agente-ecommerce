// ============================================================
// MODO B · TIENDAS GANADORAS EN CADENA (07-09-2026) — docs/HUNTER-AUDITOR.md
//
// El usuario da un nicho. El sistema busca en la Ad Library con el buscador
// por palabra ya construido, elige los anunciantes que DESTACAN por las
// señales que existen, y a cada uno le aplica la auditoría del modo A: su
// tienda (si se puede resolver) y sus ángulos con texto citado.
//
// PRESUPUESTO, UNO SOLO: quince minutos en total. Se reparte, no se suma:
//   · búsqueda:   hasta el 60 % del tiempo y el 70 % de las peticiones a Meta
//   · auditorías: lo que quede
// Las auditorías del modo B NO vuelven a la Ad Library: los anuncios de cada
// candidata ya están en mano, así que su coste en cuota de Meta es CERO. Lo
// que gastan es tiempo (leer la tienda: portada + catálogo) y por eso el
// número de candidatas auditadas se acota por el tiempo restante, con un
// techo fijo de MAX_AUDITS_PER_RUN.
//
// UNIDAD: LA PÁGINA, no el grupo. El buscador agrupa por «página + línea de
// producto» (una tienda con dos productos distintos sale como dos grupos). Una
// tienda ganadora es la página entera, así que aquí se suman sus grupos: los
// activos se suman, los días activo se toman del grupo más veterano, las
// variantes se suman y el momentum es «fuerte» si lo es en alguno.
//
// CRITERIO DE «DESTACA», escrito para que no sea arbitrario:
//   candidata = no es ruido
//             Y tiene al menos 2 anuncios activos
//             Y (lleva 14 días o más activa  O  tiene 2 o más textos creativos distintos)
//   orden     = anuncios activos × 3 + min(días activo, 90) / 10 + variantes × 2 + (momentum fuerte ? 5 : 0)
// Es una ordenación por señales indirectas, y así se etiqueta: sugiere, no
// demuestra. Países NO entra en el criterio: solo sabemos dónde lo hemos
// buscado nosotros.
// ============================================================

import { AdLibraryClient } from "../discovery/client";
import { DiscoveryBudget, type StopReason } from "../discovery/budget";
import { DiscoveryHaltedError } from "../discovery/errors";
import { DiscoveryRepository } from "../discovery/repository";
import type { CompetitorReport } from "../discovery/signals";
import type { AdLibraryAd } from "../discovery/types";
import { runWordSearch, type WordSearchProgress, type WordSearchResult } from "../discovery/word-search";
import { canRunDiscovery } from "../../safety";
import { runStoreAudit, type StoreAuditReport } from "./store-audit";

export const MAX_AUDITS_PER_RUN = 5;
export const SEARCH_TIME_SHARE = 0.6;
export const SEARCH_REQUEST_SHARE = 0.7;
/** Tiempo que se reserva por auditoría: dos lecturas de tienda con su timeout, con margen. */
export const AUDIT_RESERVE_MS = 25_000;
export const STANDOUT_MIN_ACTIVE_ADS = 2;
export const STANDOUT_MIN_DAYS = 14;
export const STANDOUT_MIN_VARIANTS = 2;

export interface CandidateScore {
  score: number;
  activeAds: number;
  daysActive: number | null;
  variants: number;
  momentum: string;
  /** La regla, literal, para que se pueda auditar por qué está aquí. */
  why: string;
}

/** Una página anunciante con todos sus grupos del buscador. */
export interface PageAggregate {
  pageId: string;
  pageName: string | null;
  groups: CompetitorReport[];
  activeAds: number;
  daysActive: number | null;
  variants: number;
  momentum: string;
}

export interface WinnerCandidate {
  pageId: string;
  pageName: string | null;
  /** Cuántos grupos (líneas de producto) del buscador se sumaron en esta página. */
  groupCount: number;
  /** El grupo con más anuncios activos, como representante (señales y fichas). */
  competitor: CompetitorReport;
  score: CandidateScore;
  /** Tienda resuelta desde el dominio declarado en sus anuncios, si lo había. */
  storeUrl: string | null;
  audit: StoreAuditReport | null;
  auditStatus: "auditada" | "sin_tienda_resuelta" | "sin_tiempo" | "no_seleccionada";
}

export interface WinnerHuntResult {
  seed: string;
  search: Pick<WordSearchResult, "terms" | "termsQueried" | "stopReason" | "requests" | "pages" | "rawAds" | "elapsedSec">;
  totalCompetitors: number;
  candidates: WinnerCandidate[];
  auditsRun: number;
  stopReason: StopReason;
  criterion: string;
  budgetSplit: { searchMinutes: number; auditMinutes: number; searchMaxRequests: number; maxAudits: number };
  elapsedSec: number;
}

export const STANDOUT_CRITERION = `no ruido · anuncios activos ≥ ${STANDOUT_MIN_ACTIVE_ADS} · (días activo ≥ ${STANDOUT_MIN_DAYS} o textos distintos ≥ ${STANDOUT_MIN_VARIANTS}) · orden = activos×3 + min(días,90)/10 + variantes×2 + (momentum fuerte: +5)`;

function signalNumber(c: CompetitorReport, id: string): number | null {
  const v = c.signals.find((s) => s.id === id)?.value;
  return typeof v === "number" ? v : null;
}

function declaredDomain(groups: CompetitorReport[]): string | null {
  for (const c of groups) {
    const v = c.signals.find((s) => s.id === "dominio_declarado")?.value;
    if (typeof v === "string" && v) return v.split(",")[0].trim() || null;
  }
  return null;
}

/** Suma los grupos del buscador por page_id. El ruido no entra. */
export function aggregateByPage(competitors: CompetitorReport[]): PageAggregate[] {
  const porPagina = new Map<string, PageAggregate>();
  for (const c of competitors) {
    if (c.noise) continue;
    const agg = porPagina.get(c.pageId) ?? { pageId: c.pageId, pageName: c.pageName, groups: [], activeAds: 0, daysActive: null, variants: 0, momentum: "sin_historico" };
    agg.groups.push(c);
    agg.activeAds += c.activeAds;
    const dias = signalNumber(c, "dias_activo");
    if (dias !== null && (agg.daysActive === null || dias > agg.daysActive)) agg.daysActive = dias;
    agg.variants += signalNumber(c, "variantes_creativas") ?? 0;
    if (c.momentum.status === "fuerte") agg.momentum = "fuerte";
    else if (agg.momentum !== "fuerte" && c.momentum.status !== "sin_historico") agg.momentum = c.momentum.status;
    if (!agg.pageName && c.pageName) agg.pageName = c.pageName;
    porPagina.set(c.pageId, agg);
  }
  for (const agg of porPagina.values()) agg.groups.sort((x, y) => y.activeAds - x.activeAds);
  return [...porPagina.values()];
}

export function scoreCandidate(page: PageAggregate): CandidateScore | null {
  const { activeAds, daysActive, variants, momentum } = page;
  if (activeAds < STANDOUT_MIN_ACTIVE_ADS) return null;
  const veterano = (daysActive ?? 0) >= STANDOUT_MIN_DAYS;
  const testea = variants >= STANDOUT_MIN_VARIANTS;
  if (!veterano && !testea) return null;
  const score = activeAds * 3 + Math.min(daysActive ?? 0, 90) / 10 + variants * 2 + (momentum === "fuerte" ? 5 : 0);
  return {
    score: Math.round(score * 10) / 10,
    activeAds,
    daysActive,
    variants,
    momentum,
    why: `${activeAds} activos${veterano ? `, ${daysActive} días activa` : ""}${testea ? `, ${variants} textos distintos` : ""}${momentum === "fuerte" ? ", momentum fuerte" : ""}`,
  };
}

export interface WinnerHuntInput {
  seed: string;
  token: string;
  country?: string;
  days?: number;
  minutes?: number;
  maxRequests?: number;
  maxAudits?: number;
  maxTerms?: number;
  now?: number;
  client?: AdLibraryClient;
  repository?: DiscoveryRepository;
  fetcher?: typeof fetch;
  onProgress?: (p: WordSearchProgress & { auditando?: string | null; auditsDone?: number; auditsTotal?: number }) => void;
}

export async function runWinnerHunt(input: WinnerHuntInput): Promise<WinnerHuntResult> {
  if (!canRunDiscovery()) throw new DiscoveryHaltedError();
  const started = Date.now();
  const totalMs = (input.minutes ?? 15) * 60_000;
  const totalRequests = input.maxRequests ?? 400;
  const maxAudits = Math.max(1, Math.min(MAX_AUDITS_PER_RUN, input.maxAudits ?? MAX_AUDITS_PER_RUN));
  const searchBudget = new DiscoveryBudget({
    deadlineAt: started + Math.floor(totalMs * SEARCH_TIME_SHARE),
    maxRequests: Math.floor(totalRequests * SEARCH_REQUEST_SHARE),
  });

  // Fase 1 · buscar competidores con el buscador por palabra (sin duplicar nada).
  const search = await runWordSearch({
    seed: input.seed,
    country: input.country,
    days: input.days,
    token: input.token,
    now: input.now,
    client: input.client,
    repository: input.repository,
    budget: searchBudget,
    maxTerms: input.maxTerms,
    onProgress: input.onProgress,
  });

  // Fase 2 · sumar por página y elegir las que destacan.
  const paginas = aggregateByPage(search.competitors);
  const puntuadas = paginas
    .map((page) => ({ page, score: scoreCandidate(page) }))
    .filter((x): x is { page: PageAggregate; score: CandidateScore } => x.score !== null)
    .sort((a, b) => b.score.score - a.score.score);

  // Fase 3 · auditar en cadena, hasta donde llegue el tiempo.
  const candidates: WinnerCandidate[] = [];
  let auditsRun = 0;
  let stopReason: StopReason = search.stopReason;
  for (const { page, score } of puntuadas) {
    const competitor = page.groups[0];
    const storeUrl = declaredDomain(page.groups);
    const candidate: WinnerCandidate = { pageId: page.pageId, pageName: page.pageName, groupCount: page.groups.length, competitor, score, storeUrl, audit: null, auditStatus: "no_seleccionada" };
    candidates.push(candidate);
    if (auditsRun >= maxAudits) continue;
    const quedaMs = started + totalMs - Date.now();
    if (quedaMs < AUDIT_RESERVE_MS) {
      candidate.auditStatus = "sin_tiempo";
      stopReason = "deadline";
      continue;
    }
    if (!canRunDiscovery()) throw new DiscoveryHaltedError();
    input.onProgress?.({ fase: "agrupando", term: null, termsDone: search.termsQueried.length, termsTotal: search.terms.length, ads: search.rawAds, requests: search.requests, remainingSec: Math.round(quedaMs / 1000), auditando: page.pageName ?? page.pageId, auditsDone: auditsRun, auditsTotal: Math.min(maxAudits, puntuadas.length) });
    // Los anuncios ya están en mano (todos los grupos de la página): la auditoría no vuelve a la Ad Library.
    const ads = adsOf(search, page);
    if (!storeUrl) {
      // Sin dominio declarado no hay tienda que leer, pero los ángulos sí.
      candidate.audit = await runStoreAudit({
        storeUrl: page.pageName ?? page.pageId,
        token: input.token,
        now: input.now,
        fetcher: async () => new Response("", { status: 404 }),
        knownAds: ads,
        knownPageId: competitor.pageId,
        maxCatalogPages: 1,
      });
      candidate.auditStatus = "sin_tienda_resuelta";
      auditsRun++;
      continue;
    }
    candidate.audit = await runStoreAudit({
      storeUrl,
      token: input.token,
      now: input.now,
      fetcher: input.fetcher,
      knownAds: ads,
      knownPageId: competitor.pageId,
      maxCatalogPages: 2,
    });
    candidate.auditStatus = "auditada";
    auditsRun++;
  }

  return {
    seed: input.seed,
    search: { terms: search.terms, termsQueried: search.termsQueried, stopReason: search.stopReason, requests: search.requests, pages: search.pages, rawAds: search.rawAds, elapsedSec: search.elapsedSec },
    totalCompetitors: paginas.length,
    candidates,
    auditsRun,
    stopReason,
    criterion: STANDOUT_CRITERION,
    budgetSplit: {
      searchMinutes: Math.round((totalMs * SEARCH_TIME_SHARE) / 60_000 * 10) / 10,
      auditMinutes: Math.round((totalMs * (1 - SEARCH_TIME_SHARE)) / 60_000 * 10) / 10,
      searchMaxRequests: Math.floor(totalRequests * SEARCH_REQUEST_SHARE),
      maxAudits,
    },
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };
}

/** Los anuncios de una página: la unión de los de sus grupos, sin repetir. */
function adsOf(search: WordSearchResult, page: PageAggregate) {
  const vistos = new Map<string, AdLibraryAd>();
  for (const g of page.groups) for (const ad of search.adsByCandidate?.[g.candidateKey] ?? []) vistos.set(ad.id, ad);
  return [...vistos.values()];
}
