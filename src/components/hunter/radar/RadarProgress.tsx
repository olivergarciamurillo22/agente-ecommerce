"use client";

// ============================================================
// WINNER RADAR — LA BÚSQUEDA TRABAJANDO.
//
// Una búsqueda tarda minutos. Con un spinner, tres minutos se leen como «se
// ha colgado», y la reacción normal es recargar: eso tira el trabajo y vuelve
// a gastar cuota de Meta.
//
// Así que se enseña QUÉ está haciendo, CUÁNTO lleva y QUÉ ha encontrado ya.
// Los contadores son reales (anuncios revisados, páginas detectadas), no una
// animación decorativa: si el número no se mueve, es que de verdad no se
// está moviendo, y eso también es información.
//
// Y se puede MINIMIZAR. La búsqueda corre en el servidor, así que irse a otra
// pantalla no la cancela — obligar a mirar una barra durante tres minutos
// sería obligar a no trabajar.
// ============================================================

import type { SearchRun } from "@/lib/hunter/types";
import { formatDuration } from "@/lib/hunter/stages";
import { IconCheck, IconClose, IconWarning } from "@/components/icons";
import { miles } from "./radar-shared";

export interface LiveRun extends SearchRun {
  progressRatio?: number;
  remainingSeconds?: number | null;
}

export default function RadarProgress({
  run,
  onMinimize,
  onCancelView,
}: {
  run: LiveRun;
  onMinimize: () => void;
  onCancelView: () => void;
}) {
  const avance = Math.round((run.progressRatio ?? 0) * 100);
  const restan = run.remainingSeconds ?? null;
  // Sin histórico no se promete un segundero: la horquilla es lo honesto.
  const sinHistorico = run.estimateSeconds !== null && run.durationMs === null && restan === null;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4 md:px-6 pt-10 pb-16 md:pt-14">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] md:text-[26px] font-semibold tracking-tight">Buscando oportunidades para ti</h1>
          <p className="mt-1 text-[13px] text-brand-muted">
            {run.title ?? "Búsqueda en curso"}
            {run.plan?.sentence ? ` · ${run.plan.sentence}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancelView}
          aria-label="Cerrar esta vista"
          className="shrink-0 rounded-lg p-2 text-brand-tertiary hover:bg-brand-surface-2 hover:text-brand-text transition-colors"
        >
          <IconClose size={18} />
        </button>
      </div>

      {/* Tiempo */}
      <div className="mt-6 flex items-baseline gap-3">
        <span className="text-[34px] leading-none font-semibold tabular-nums tracking-tight">
          {restan !== null && restan > 0
            ? formatDuration(restan)
            : sinHistorico
              ? "2–4 min"
              : run.state === "queued"
                ? "—"
                : "casi"}
        </span>
        <span className="text-[13px] text-brand-muted">
          {restan !== null && restan > 0
            ? "restantes aproximadamente"
            : sinHistorico
              ? "es lo que suele tardar"
              : "ya casi está"}
        </span>
      </div>

      <div className="mt-3 h-1.5 rounded-full bg-brand-surface-2 overflow-hidden" role="progressbar" aria-valuenow={avance} aria-valuemin={0} aria-valuemax={100}>
        <div
          className="h-full rounded-full bg-brand-gold transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(2, avance)}%` }}
        />
      </div>
      {run.currentMessage && (
        <p className="mt-2 text-[13px] text-brand-muted tabular-nums">{run.currentMessage}</p>
      )}

      {/* Etapas */}
      <ol className="mt-8 space-y-0.5">
        {run.stages.map((s) => {
          const activa = s.status === "active";
          const hecha = s.status === "complete";
          const fallada = s.status === "failed";
          const saltada = s.status === "skipped";
          return (
            <li
              key={s.key}
              className={`flex gap-3 rounded-xl px-3 py-3 transition-colors ${activa ? "bg-brand-surface-subtle" : ""}`}
            >
              <span className="mt-0.5 shrink-0">
                {hecha ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <IconCheck size={13} />
                  </span>
                ) : fallada ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-red-700">
                    <IconWarning size={13} />
                  </span>
                ) : activa ? (
                  <span className="flex h-5 w-5 items-center justify-center">
                    <span className="h-2.5 w-2.5 rounded-full bg-brand-gold brand-pulse" />
                  </span>
                ) : (
                  <span className="flex h-5 w-5 items-center justify-center">
                    <span className={`h-2 w-2 rounded-full ${saltada ? "bg-brand-surface-2" : "bg-brand-border-strong"}`} />
                  </span>
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={`text-[14px] ${activa ? "font-semibold" : hecha ? "font-medium" : "text-brand-tertiary"}`}
                  >
                    {s.label}
                  </span>
                  {s.startedAt !== null && s.completedAt !== null && (
                    <span className="shrink-0 text-[11px] tabular-nums text-brand-tertiary">
                      {formatDuration(s.completedAt - s.startedAt)}
                    </span>
                  )}
                </div>
                <p className={`mt-0.5 text-[12px] ${activa || hecha ? "text-brand-muted" : "text-brand-tertiary"}`}>
                  {s.summary ?? (activa ? s.hint : saltada ? "No hizo falta" : s.hint)}
                </p>
                {activa && Object.keys(s.counters).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums text-brand-muted">
                    {contadoresLegibles(s.counters).map(([k, v]) => (
                      <span key={k}>
                        <span className="font-medium">{miles(v)}</span> {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {run.progress.sourcesFailed.length > 0 && (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-[13px] font-semibold text-amber-900">Cobertura parcial</div>
          <p className="mt-0.5 text-[12px] text-amber-800">
            Alguna fuente no ha respondido. Seguimos con el resto: verás resultados, pero puede faltar mercado por ver.
          </p>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onMinimize}
          className="rounded-xl border border-brand-border bg-brand-surface px-4 h-11 text-[14px] font-medium hover:bg-brand-surface-2 transition-colors"
        >
          Seguir trabajando mientras tanto
        </button>
        <span className="text-[12px] text-brand-tertiary">
          La búsqueda sigue en el servidor. Te avisamos cuando esté.
        </span>
      </div>
    </div>
  );
}

/**
 * Los contadores viajan con nombre técnico. Aquí se traducen a lo que
 * significan; el que no se sepa traducir NO se enseña, porque «adsFound: 812»
 * en pantalla es peor que no enseñar nada.
 */
const CONTADOR_NOMBRE: Record<string, string> = {
  queries: "búsquedas preparadas",
  queriesDone: "búsquedas hechas",
  adsFound: "anuncios revisados",
  advertisers: "páginas detectadas",
  // `pages` no se traduce a propósito: significaba «páginas de la API», y
  // junto a «páginas detectadas» (que son páginas de Facebook) la misma
  // palabra decía dos cosas distintas en la misma línea.
  clusters: "productos distintos",
  duplicatesRemoved: "duplicados fuera",
  analyzed: "analizados",
  shortlist: "en la lista corta",
  kept: "pasan tus filtros",
  discarded: "descartados",
  topPicks: "destacados",
  watch: "para vigilar",
};

export function contadoresLegibles(counters: Record<string, number>): Array<[string, number]> {
  return Object.entries(counters)
    // Un contador a cero mientras la etapa corre se lee como «esto no está
    // funcionando». Aparece en cuanto tiene algo que contar.
    .filter(([k, v]) => k in CONTADOR_NOMBRE && v > 0)
    .map(([k, v]) => [CONTADOR_NOMBRE[k], v] as [string, number]);
}
