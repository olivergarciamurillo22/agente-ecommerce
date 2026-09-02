// ============================================================
// Cazador de productos — ADAPTADORES DE FUENTE DE DATOS.
//
// Selección por entorno (`createProductHunterDataSource`):
//   PRODUCT_HUNTER_SOURCE=api   → RealAdapter contra PRODUCT_HUNTER_API_URL
//                                 (sin URL → NotConfiguredError).
//   PRODUCT_HUNTER_SOURCE=mock  → MockAdapter en memoria, SOLO si
//                                 NODE_ENV !== "production". En producción
//                                 lanza NotConfiguredError: un mock jamás
//                                 llega al NAS.
//   cualquier otro valor / vacío → OffAdapter: todo responde "no configurado".
//
// ------------------------------------------------------------
// CONTRATO HTTP QUE DEBE IMPLEMENTAR EL BACKEND DE PEDRO
// ------------------------------------------------------------
// Base: PRODUCT_HUNTER_API_URL (sin barra final). Todo JSON (UTF-8).
// Autenticación opcional: `Authorization: Bearer <PRODUCT_HUNTER_API_TOKEN>`,
// añadida SOLO desde el servidor Next; el navegador nunca ve el token.
//
//   GET  /search?country=ES&keywords=...&category=&platform=all|facebook|instagram
//        &creativeFormat=all|video|image|carousel&activeOnly=1&startedAfter=YYYY-MM-DD
//        &minActiveDays=30&sort=relevance|newest|longest_active|most_variations
//        &page=1&pageSize=12&advanced=<JSON urlencoded>
//        → AdLibrarySearchPage { results: AdLibraryResult[], page, pageSize,
//                                total: number|null, hasMore: boolean }
//
//   GET  /candidates?status=saved,researching&country=ES&minScore=60&saturation=low
//        → { candidates: SavedCandidate[] }
//
//   GET  /candidates/{id}
//        → WinningProductCandidate. Debe resolver también ids de resultados de
//          búsqueda aún no guardados (devolviendo status "discovered") o 404.
//
//   POST /candidates            body: SaveCandidateInput { result, note? }
//        → WinningProductCandidate con status "saved" y savedAt.
//
//   POST /candidates/{id}/status     body: { status: ProductResearchStatus, note?: string|null }
//        → WinningProductCandidate (con la decisión {at, from, to, note} añadida).
//
//   POST /candidates/{id}/notes      body: { text: string }
//        → WinningProductCandidate.
//
//   POST /candidates/{id}/economics  body: CandidateEconomics
//        → WinningProductCandidate.
//
//   POST /compare               body: { ids: string[] }  (2–4 ids)
//        → { candidates: WinningProductCandidate[] }
//
// Errores: código HTTP ≠ 2xx con body { error: string, code?: string }.
// 404 en /candidates/{id} se traduce a `null`.
//
// Honestidad: las respuestas pasan por `normalizeCandidate` /
// `normalizeAdLibraryResult`, que solo copian claves conocidas. Cualquier
// campo de ventas/ROAS/gasto que el backend colase se descarta aquí y los
// tests de contrato lo vigilan.
// ============================================================

import { buildMockCandidates } from "./mock-data";
import {
  assertCompareIds,
  isProductResearchStatus,
  normalizeAdLibraryResult,
  normalizeCandidate,
  normalizeEconomics,
  ProductHunterInputError,
  toAdLibraryResult,
} from "./scoring";
import {
  type AdLibraryResult,
  type AdLibrarySearchPage,
  type AdLibrarySearchParams,
  type CandidateComparison,
  type CandidateEconomics,
  type ProductHunterAvailability,
  type ProductHunterDataSource,
  type ProductHunterFilters,
  type ProductHunterSourceKind,
  type ProductResearchStatus,
  type SaveCandidateInput,
  type SavedCandidate,
  type WinningProductCandidate,
} from "./types";

// --- Errores tipados ---

export class NotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED" as const;
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class ProductHunterUpstreamError extends Error {
  readonly code = "UPSTREAM" as const;
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProductHunterUpstreamError";
    this.status = status;
  }
}

