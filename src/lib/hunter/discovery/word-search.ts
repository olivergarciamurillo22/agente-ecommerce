// ============================================================
// BÚSQUEDA POR UNA PALABRA (07-09-2026) — docs/HUNTER-BUSCADOR.md
//
// Une las tres piezas: expandir la palabra a una batería de términos, gastar
// un presupuesto de tiempo buscando en profundidad, y devolver los resultados
// AGRUPADOS POR COMPETIDOR con sus señales etiquetadas.
//
// El objetivo declarado es profundidad, no velocidad: por defecto se da un
// presupuesto de 15 minutos y hasta 400 peticiones, y se para en cuanto Meta
// diga que la cuota se acaba. Si el presupuesto corta a la mitad, lo
// encontrado hasta ahí SE GUARDA y el informe dice por qué paró.
// ============================================================

import { AdLibraryClient } from "./client";
import { DiscoveryBudget, type StopReason } from "./budget";
import { expandSearchTerm, type ExpandedTerm } from "./expansion";
import { DiscoveryRepository } from "./repository";
import { runDiscovery } from "./service";
import { competitorSignals, type CompetitorReport } from "./signals";
import type { DiscoverySnapshot } from "./types";

export const DEFAULT_SEARCH_MINUTES = 15;
export const DEFAULT_MAX_REQUESTS = 400;

export interface WordSearchProgress {
  fase: "expandiendo" | "buscando" | "agrupando" | "terminado";
  term: string | null;
  termsDone: number;
  termsTotal: number;
  ads: number;
  requests: number;
  /** Segundos restantes del presupuesto. */
  remainingSec: number;
}

export interface WordSearchResult {
  seed: string;
  terms: ExpandedTerm[];
  termsQueried: string[];
  stopReason: StopReason;
  requests: number;
  pages: number;
  rawAds: number;
  /** Competidores encontrados, ya sin ruido, de más a menos anuncios activos. */
  competitors: CompetitorReport[];
  /** Los descartados por el filtro de ruido, con su motivo (para poder revisarlo). */
  discarded: CompetitorReport[];
  elapsedSec: number;
}

export interface WordSearchInput {
  seed: string;
  country?: string;
  days?: number;
  token: string;
  minutes?: number;
  maxRequests?: number;
  maxTerms?: number;
  now?: number;
  client?: AdLibraryClient;
  repository?: DiscoveryRepository;
  budget?: DiscoveryBudget;
  onProgress?: (p: WordSearchProgress) => void;
}

/** Países en los que ya hemos visto a este candidato (por page_id + huella). */
export function countriesSeenFor(snapshot: DiscoverySnapshot, repository: DiscoveryRepository): string[] {
  try {
    return repository.countriesForCandidate(snapshot.pageId, snapshot.fingerprint);
  } catch {
    return [];
  }
}

export async function runWordSearch(input: WordSearchInput): Promise<WordSearchResult> {
  const started = Date.now();
  const country = input.country ?? "ES";
  const days = input.days ?? 30;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const repository = input.repository ?? new DiscoveryRepository();

  input.onProgress?.({ fase: "expandiendo", term: null, termsDone: 0, termsTotal: 0, ads: 0, requests: 0, remainingSec: 0 });
  const terms = expandSearchTerm(input.seed, { max: input.maxTerms ?? 24 });
  if (terms.length === 0) {
    return { seed: input.seed, terms: [], termsQueried: [], stopReason: "completado", requests: 0, pages: 0, rawAds: 0, competitors: [], discarded: [], elapsedSec: 0 };
  }

  const budget =
    input.budget ??
    new DiscoveryBudget({
      deadlineAt: started + (input.minutes ?? DEFAULT_SEARCH_MINUTES) * 60_000,
      maxRequests: input.maxRequests ?? DEFAULT_MAX_REQUESTS,
    });

  const run = await runDiscovery({
    terms: terms.map((t) => t.term),
    country,
    days,
    token: input.token,
    now,
    client: input.client,
    repository,
    budget,
    onProgress: (p) =>
      input.onProgress?.({
        fase: "buscando",
        term: p.term,
        termsDone: p.index + 1,
        termsTotal: p.total,
        ads: p.ads,
        requests: p.requests,
        remainingSec: Math.round(budget.remainingMs() / 1000),
      }),
  });

  input.onProgress?.({ fase: "agrupando", term: null, termsDone: run.termsQueried.length, termsTotal: terms.length, ads: run.rawCount, requests: run.requests, remainingSec: Math.round(budget.remainingMs() / 1000) });

  const informes = run.snapshots.map((snapshot) =>
    competitorSignals({ snapshot, now, countriesSeen: countriesSeenFor(snapshot, repository) })
  );
  const orden = (a: CompetitorReport, b: CompetitorReport) => b.activeAds - a.activeAds;

  const result: WordSearchResult = {
    seed: input.seed,
    terms,
    termsQueried: run.termsQueried,
    stopReason: run.stopReason,
    requests: run.requests,
    pages: run.pages,
    rawAds: run.rawCount,
    competitors: informes.filter((c) => !c.noise).sort(orden),
    discarded: informes.filter((c) => c.noise).sort(orden),
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };
  input.onProgress?.({ fase: "terminado", term: null, termsDone: run.termsQueried.length, termsTotal: terms.length, ads: run.rawCount, requests: run.requests, remainingSec: Math.round(budget.remainingMs() / 1000) });
  return result;
}
