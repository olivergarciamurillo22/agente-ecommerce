// ============================================================
// InternalAdapter — el backend del Cazador DENTRO del mismo proceso (08-09-2026)
// docs/PRODUCT-HUNTER-BACKEND-PLAN.md
//
// Implementa ProductHunterDataSource sin fetch saliente:
//   · search    → fuentes reales (adlib | local | dropea | cruce), plan §2
//   · pipeline  → tabla hunter_pipeline (estado, notas, decisiones, economics)
//   · hechos    → product_candidates + motor hunter:score (src/lib/hunter),
//                 importado, no reimplementado
//
// Un candidato del pipeline enlaza (product_candidate_id) con una fila de
// product_candidates en cuanto tiene hechos: coste del catálogo de Dropea
// (origen "dropea") o los que Pedro teclea (origen "manual"). Sin hechos no
// hay margen ni score: fail-closed, igual que hunter:score.
// ============================================================

import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import { HunterRepository } from "../../hunter/repository";
import { missingScoreReasons } from "../../hunter/scoring";
import type { ProductCandidate } from "../../hunter/types";
import { ProductHunterInputError } from "../scoring";
import { assertCompareIds, isProductResearchStatus, normalizeAdLibraryResult, normalizeEconomics, toAdLibraryResult } from "../scoring";
import type {
  AdLibraryResult, AdLibrarySearchPage, AdLibrarySearchParams, CandidateComparison, CandidateEconomics, CandidateFactsInput,
  InternalSearchSource, ProductHunterDataSource, ProductHunterFilters, ProductHunterSourceKind, ProductResearchStatus, SaveCandidateInput,
  SavedCandidate, WinningProductCandidate,
} from "../types";
import { AdlibSource, DropeaSource, LocalSource, factsOf, hunterScoreOf, localResult, parseSourceId } from "./sources";
import { CruceSource } from "./cruce-source";

const nowIso = () => new Date().toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);
const parse = <T>(v: unknown, fallback: T): T => { if (typeof v !== "string") return fallback; try { return JSON.parse(v) as T; } catch { return fallback; } };

interface PipelineRow { id: string; source: string; result_json: string; status: string; economics_json: string | null; notes_json: string; decisions_json: string; risks_json: string; saturation: string | null; saved_at: number | null; product_candidate_id: number | null; created_at: number; updated_at: number }

/** El contrato llama pvpEur a lo que el motor llama salePriceEur (evita el token «sale» prohibido en el contrato). */
function toHunterFacts(f: CandidateFactsInput): Parameters<HunterRepository["setFacts"]>[1] {
  const out: Parameters<HunterRepository["setFacts"]>[1] = {};
  if (f.unitCostEur !== undefined) out.unitCostEur = f.unitCostEur;
  if (f.pvpEur !== undefined) out.salePriceEur = f.pvpEur;
  if (f.weightGrams !== undefined) out.weightGrams = f.weightGrams;
  if (f.lengthCm !== undefined) out.lengthCm = f.lengthCm;
  if (f.widthCm !== undefined) out.widthCm = f.widthCm;
  if (f.heightCm !== undefined) out.heightCm = f.heightCm;
  return out;
}

export function sourceOfId(id: string): InternalSearchSource {
  const p = parseSourceId(id);
  if (!p) throw new ProductHunterInputError(`id de candidato no reconocido: ${id}`, "NOT_FOUND");
  return p.kind === "adlib" ? "ad_library" : p.kind;
}

export class InternalAdapter implements ProductHunterDataSource {
  readonly source: ProductHunterSourceKind = "internal";
  private readonly hunter: HunterRepository;
  private readonly adlib: AdlibSource;
  private readonly local: LocalSource;
  private readonly dropea: DropeaSource;
  private readonly cruce: CruceSource;