// --- Resolución de entorno (se lee en cada llamada: sin caché, testeable) ---

const OFF_REASON =
  "Activa PRODUCT_HUNTER_SOURCE=api con la URL del backend de Pedro, o =mock en desarrollo";

function envSource(): string {
  return (process.env.PRODUCT_HUNTER_SOURCE ?? "").trim().toLowerCase();
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function apiUrl(): string | null {
  const raw = (process.env.PRODUCT_HUNTER_API_URL ?? "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "backend";
  }
}

export function productHunterAvailability(): ProductHunterAvailability {
  const src = envSource();
  if (src === "api") {
    const url = apiUrl();
    if (!url) {
      return { available: false, source: "api", reason: "Falta PRODUCT_HUNTER_API_URL: sin URL no hay backend al que preguntar." };
    }
    return { available: true, source: "api", reason: `Conectado al backend en ${hostOf(url)}.` };
  }
  if (src === "mock") {
    if (isProduction()) {
      return {
        available: false,
        source: "mock",
        reason: "PRODUCT_HUNTER_SOURCE=mock no está permitido en producción. Usa =api con la URL del backend de Pedro.",
      };
    }
    return { available: true, source: "mock", reason: "Datos de ejemplo (mock), solo para desarrollo." };
  }
  return { available: false, source: "off", reason: OFF_REASON };
}

export function createProductHunterDataSource(): ProductHunterDataSource {
  const availability = productHunterAvailability();
  if (availability.source === "api") {
    const url = apiUrl();
    if (!url) throw new NotConfiguredError(availability.reason);
    return new RealAdapter(url, (process.env.PRODUCT_HUNTER_API_TOKEN ?? "").trim() || null);
  }
  if (availability.source === "mock") {
    if (!availability.available) throw new NotConfiguredError(availability.reason);
    return new MockAdapter();
  }
  return new OffAdapter(availability.reason);
}

// ============================================================
// OffAdapter — "no configurado", sin fingir nada.
// ============================================================

class OffAdapter implements ProductHunterDataSource {
  readonly source: ProductHunterSourceKind = "off";
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new NotConfiguredError(this.reason);
  }
  async search(): Promise<AdLibrarySearchPage> {
    return this.fail();
  }
  async getCandidate(): Promise<WinningProductCandidate | null> {
    return this.fail();
  }
  async listSaved(): Promise<SavedCandidate[]> {
    return this.fail();
  }
  async saveCandidate(): Promise<SavedCandidate> {
    return this.fail();
  }
  async moveCandidate(): Promise<WinningProductCandidate> {
    return this.fail();
  }
  async addNote(): Promise<WinningProductCandidate> {
    return this.fail();
  }
  async setEconomics(): Promise<WinningProductCandidate> {
    return this.fail();
  }
  async compare(): Promise<CandidateComparison> {
    return this.fail();
  }
}

// ============================================================
// RealAdapter — proxy HTTP al backend de Pedro.
// ============================================================

const UPSTREAM_TIMEOUT_MS = 15_000;

function searchParamsToQuery(p: AdLibrarySearchParams): URLSearchParams {
  const q = new URLSearchParams();
  q.set("country", p.country);
  q.set("keywords", p.keywords);
  if (p.category) q.set("category", p.category);
  if (p.platform) q.set("platform", p.platform);
  if (p.creativeFormat) q.set("creativeFormat", p.creativeFormat);
  if (p.activeOnly !== undefined) q.set("activeOnly", p.activeOnly ? "1" : "0");
  if (p.startedAfter) q.set("startedAfter", p.startedAfter);
  if (p.minActiveDays !== undefined) q.set("minActiveDays", String(p.minActiveDays));
  if (p.sort) q.set("sort", p.sort);
  if (p.page !== undefined) q.set("page", String(p.page));
  if (p.pageSize !== undefined) q.set("pageSize", String(p.pageSize));
  if (p.advanced && Object.keys(p.advanced).length > 0) q.set("advanced", JSON.stringify(p.advanced));
  return q;
}

