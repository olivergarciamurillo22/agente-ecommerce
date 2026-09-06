"use client";

// ============================================================
// WINNER RADAR — HISTORIAL.
//
// Cada búsqueda guarda su prompt, sus filtros y su informe. Sin eso, un
// resultado de hace dos semanas no se puede interpretar: no se sabe qué se
// preguntó, así que tampoco qué significa que no saliera nada.
//
// La duración se enseña porque es lo que hace creíble el tiempo estimado de
// la SIGUIENTE búsqueda: sale de estas cifras, no de una corazonada.
// ============================================================

import type { SearchRun } from "@/lib/hunter/types";
import { formatDuration } from "@/lib/hunter/stages";
import { IconChevronRight, IconSearch } from "@/components/icons";
import { miles } from "./radar-shared";

const ESTADO: Record<SearchRun["state"], { label: string; clase: string }> = {
  queued: { label: "En cola", clase: "bg-brand-surface-2 text-brand-muted" },
  running: { label: "En curso", clase: "bg-blue-50 text-blue-800" },
  complete: { label: "Completa", clase: "bg-emerald-50 text-emerald-800" },
  partial: { label: "Parcial", clase: "bg-amber-50 text-amber-900" },
  failed: { label: "Falló", clase: "bg-red-50 text-red-800" },
};

export default function RadarHistory({
  runs,
  onOpen,
  onNewSearch,
}: {
  runs: SearchRun[];
  onOpen: (run: SearchRun) => void;
  onNewSearch: () => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[820px] px-4 md:px-6 py-16 text-center">
        <h2 className="text-[17px] font-semibold">Todavía no has hecho ninguna búsqueda</h2>
        <p className="mx-auto mt-2 max-w-[44ch] text-[13.5px] leading-relaxed text-brand-muted">
          Cuando lances la primera, aquí quedará guardada con su informe: podrás volver a abrirla tal y como salió.
        </p>
        <button
          type="button"
          onClick={onNewSearch}
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-gold px-5 h-11 text-[14px] font-semibold text-white hover:bg-brand-gold-soft transition-colors"
        >
          <IconSearch size={16} />
          Buscar oportunidades
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 md:px-8 py-8">
      <h1 className="text-[22px] font-semibold tracking-tight">Historial</h1>
      <p className="mt-1 text-[13px] text-brand-muted">
        Cada búsqueda se guarda con lo que preguntaste y lo que salió.
      </p>

      <ul className="mt-5 divide-y divide-brand-border rounded-xl border border-brand-border bg-brand-surface">
        {runs.map((r) => {
          const e = ESTADO[r.state] ?? ESTADO.queued;
          const fecha = new Date(r.startedAt * 1000);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r)}
                className="flex w-full items-center gap-4 px-4 py-3.5 text-left hover:bg-brand-surface-2 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium truncate">{r.title ?? "Búsqueda"}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[.06em] ${e.clase}`}>
                      {e.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-brand-tertiary truncate">
                    {r.report?.headline ?? r.prompt ?? r.plan?.sentence ?? "—"}
                  </p>
                </div>

                <dl className="hidden shrink-0 gap-5 text-right sm:flex">
                  <div>
                    <dd className="text-[14px] font-semibold tabular-nums">{miles(r.progress.opportunities)}</dd>
                    <dt className="text-[10px] uppercase tracking-[.06em] text-brand-tertiary">
                      {r.progress.opportunities === 1 ? "producto" : "productos"}
                    </dt>
                  </div>
                  <div>
                    <dd className="text-[14px] font-medium tabular-nums text-brand-muted">
                      {r.durationMs ? formatDuration(Math.round(r.durationMs / 1000)) : "—"}
                    </dd>
                    <dt className="text-[10px] uppercase tracking-[.06em] text-brand-tertiary">duró</dt>
                  </div>
                  <div>
                    <dd className="text-[13px] tabular-nums text-brand-muted">
                      {fecha.toLocaleDateString("es-ES", { day: "numeric", month: "short" })}
                    </dd>
                    <dt className="text-[10px] uppercase tracking-[.06em] text-brand-tertiary">
                      {fecha.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
                    </dt>
                  </div>
                </dl>

                <IconChevronRight size={16} className="shrink-0 text-brand-tertiary" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
