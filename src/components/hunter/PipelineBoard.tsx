"use client";

// Vista GUARDADOS: tablero por etapa. En escritorio, columnas con scroll
// horizontal; en móvil, selector de etapa + lista. "Mover a…" es un select
// inline: sin drag & drop, sin dependencias.

import { useCallback, useEffect, useState } from "react";
import { Card, Chip, EmptyState, ErrorState, GhostButton, Skeleton } from "../ui";
import { UNAVAILABLE_LABEL } from "@/lib/product-hunter/scoring";
import {
  PRODUCT_RESEARCH_STATUS_LABEL,
  PRODUCT_RESEARCH_STATUSES,
  type ProductResearchStatus,
  type SaturationLevel,
  type SavedCandidate,
  type WinningProductCandidate,
} from "@/lib/product-hunter/types";
import { displayName, ToggleButton } from "./CandidateCard";
import { CountryChips, formatPrice, hunterGet, hunterPost, MAX_COMPARE, SaturationPill, ScoreMini, SELECT_CLASS, SELECT_COMPACT_CLASS } from "./hunter-shared";

const COLUMNS = PRODUCT_RESEARCH_STATUSES.filter((s) => s !== "discovered");
const MIN_SCORES = [40, 60, 80] as const;
const SATURATIONS: SaturationLevel[] = ["low", "medium", "high"];
const SATURATION_SHORT: Record<SaturationLevel, string> = { low: "Sat. baja", medium: "Sat. media", high: "Sat. alta" };