  constructor(private readonly db: Database.Database = systemDbHandle(), private readonly now: () => number = nowSec) {
    this.hunter = new HunterRepository(db);
    this.adlib = new AdlibSource(db);
    this.local = new LocalSource(this.hunter);
    this.dropea = new DropeaSource();
    this.cruce = new CruceSource(db);
  }

  // ---------------- búsqueda ----------------
  async search(params: AdLibrarySearchParams): Promise<AdLibrarySearchPage> {
    const pageSize = Math.min(48, Math.max(1, params.pageSize ?? 12));
    const page = Math.max(1, params.page ?? 1);
    const fuente = (params.advanced?.source as InternalSearchSource | "all" | undefined) ?? "all";
    const term = params.keywords.trim();
    const t = this.now();

    // Dropea pagina en SQL: el catálogo es grande.
    if (fuente === "dropea") {
      const { rows, total } = this.dropea.repo.search(term, { page, pageSize, category: params.category ?? null });
      const results = rows.map((r) => this.overlay(this.cruce.enrichDropea(r, t)));
      return { results, page, pageSize, total, hasMore: page * pageSize < total };
    }

    let list: AdLibraryResult[] = [];
    if (fuente === "all" || fuente === "ad_library") list.push(...this.adlib.search(term, params.country, t));
    if (fuente === "all" || fuente === "local") list.push(...this.local.search(term).map((x) => x.result));
    if (fuente === "cruce") list.push(...this.cruce.search(term, params.country));

    if (params.activeOnly) list = list.filter((c) => c.activeDays !== null || c.id.startsWith("local:"));
    if (params.minActiveDays !== undefined && params.minActiveDays > 0) list = list.filter((c) => c.activeDays !== null && c.activeDays >= (params.minActiveDays as number));
    if (params.startedAfter) list = list.filter((c) => c.startedAt !== null && c.startedAt >= (params.startedAfter as string));

    const numDesc = (a: number | null, b: number | null) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : b - a);
    const sort = params.sort ?? "relevance";
    if (sort === "newest") list.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    else if (sort === "longest_active") list.sort((a, b) => numDesc(a.activeDays, b.activeDays));
    else if (sort === "most_variations") list.sort((a, b) => numDesc(a.variations, b.variations));
    else list.sort((a, b) => numDesc(a.winnerScore?.total ?? null, b.winnerScore?.total ?? null));

