"use client";

// Vista BUSCAR: buscador + filtros rápidos + drawer de filtros avanzados +
// rejilla de resultados. La búsqueda no se lanza sola: Pedro decide qué buscar.

import { useCallback, useState } from "react";
import { Card, Chip, EmptyState, ErrorState, GhostButton, PrimaryButton, Skeleton } from "../ui";
import {
  AD_LIBRARY_SORT_LABEL,
  COUNTRY_OPTIONS,
  type AdLibraryResult,
  type AdLibrarySearchPage,
  type AdLibrarySort,
  type AdPlatformFilter,
  type CreativeFormatFilter,
  type ProductResearchStatus,
  type WinningProductCandidate,
} from "@/lib/product-hunter/types";
import CandidateCard from "./CandidateCard";
import {
  Drawer,
  Field,
  FilterIcon,
  hunterGet,
  hunterPost,
  INPUT_CLASS,
  MAX_COMPARE,
  SearchIcon,
  SELECT_CLASS,
  SELECT_COMPACT_CLASS,
} from "./hunter-shared";

interface SearchForm {
  keywords: string;
  country: string;
  activeOnly: boolean;
  format: CreativeFormatFilter;
  minActiveDays: string;
  sort: AdLibrarySort;
  category: string;
  platform: AdPlatformFilter;
  startedAfter: string;
}

const DEFAULT_FORM: SearchForm = {
  keywords: "",
  country: "ES",
  activeOnly: false,
  format: "all",
  minActiveDays: "",
  sort: "relevance",
  category: "",
  platform: "all",
  startedAfter: "",
};

const EXAMPLES = ["cocina", "mascotas", "bienestar", "hogar"];
const PAGE_SIZE = 12;

function toQuery(f: SearchForm, page: number): Record<string, string | number | boolean | undefined> {
  const min = f.minActiveDays.trim() === "" ? undefined : Math.max(0, parseInt(f.minActiveDays, 10) || 0);
  return {
    keywords: f.keywords.trim(),
    country: f.country,
    activeOnly: f.activeOnly || undefined,
    creativeFormat: f.format === "all" ? undefined : f.format,
    minActiveDays: min,
    sort: f.sort,
    category: f.category.trim() || undefined,
    platform: f.platform === "all" ? undefined : f.platform,
    startedAfter: f.startedAfter || undefined,
    page,
    pageSize: PAGE_SIZE,
  };
}

function advancedCount(f: SearchForm): number {
  let n = 0;
  if (f.category.trim()) n++;
  if (f.platform !== "all") n++;
  if (f.startedAfter) n++;
  return n;
}

function SkeletonCard() {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-video w-full animate-pulse bg-brand-surface-2" aria-hidden />
      <div className="p-4 space-y-2.5">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-9 w-full mt-3" />
      </div>
    </Card>
  );
}