function CompactCard({
  c,
  compared,
  compareFull,
  moving,
  onMove,
  onOpenDetail,
  onToggleCompare,
}: {
  c: SavedCandidate;
  compared: boolean;
  compareFull: boolean;
  moving: boolean;
  onMove: (to: ProductResearchStatus) => void;
  onOpenDetail: () => void;
  onToggleCompare: () => void;
}) {
  return (
    <Card className="p-3.5 space-y-2.5">
      <button
        type="button"
        onClick={onOpenDetail}
        className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 rounded-lg"
      >
        <div className="flex items-start justify-between gap-2">
          <div className={`text-sm font-semibold leading-snug line-clamp-2 ${c.productName ? "text-brand-text" : "text-brand-muted italic"}`}>{displayName(c)}</div>
          <ScoreMini score={c.winnerScore} />
        </div>
        <div className="mt-0.5 text-xs text-brand-muted truncate">{c.advertiser ?? `Anunciante ${UNAVAILABLE_LABEL.toLowerCase()}`}</div>
      </button>
      <div className="flex flex-wrap items-center gap-1.5">
        <CountryChips countries={c.countries} />
        {c.saturation ? <SaturationPill level={c.saturation} /> : null}
      </div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-brand-muted">Precio detectado</span>
        <span className={`tabular-nums ${c.detectedPrice ? "text-brand-text font-medium" : "text-brand-muted"}`}>{formatPrice(c.detectedPrice)}</span>
      </div>
      <div className="pt-2 border-t border-brand-border/60 flex items-center gap-2">
        <select
          value=""
          disabled={moving}
          onChange={(e) => {
            const to = e.target.value as ProductResearchStatus | "";
            if (to) onMove(to);
          }}
          aria-label={`Mover ${displayName(c)} a otra etapa`}
          className={`${SELECT_COMPACT_CLASS} flex-1`}
        >
          <option value="">{moving ? "Moviendo…" : "Mover a…"}</option>
          {COLUMNS.filter((s) => s !== c.status).map((s) => (
            <option key={s} value={s}>
              {PRODUCT_RESEARCH_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <ToggleButton active={compared} disabled={!compared && compareFull} onClick={onToggleCompare} size="sm">
          {compared ? "Comp." : "Comparar"}
        </ToggleButton>
      </div>
    </Card>
  );
}

export default function PipelineBoard({
  refreshKey,
  compareIds,
  onToggleCompare,
  onOpenDetail,
  onChanged,
  onNotice,
}: {
  refreshKey: number;
  compareIds: string[];
  onToggleCompare: (id: string) => void;
  onOpenDetail: (candidate: WinningProductCandidate) => void;
  onChanged: (candidate: WinningProductCandidate) => void;
  onNotice: (text: string, tone: "ok" | "error" | "info") => void;
}) {
  const [candidates, setCandidates] = useState<SavedCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minScore, setMinScore] = useState<number | null>(null);
  const [saturation, setSaturation] = useState<SaturationLevel | null>(null);
  const [mobileStatus, setMobileStatus] = useState<ProductResearchStatus | "all">("all");
  const [movingId, setMovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const r = await hunterGet<{ candidates: SavedCandidate[] }>("candidates", {
      minScore: minScore ?? undefined,
      saturation: saturation ?? undefined,
    });
    if (r.ok) setCandidates(r.candidates);
    else setError(r.error);
  }, [minScore, saturation]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const move = async (c: SavedCandidate, to: ProductResearchStatus) => {
    setMovingId(c.id);
    const r = await hunterPost<{ candidate: WinningProductCandidate }>({ op: "move", id: c.id, status: to, note: null });
    if (r.ok) {
      const updated = r.candidate;
      if (updated.savedAt !== null) {
        const saved: SavedCandidate = { ...updated, savedAt: updated.savedAt };
        setCandidates((prev) => (prev ?? []).map((x) => (x.id === c.id ? saved : x)));
      }
      onChanged(updated);
      onNotice(`${displayName(c)} → ${PRODUCT_RESEARCH_STATUS_LABEL[to]}.`, "ok");
    } else {
      onNotice(r.error, "error");
    }
    setMovingId(null);
  };

  const compareFull = compareIds.length >= MAX_COMPARE;
  const byStatus = (s: ProductResearchStatus) => (candidates ?? []).filter((c) => c.status === s);
  const filtersActive = minScore !== null || saturation !== null;

  const cardFor = (c: SavedCandidate) => (
    <CompactCard
      key={c.id}
      c={c}
      compared={compareIds.includes(c.id)}
      compareFull={compareFull}
      moving={movingId === c.id}
      onMove={(to) => void move(c, to)}
      onOpenDetail={() => onOpenDetail(c)}
      onToggleCompare={() => onToggleCompare(c.id)}
    />
  );

  return (
    <div className="space-y-4">
      {/* ── Filtros ── */}
      <div className="flex flex-wrap items-center gap-2">
        {MIN_SCORES.map((n) => (
          <Chip key={n} active={minScore === n} onClick={() => setMinScore(minScore === n ? null : n)}>
            Score ≥ {n}
          </Chip>
        ))}
        <span className="hidden sm:inline-block h-4 w-px bg-brand-border mx-1" aria-hidden />
        {SATURATIONS.map((s) => (
          <Chip key={s} active={saturation === s} onClick={() => setSaturation(saturation === s ? null : s)}>
            {SATURATION_SHORT[s]}
          </Chip>
        ))}
        {filtersActive ? (
          <GhostButton
            onClick={() => {
              setMinScore(null);
              setSaturation(null);
            }}
            className="ml-auto"
          >
            Quitar filtros
          </GhostButton>
        ) : null}
      </div>

      {error ? (
        <Card>
          <ErrorState message={error} onRetry={() => void load()} />
        </Card>
      ) : candidates === null ? (
        <div className="flex gap-4 overflow-hidden" aria-busy>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="w-full md:w-72 shrink-0 space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-36 w-full" />
              <Skeleton className="h-36 w-full" />
            </div>
          ))}
        </div>
      ) : candidates.length === 0 ? (
        <Card>
          <EmptyState
            title={filtersActive ? "Nada coincide con esos filtros" : "Aún no has guardado ningún producto"}
            hint={filtersActive ? "Quita algún filtro para ver el resto del pipeline." : "Guarda resultados desde Buscar y aparecerán aquí, ordenados por etapa."}
          />
        </Card>
      ) : (
        <>
          {/* ── Escritorio: columnas ── */}
          <div className="hidden md:flex gap-4 overflow-x-auto pb-3 -mx-1 px-1 snap-x">
            {COLUMNS.map((s) => {
              const items = byStatus(s);
              return (
                <section key={s} className="w-72 shrink-0 snap-start" aria-label={PRODUCT_RESEARCH_STATUS_LABEL[s]}>
                  <header className="flex items-center justify-between px-1 pb-2">
                    <h3 className="text-[11px] font-semibold tracking-[0.18em] uppercase text-brand-muted">{PRODUCT_RESEARCH_STATUS_LABEL[s]}</h3>
                    <span className="text-[11px] tabular-nums text-brand-muted">{items.length}</span>
                  </header>
                  {items.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-brand-border px-3 py-6 text-center text-xs text-brand-muted">Nada aquí</div>
                  ) : (
                    <div className="space-y-2.5">{items.map(cardFor)}</div>
                  )}
                </section>
              );
            })}
          </div>

          {/* ── Móvil: selector + lista ── */}
          <div className="md:hidden space-y-3">
            <select value={mobileStatus} onChange={(e) => setMobileStatus(e.target.value as ProductResearchStatus | "all")} aria-label="Etapa" className={SELECT_CLASS}>
              <option value="all">Todas las etapas ({candidates.length})</option>
              {COLUMNS.map((s) => (
                <option key={s} value={s}>
                  {PRODUCT_RESEARCH_STATUS_LABEL[s]} ({byStatus(s).length})
                </option>
              ))}
            </select>
            {(mobileStatus === "all" ? candidates : byStatus(mobileStatus)).length === 0 ? (
              <Card>
                <EmptyState title="Nada en esta etapa" />
              </Card>
            ) : (
              <div className="space-y-2.5">
                {(mobileStatus === "all" ? candidates : byStatus(mobileStatus)).map((c) => (
                  <div key={c.id}>
                    {mobileStatus === "all" ? (
                      <div className="px-1 pb-1 text-[12px] font-medium text-brand-muted">{PRODUCT_RESEARCH_STATUS_LABEL[c.status]}</div>
                    ) : null}
                    {cardFor(c)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