function filtersToQuery(f: ProductHunterFilters): URLSearchParams {
  const q = new URLSearchParams();
  if (f.status && f.status.length > 0) q.set("status", f.status.join(","));
  if (f.country) q.set("country", f.country);
  if (f.minScore !== undefined) q.set("minScore", String(f.minScore));
  if (f.saturation) q.set("saturation", f.saturation);
  return q;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class RealAdapter implements ProductHunterDataSource {
  readonly source: ProductHunterSourceKind = "api";

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null
  ) {}

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Devuelve el JSON parseado, o `null` en 404 cuando `allow404`. */
  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown; allow404?: boolean }): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: this.headers(init.body !== undefined),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === "TimeoutError" ? "el backend no respondió a tiempo" : "no se pudo contactar con el backend";
      throw new ProductHunterUpstreamError(msg);
    }
    if (res.status === 404 && init.allow404) return null;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const upstreamMsg = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
      if (res.status === 400 || res.status === 422) throw new ProductHunterInputError(upstreamMsg);
      if (res.status === 404) throw new ProductHunterInputError(upstreamMsg, "NOT_FOUND");
      throw new ProductHunterUpstreamError(upstreamMsg, res.status);
    }
    return body;
  }

  private candidateOrThrow(raw: unknown, what: string): WinningProductCandidate {
    const c = normalizeCandidate(raw);
    if (!c) throw new ProductHunterUpstreamError(`respuesta inválida del backend en ${what}`);
    return c;
  }

  async search(params: AdLibrarySearchParams): Promise<AdLibrarySearchPage> {
    const raw = await this.call(`/search?${searchParamsToQuery(params).toString()}`, { method: "GET" });
    const o = isRecord(raw) ? raw : {};
    const list = Array.isArray(o.results) ? o.results : [];
    const results = list.map(normalizeAdLibraryResult).filter((r): r is AdLibraryResult => r !== null);
    const page = typeof o.page === "number" && Number.isFinite(o.page) ? o.page : (params.page ?? 1);
    const pageSize = typeof o.pageSize === "number" && Number.isFinite(o.pageSize) ? o.pageSize : (params.pageSize ?? results.length);
    return {
      results,
      page,
      pageSize,
      total: typeof o.total === "number" && Number.isFinite(o.total) ? o.total : null,
      hasMore: o.hasMore === true,
    };
  }

  async getCandidate(id: string): Promise<WinningProductCandidate | null> {
    const raw = await this.call(`/candidates/${encodeURIComponent(id)}`, { method: "GET", allow404: true });
    if (raw === null) return null;
    return this.candidateOrThrow(raw, "getCandidate");
  }

  async listSaved(filters: ProductHunterFilters = {}): Promise<SavedCandidate[]> {
    const q = filtersToQuery(filters).toString();
    const raw = await this.call(`/candidates${q ? `?${q}` : ""}`, { method: "GET" });
    const list = isRecord(raw) && Array.isArray(raw.candidates) ? raw.candidates : [];
    return list
      .map(normalizeCandidate)
      .filter((c): c is SavedCandidate => c !== null && c.savedAt !== null);
  }

  async saveCandidate(input: SaveCandidateInput): Promise<SavedCandidate> {
    const raw = await this.call(`/candidates`, {
      method: "POST",
      body: { result: toAdLibraryResult(input.result), note: input.note ?? null },
    });
    const c = this.candidateOrThrow(raw, "saveCandidate");
    if (!c.savedAt) throw new ProductHunterUpstreamError("el backend guardó el candidato sin savedAt");
    return c as SavedCandidate;
  }

  async moveCandidate(id: string, status: ProductResearchStatus, note: string | null = null): Promise<WinningProductCandidate> {
    if (!isProductResearchStatus(status)) throw new ProductHunterInputError("estado de pipeline desconocido");
    const raw = await this.call(`/candidates/${encodeURIComponent(id)}/status`, { method: "POST", body: { status, note } });
    return this.candidateOrThrow(raw, "moveCandidate");
  }

  async addNote(id: string, text: string): Promise<WinningProductCandidate> {
    const t = text.trim();
    if (!t) throw new ProductHunterInputError("la nota no puede estar vacía");
    const raw = await this.call(`/candidates/${encodeURIComponent(id)}/notes`, { method: "POST", body: { text: t } });
    return this.candidateOrThrow(raw, "addNote");
  }

  async setEconomics(id: string, economics: CandidateEconomics): Promise<WinningProductCandidate> {
    const clean = normalizeEconomics(economics) ?? { costEstimate: null, salePriceEstimate: null, shippingCost: null, returnCost: null };
    const raw = await this.call(`/candidates/${encodeURIComponent(id)}/economics`, { method: "POST", body: clean });
    return this.candidateOrThrow(raw, "setEconomics");
  }

  async compare(ids: string[]): Promise<CandidateComparison> {
    const clean = assertCompareIds(ids);
    const raw = await this.call(`/compare`, { method: "POST", body: { ids: clean } });
    const list = isRecord(raw) && Array.isArray(raw.candidates) ? raw.candidates : [];
    const candidates = list.map(normalizeCandidate).filter((c): c is WinningProductCandidate => c !== null);
    return { ids: clean, candidates, comparedAt: new Date().toISOString() };
  }
}