    const start = (page - 1) * pageSize;
    const slice = list.slice(start, start + pageSize).map((r) => this.overlay(r));
    return { results: slice, page, pageSize, total: list.length, hasMore: start + pageSize < list.length };
  }

  /** Si el resultado ya está en el pipeline, se enseña con su estado (el panel marca «guardado»). */
  private overlay(r: AdLibraryResult): AdLibraryResult {
    const row = this.row(r.id);
    return row ? toAdLibraryResult(this.fromRow(row)) : r;
  }

  // ---------------- lectura ----------------
  private row(id: string): PipelineRow | null {
    return (this.db.prepare("SELECT * FROM hunter_pipeline WHERE id=?").get(id) as PipelineRow | undefined) ?? null;
  }

  /** El resultado «vivo» de la fuente, por id. Null si la fuente no lo tiene. */
  private liveResult(id: string): { result: AdLibraryResult; candidate: ProductCandidate | null; factsSource: "dropea" | "scraping" | null } | null {
    const p = parseSourceId(id);
    if (!p) return null;
    const t = this.now();
    if (p.kind === "adlib") { const r = this.adlib.byKey(p.key, t); return r ? { result: r, candidate: null, factsSource: null } : null; }
    if (p.kind === "local") { const c = this.local.byId(p.id); return c ? { result: localResult(c), candidate: c, factsSource: c.sourceUrl.startsWith("hunter://") ? null : "scraping" } : null; }
    if (p.kind === "dropea") { const r = this.dropea.byVariantId(p.variantId); return r ? { result: this.cruce.enrichDropea(r, this.now()), candidate: null, factsSource: "dropea" } : null; }
    const cr = this.cruce.byId(p.id);
    return cr ? { result: cr, candidate: null, factsSource: "dropea" } : null;
  }

  private fromRow(row: PipelineRow): WinningProductCandidate {
    const base = normalizeAdLibraryResult(parse<unknown>(row.result_json, {})) ?? normalizeAdLibraryResult({ id: row.id })!;
    const candidate = row.product_candidate_id ? this.hunter.byId(row.product_candidate_id) : null;
    const factsSource = candidate ? this.factsSourceOf(candidate) : null;
    return {
      ...base,
      status: (isProductResearchStatus(row.status) ? row.status : "discovered") as ProductResearchStatus,
      economics: normalizeEconomics(parse<unknown>(row.economics_json, null)),
      notes: parse(row.notes_json, []),
      decisions: parse(row.decisions_json, []),
      savedAt: row.saved_at ? new Date(row.saved_at * 1000).toISOString() : null,
      risks: parse(row.risks_json, []),
      saturation: null,
      facts: candidate ? factsOf(candidate, factsSource) : null,
      hunterScore: candidate ? hunterScoreOf(candidate) : null,
      hunterMissing: candidate && !candidate.scoring ? missingScoreReasons(candidate).map((r) => ({ factor: r.factor, detail: r.detail })) : undefined,
    };
  }

  /** El origen de los hechos queda escrito en nota_manual por setFacts; si no hay marca, es scraping. */
  private factsSourceOf(c: ProductCandidate): "manual" | "dropea" | "scraping" {
    const nota = c.manualNote ?? "";
    if (/\[manual \d{4}-\d{2}-\d{2}\]/.test(nota)) return "manual";
    if (/\[dropea \d{4}-\d{2}-\d{2}\]/.test(nota)) return "dropea";
    return "scraping";
  }

  async getCandidate(id: string): Promise<WinningProductCandidate | null> {
    const row = this.row(id);
    if (row) return this.fromRow(row);
    const live = this.liveResult(id);
    if (!live) return null;
    const shape: WinningProductCandidate = { ...live.result, status: "discovered", economics: null, notes: [], decisions: [], savedAt: null, risks: [], saturation: null };
    if (live.candidate) {
      shape.facts = factsOf(live.candidate, live.factsSource);
      shape.hunterScore = hunterScoreOf(live.candidate);
      if (!live.candidate.scoring) shape.hunterMissing = missingScoreReasons(live.candidate).map((r) => ({ factor: r.factor, detail: r.detail }));
    }
    return shape;
  }

  async listSaved(filters: ProductHunterFilters = {}): Promise<SavedCandidate[]> {
    const rows = this.db.prepare("SELECT * FROM hunter_pipeline WHERE saved_at IS NOT NULL AND status <> 'discovered' ORDER BY saved_at DESC, id").all() as PipelineRow[];
    let list = rows.map((r) => this.fromRow(r)).filter((c): c is SavedCandidate => c.savedAt !== null);
    if (filters.status?.length) { const set = new Set(filters.status); list = list.filter((c) => set.has(c.status)); }
    if (filters.country) { const cc = filters.country.toUpperCase(); list = list.filter((c) => c.countries.length === 0 || c.countries.includes(cc)); }
    if (filters.minScore !== undefined) { const min = filters.minScore; list = list.filter((c) => (c.winnerScore?.total ?? c.hunterScore?.score ?? -1) >= min); }
    if (filters.saturation) list = list.filter((c) => c.saturation === filters.saturation);
    return list;
  }

  // ---------------- escritura ----------------
  private write(c: WinningProductCandidate, productCandidateId: number | null): void {
    const source = sourceOfId(c.id);
    this.db.prepare(`INSERT INTO hunter_pipeline(id,source,result_json,status,economics_json,notes_json,decisions_json,risks_json,saturation,saved_at,product_candidate_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,unixepoch())
      ON CONFLICT(id) DO UPDATE SET result_json=excluded.result_json,status=excluded.status,economics_json=excluded.economics_json,notes_json=excluded.notes_json,
        decisions_json=excluded.decisions_json,risks_json=excluded.risks_json,saturation=excluded.saturation,saved_at=excluded.saved_at,
        product_candidate_id=COALESCE(excluded.product_candidate_id,hunter_pipeline.product_candidate_id),updated_at=unixepoch()`)
      .run(c.id, source, JSON.stringify(toAdLibraryResult(c)), c.status, c.economics ? JSON.stringify(c.economics) : null, JSON.stringify(c.notes), JSON.stringify(c.decisions), JSON.stringify(c.risks), c.saturation,
        c.savedAt ? Math.floor(Date.parse(c.savedAt) / 1000) : null, productCandidateId);
  }

  private mustGet(id: string): { candidate: WinningProductCandidate; row: PipelineRow } {
    const row = this.row(id);
    if (!row) throw new ProductHunterInputError(`el candidato ${id} no está guardado en el pipeline`, "NOT_FOUND");
    return { candidate: this.fromRow(row), row };
  }

  /**
   * Fila de product_candidates enlazada a un candidato del pipeline. Se crea
   * si no existe, con source_url sintética `hunter://<id>` (única y estable),
   * y con el coste del catálogo si el candidato viene de Dropea.
   */
  private ensureLocalCandidate(id: string, row: PipelineRow | null, result: AdLibraryResult): ProductCandidate {
    if (row?.product_candidate_id) { const c = this.hunter.byId(row.product_candidate_id); if (c) return c; }
    const p = parseSourceId(id);
    if (p?.kind === "local") { const c = this.hunter.byId(p.id); if (c) return c; }
    const existing = this.hunter.byUrl(`hunter://${id}`);
    if (existing) return existing;
    const dropea = p?.kind === "dropea" ? this.dropea.byVariantId(p.variantId) : p?.kind === "cruce" ? this.cruce.dropeaRowOf(p.id) : null;
    const created = this.hunter.upsert({
      sourceUrl: `hunter://${id}`, sourceDomain: p?.kind === "adlib" ? "ad-library" : p?.kind === "dropea" || p?.kind === "cruce" ? "dropea" : "manual",
      fetchedAt: this.now(), name: result.productName, category: null,
      unitCostEur: dropea?.costEur ?? null, salePriceEur: null, sourceCurrency: dropea?.currency ?? (dropea ? "EUR" : null), sourceCost: dropea?.costEur ?? null,
      weightGrams: null, lengthCm: null, widthCm: null, heightCm: null, variants: null, specs: null, claims: null,
    });
    if (dropea && dropea.costEur !== null) this.hunter.setFacts(created.id, { unitCostEur: dropea.costEur }, "dropea");
    return this.hunter.byId(created.id)!;
  }

  async saveCandidate(input: SaveCandidateInput): Promise<SavedCandidate> {
    const result = normalizeAdLibraryResult(input.result);
    if (!result) throw new ProductHunterInputError("resultado sin id");
    sourceOfId(result.id);
    const at = nowIso();
    const row = this.row(result.id);
    const existing = row ? this.fromRow(row) : null;
    const note = input.note?.trim() || null;
    // Lo que manda es la fuente viva (si sigue existiendo); si no, lo que llegó del panel.
    const live = this.liveResult(result.id)?.result ?? result;
    const candidate: WinningProductCandidate = existing
      ? { ...existing, ...toAdLibraryResult(live), savedAt: existing.savedAt ?? at }
      : { ...live, status: "discovered", economics: null, notes: [], decisions: [], savedAt: at, risks: [], saturation: null };
    const from = existing?.status ?? null;
    if (!existing || candidate.status === "discovered") {
      candidate.status = "saved";
      candidate.decisions = [...candidate.decisions, { at, from: from === "discovered" ? null : from, to: "saved", note }];
    }
    if (note) candidate.notes = [...candidate.notes, { at, text: note }];
    // Hechos: el catálogo de Dropea aporta el coste solo; Pedro puede completar el resto.
    let local: ProductCandidate | null = row?.product_candidate_id ? this.hunter.byId(row.product_candidate_id) : null;
    const p = parseSourceId(result.id);
    if (input.facts || p?.kind === "dropea" || p?.kind === "cruce" || p?.kind === "local") {
      local = this.ensureLocalCandidate(result.id, row, live);
      if (input.facts) local = this.hunter.setFacts(local.id, toHunterFacts(input.facts), "manual");
      local = this.hunter.score(local.id);
    }
    this.write(candidate, local?.id ?? null);
    return this.fromRow(this.row(result.id)!) as SavedCandidate;
  }

  async moveCandidate(id: string, status: ProductResearchStatus, note: string | null = null): Promise<WinningProductCandidate> {
    if (!isProductResearchStatus(status)) throw new ProductHunterInputError("estado de pipeline desconocido");
    const { candidate, row } = this.mustGet(id);
    const at = nowIso();
    const updated: WinningProductCandidate = { ...candidate, status, savedAt: candidate.savedAt ?? at, decisions: [...candidate.decisions, { at, from: candidate.status, to: status, note: note?.trim() || null }] };
    this.write(updated, row.product_candidate_id);
    return this.fromRow(this.row(id)!);
  }

  async addNote(id: string, text: string): Promise<WinningProductCandidate> {
    const t = text.trim();
    if (!t) throw new ProductHunterInputError("la nota no puede estar vacía");
    const { candidate, row } = this.mustGet(id);
    this.write({ ...candidate, notes: [...candidate.notes, { at: nowIso(), text: t }] }, row.product_candidate_id);
    return this.fromRow(this.row(id)!);
  }

  /**
   * Economics del contrato = supuestos de Pedro para la cuenta transparente
   * del panel. Además, coste y PVP alimentan los hechos del motor real
   * (hunter:score) como dato MANUAL, así el margen del motor y el del panel
   * salen de los mismos números.
   */
  async setEconomics(id: string, economics: CandidateEconomics): Promise<WinningProductCandidate> {
    const { candidate, row } = this.mustGet(id);
    const clean = normalizeEconomics(economics) ?? { costEstimate: null, salePriceEstimate: null, shippingCost: null, returnCost: null };
    let local: ProductCandidate | null = null;
    if (clean.costEstimate !== null || clean.salePriceEstimate !== null) {
      local = this.ensureLocalCandidate(id, row, candidate);
      const facts: CandidateFactsInput = {};
      if (clean.costEstimate !== null) facts.unitCostEur = clean.costEstimate;
      if (clean.salePriceEstimate !== null) facts.pvpEur = clean.salePriceEstimate;
      this.hunter.setFacts(local.id, toHunterFacts(facts), "manual");
      local = this.hunter.score(local.id);
    }
    this.write({ ...candidate, economics: clean }, local?.id ?? row.product_candidate_id);
    return this.fromRow(this.row(id)!);
  }

  /** F3: hechos manuales completos (coste, PVP, peso, medidas) sobre un candidato guardado. */
  async setFacts(id: string, facts: CandidateFactsInput): Promise<WinningProductCandidate> {
    const { candidate, row } = this.mustGet(id);
    const local = this.ensureLocalCandidate(id, row, candidate);
    this.hunter.setFacts(local.id, toHunterFacts(facts), "manual");
    this.hunter.score(local.id);
    this.write(candidate, local.id);
    return this.fromRow(this.row(id)!);
  }

  async compare(ids: string[]): Promise<CandidateComparison> {
    const clean = assertCompareIds(ids);
    const candidates: WinningProductCandidate[] = [];
    for (const id of clean) {
      const c = await this.getCandidate(id);
      if (!c) throw new ProductHunterInputError(`no existe el candidato ${id}`, "NOT_FOUND");
      candidates.push(c);
    }
    return { ids: clean, candidates, comparedAt: nowIso() };
  }
}