export default function SearchView({
  savedMap,
  compareIds,
  onToggleCompare,
  onOpenDetail,
  onSaved,
  onNotice,
}: {
  savedMap: Record<string, ProductResearchStatus>;
  compareIds: string[];
  onToggleCompare: (id: string) => void;
  onOpenDetail: (result: AdLibraryResult) => void;
  onSaved: (candidate: WinningProductCandidate) => void;
  onNotice: (text: string, tone: "ok" | "error" | "info") => void;
}) {
  const [form, setForm] = useState<SearchForm>(DEFAULT_FORM);
  const [applied, setApplied] = useState<SearchForm | null>(null);
  const [results, setResults] = useState<AdLibraryResult[] | null>(null);
  const [pageInfo, setPageInfo] = useState<{ page: number; hasMore: boolean; total: number | null }>({ page: 1, hasMore: false, total: null });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<SearchForm>(DEFAULT_FORM);
  const [savingId, setSavingId] = useState<string | null>(null);

  const runSearch = useCallback(async (f: SearchForm) => {
    setLoading(true);
    setError(null);
    setApplied(f);
    const r = await hunterGet<AdLibrarySearchPage>("search", toQuery(f, 1));
    if (r.ok) {
      setResults(r.results);
      setPageInfo({ page: r.page, hasMore: r.hasMore, total: r.total });
    } else {
      setError(r.error);
    }
    setLoading(false);
  }, []);

  const loadMore = useCallback(async () => {
    if (!applied || !pageInfo.hasMore || loadingMore) return;
    setLoadingMore(true);
    const next = pageInfo.page + 1;
    const r = await hunterGet<AdLibrarySearchPage>("search", toQuery(applied, next));
    if (r.ok) {
      setResults((prev) => {
        const seen = new Set((prev ?? []).map((x) => x.id));
        return [...(prev ?? []), ...r.results.filter((x) => !seen.has(x.id))];
      });
      setPageInfo({ page: r.page, hasMore: r.hasMore, total: r.total });
    } else {
      onNotice(r.error, "error");
    }
    setLoadingMore(false);
  }, [applied, pageInfo, loadingMore, onNotice]);

  /** Cambia un filtro rápido y relanza la búsqueda si ya había una. */
  const quick = (patch: Partial<SearchForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (applied) void runSearch(next);
  };

  const submit = () => void runSearch(form);

  const openFilters = () => {
    setDraft(form);
    setFiltersOpen(true);
  };

  const applyFilters = () => {
    setFiltersOpen(false);
    setForm(draft);
    void runSearch(draft);
  };

  const save = async (result: AdLibraryResult) => {
    setSavingId(result.id);
    const r = await hunterPost<{ candidate: WinningProductCandidate }>({ op: "save", result });
    if (r.ok) {
      onSaved(r.candidate);
      onNotice(`Guardado en el pipeline: ${result.productName ?? "producto sin identificar"}.`, "ok");
    } else {
      onNotice(r.error, "error");
    }
    setSavingId(null);
  };

  const compareFull = compareIds.length >= MAX_COMPARE;
  const nAdvanced = advancedCount(form);

  return (
    <div className="space-y-5">
      {/* ── Buscador ── */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col md:flex-row gap-2"
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })}
            placeholder="Producto, categoría o beneficio…"
            aria-label="Palabras clave"
            autoComplete="off"
            className={`${INPUT_CLASS} pl-9`}
          />
        </div>
        <select
          value={form.country}
          onChange={(e) => quick({ country: e.target.value })}
          aria-label="País"
          className={`${SELECT_CLASS} md:w-44`}
        >
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
        <PrimaryButton onClick={submit} busy={loading} className="min-h-11 md:min-h-0 md:px-6">
          Buscar
        </PrimaryButton>
      </form>

      {/* ── Filtros rápidos + orden + filtros avanzados ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={form.activeOnly} onClick={() => quick({ activeOnly: !form.activeOnly })}>
          Solo activos
        </Chip>
        <Chip active={form.format === "video"} onClick={() => quick({ format: form.format === "video" ? "all" : "video" })}>
          Vídeo
        </Chip>
        <Chip active={form.format === "image"} onClick={() => quick({ format: form.format === "image" ? "all" : "image" })}>
          Imagen
        </Chip>
        <Chip active={form.minActiveDays === "30"} onClick={() => quick({ minActiveDays: form.minActiveDays === "30" ? "" : "30" })}>
          ≥ 30 días activo
        </Chip>
        <span className="ml-auto flex items-center gap-2">
          <select
            value={form.sort}
            onChange={(e) => quick({ sort: e.target.value as AdLibrarySort })}
            aria-label="Ordenar por"
            className={SELECT_COMPACT_CLASS}
          >
            {(Object.keys(AD_LIBRARY_SORT_LABEL) as AdLibrarySort[]).map((s) => (
              <option key={s} value={s}>
                {AD_LIBRARY_SORT_LABEL[s]}
              </option>
            ))}
          </select>
          <GhostButton onClick={openFilters}>
            <FilterIcon />
            Filtros
            {nAdvanced > 0 ? <span className="rounded-full bg-brand-gold/15 px-1.5 text-[10px] font-semibold text-brand-gold">{nAdvanced}</span> : null}
          </GhostButton>
        </span>
      </div>

      {/* ── Resultados ── */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" aria-busy>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : error ? (
        <Card>
          <ErrorState message={error} onRetry={() => applied && runSearch(applied)} />
        </Card>
      ) : results === null ? (
        <Card>
          <EmptyState
            title="Escribe qué buscas y pulsa Buscar"
            hint="Consulta la Biblioteca de anuncios de Meta por país. Los resultados llegan con lo que la fuente sabe; lo que no sabe se marca como no disponible."
          />
          <div className="flex flex-wrap justify-center gap-2 pb-8 -mt-6">
            {EXAMPLES.map((k) => (
              <Chip
                key={k}
                onClick={() => {
                  const next = { ...form, keywords: k };
                  setForm(next);
                  void runSearch(next);
                }}
              >
                {k}
              </Chip>
            ))}
          </div>
        </Card>
      ) : results.length === 0 ? (
        <Card>
          <EmptyState
            title="Sin resultados para esa búsqueda"
            hint="Prueba con menos palabras, otro país o quita los filtros rápidos."
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs text-brand-muted">
            <span>
              {pageInfo.total !== null ? `${pageInfo.total} resultado${pageInfo.total === 1 ? "" : "s"}` : `${results.length} resultado${results.length === 1 ? "" : "s"}`}
              {applied ? ` · ${COUNTRY_OPTIONS.find((c) => c.code === applied.country)?.label ?? applied.country}` : ""}
            </span>
            {compareIds.length > 0 ? <span>{compareIds.length}/{MAX_COMPARE} en comparación</span> : null}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {results.map((r) => (
              <CandidateCard
                key={r.id}
                result={r}
                savedStatus={savedMap[r.id] ?? null}
                compared={compareIds.includes(r.id)}
                compareFull={compareFull}
                saving={savingId === r.id}
                onSave={() => void save(r)}
                onToggleCompare={() => onToggleCompare(r.id)}
                onOpenDetail={() => onOpenDetail(r)}
              />
            ))}
          </div>
          {pageInfo.hasMore ? (
            <div className="flex justify-center pt-2">
              <GhostButton onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Cargando…" : "Cargar más"}
              </GhostButton>
            </div>
          ) : null}
        </>
      )}

      {/* ── Drawer de filtros avanzados ── */}
      <Drawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filtros"
        subtitle="Acotan la consulta a la Biblioteca de anuncios."
        widthClass="md:w-[420px]"
        mobile="sheet"
        footer={
          <div className="flex items-center justify-between gap-2">
            <GhostButton onClick={() => setDraft({ ...DEFAULT_FORM, keywords: draft.keywords, country: draft.country, sort: draft.sort })}>Limpiar</GhostButton>
            <PrimaryButton onClick={applyFilters}>Aplicar filtros</PrimaryButton>
          </div>
        }
      >
        <div className="px-5 py-4 space-y-4">
          <Field label="Categoría" hint="Texto libre; el backend decide cómo lo interpreta.">
            <input type="text" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className={INPUT_CLASS} placeholder="p. ej. hogar, mascotas" />
          </Field>
          <Field label="Plataforma">
            <select value={draft.platform} onChange={(e) => setDraft({ ...draft, platform: e.target.value as AdPlatformFilter })} className={SELECT_CLASS}>
              <option value="all">Facebook e Instagram</option>
              <option value="facebook">Solo Facebook</option>
              <option value="instagram">Solo Instagram</option>
            </select>
          </Field>
          <Field label="Formato de creatividad">
            <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as CreativeFormatFilter })} className={SELECT_CLASS}>
              <option value="all">Todos</option>
              <option value="video">Vídeo</option>
              <option value="image">Imagen</option>
              <option value="carousel">Carrusel</option>
            </select>
          </Field>
          <Field label="Empezó después de">
            <input type="date" value={draft.startedAfter} onChange={(e) => setDraft({ ...draft, startedAfter: e.target.value })} className={INPUT_CLASS} />
          </Field>
          <Field label="Mínimo de días activo" hint="Los anuncios que llevan más tiempo suelen estar funcionando.">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={3650}
              value={draft.minActiveDays}
              onChange={(e) => setDraft({ ...draft, minActiveDays: e.target.value })}
              className={INPUT_CLASS}
              placeholder="p. ej. 30"
            />
          </Field>
          <Field label="Solo activos">
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-brand-border px-3 text-sm text-brand-text">
              <input type="checkbox" checked={draft.activeOnly} onChange={(e) => setDraft({ ...draft, activeOnly: e.target.checked })} className="h-4 w-4 accent-brand-gold" />
              Excluir anuncios ya pausados
            </label>
          </Field>
        </div>
      </Drawer>
    </div>
  );
}