// ============================================================
// MockAdapter — memoria del proceso; se reinicia al reiniciar. SOLO dev.
// ============================================================

let mockStore: Map<string, WinningProductCandidate> | null = null;

function store(): Map<string, WinningProductCandidate> {
  if (!mockStore) {
    mockStore = new Map(buildMockCandidates().map((c) => [c.id, c]));
  }
  return mockStore;
}

/** Vuelve a los fixtures iniciales (lo usan los tests de contrato). */
export function resetMockStore(): void {
  mockStore = null;
}

const clone = <T>(v: T): T => structuredClone(v);

function nowIso(): string {
  return new Date().toISOString();
}

function haystack(c: WinningProductCandidate): string {
  return [c.productName, c.advertiser, c.adCopy, c.landingUrl].filter(Boolean).join(" ").toLowerCase();
}

function numDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

class MockAdapter implements ProductHunterDataSource {
  readonly source: ProductHunterSourceKind = "mock";

  private get(id: string): WinningProductCandidate {
    const c = store().get(id);
    if (!c) throw new ProductHunterInputError(`no existe el candidato ${id}`, "NOT_FOUND");
    return c;
  }

  async search(params: AdLibrarySearchParams): Promise<AdLibrarySearchPage> {
    const kw = params.keywords.trim().toLowerCase();
    const terms = kw ? kw.split(/\s+/) : [];
    const country = params.country.toUpperCase();
    let list = [...store().values()].filter((c) => c.countries.includes(country));

    if (terms.length > 0) list = list.filter((c) => terms.some((t) => haystack(c).includes(t)));
    if (params.creativeFormat && params.creativeFormat !== "all") list = list.filter((c) => c.format === params.creativeFormat);
    // El mock no distingue anuncios pausados: "solo activos" excluye los que no
    // tienen histórico de actividad (activeDays null).
    if (params.activeOnly) list = list.filter((c) => c.activeDays !== null);
    if (params.minActiveDays !== undefined && params.minActiveDays > 0) {
      const min = params.minActiveDays;
      list = list.filter((c) => c.activeDays !== null && c.activeDays >= min);
    }
    if (params.startedAfter) {
      const after = params.startedAfter;
      list = list.filter((c) => c.startedAt !== null && c.startedAt >= after);
    }

    const sort = params.sort ?? "relevance";
    if (sort === "newest") list.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    else if (sort === "longest_active") list.sort((a, b) => numDesc(a.activeDays, b.activeDays));
    else if (sort === "most_variations") list.sort((a, b) => numDesc(a.variations, b.variations));
    else {
      const rel = (c: WinningProductCandidate): number => {
        const name = (c.productName ?? "").toLowerCase();
        const nameHits = terms.filter((t) => name.includes(t)).length;
        return nameHits * 1000 + (c.winnerScore?.total ?? 0);
      };
      list.sort((a, b) => rel(b) - rel(a));
    }

    const pageSize = Math.min(48, Math.max(1, params.pageSize ?? 12));
    const page = Math.max(1, params.page ?? 1);
    const start = (page - 1) * pageSize;
    const slice = list.slice(start, start + pageSize);
    return {
      results: slice.map((c) => toAdLibraryResult(clone(c))),
      page,
      pageSize,
      total: list.length,
      hasMore: start + pageSize < list.length,
    };
  }

  async getCandidate(id: string): Promise<WinningProductCandidate | null> {
    const c = store().get(id);
    return c ? clone(c) : null;
  }

  async listSaved(filters: ProductHunterFilters = {}): Promise<SavedCandidate[]> {
    let list = [...store().values()].filter((c): c is SavedCandidate => c.savedAt !== null && c.status !== "discovered");
    if (filters.status && filters.status.length > 0) {
      const set = new Set(filters.status);
      list = list.filter((c) => set.has(c.status));
    }
    if (filters.country) {
      const cc = filters.country.toUpperCase();
      list = list.filter((c) => c.countries.includes(cc));
    }
    if (filters.minScore !== undefined) {
      const min = filters.minScore;
      list = list.filter((c) => c.winnerScore !== null && c.winnerScore.total !== null && c.winnerScore.total >= min);
    }
    if (filters.saturation) list = list.filter((c) => c.saturation === filters.saturation);
    list.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return list.map((c) => clone(c));
  }

  async saveCandidate(input: SaveCandidateInput): Promise<SavedCandidate> {
    const result = normalizeAdLibraryResult(input.result);
    if (!result) throw new ProductHunterInputError("resultado sin id");
    const at = nowIso();
    const existing = store().get(result.id);
    const note = input.note?.trim() || null;
    const candidate: WinningProductCandidate = existing
      ? { ...existing, ...toAdLibraryResult(result), savedAt: existing.savedAt ?? at }
      : { ...result, status: "discovered", economics: null, notes: [], decisions: [], savedAt: at, risks: [], saturation: null };
    const from = existing?.status ?? null;
    if (candidate.status === "discovered" || !existing) {
      candidate.status = "saved";
      candidate.decisions = [...candidate.decisions, { at, from: from === "discovered" ? null : from, to: "saved", note }];
    }
    if (note) candidate.notes = [...candidate.notes, { at, text: note }];
    if (!candidate.savedAt) candidate.savedAt = at;
    store().set(candidate.id, candidate);
    return clone(candidate) as SavedCandidate;
  }

  async moveCandidate(id: string, status: ProductResearchStatus, note: string | null = null): Promise<WinningProductCandidate> {
    if (!isProductResearchStatus(status)) throw new ProductHunterInputError("estado de pipeline desconocido");
    const c = this.get(id);
    const at = nowIso();
    const updated: WinningProductCandidate = {
      ...c,
      status,
      savedAt: c.savedAt ?? at,
      decisions: [...c.decisions, { at, from: c.status, to: status, note: note?.trim() || null }],
    };
    store().set(id, updated);
    return clone(updated);
  }

  async addNote(id: string, text: string): Promise<WinningProductCandidate> {
    const t = text.trim();
    if (!t) throw new ProductHunterInputError("la nota no puede estar vacía");
    const c = this.get(id);
    const updated: WinningProductCandidate = { ...c, notes: [...c.notes, { at: nowIso(), text: t }] };
    store().set(id, updated);
    return clone(updated);
  }

  async setEconomics(id: string, economics: CandidateEconomics): Promise<WinningProductCandidate> {
    const c = this.get(id);
    const clean = normalizeEconomics(economics) ?? { costEstimate: null, salePriceEstimate: null, shippingCost: null, returnCost: null };
    const updated: WinningProductCandidate = { ...c, economics: clean };
    store().set(id, updated);
    return clone(updated);
  }

  async compare(ids: string[]): Promise<CandidateComparison> {
    const clean = assertCompareIds(ids);
    const candidates = clean.map((id) => clone(this.get(id)));
    return { ids: clean, candidates, comparedAt: nowIso() };
  }
}
