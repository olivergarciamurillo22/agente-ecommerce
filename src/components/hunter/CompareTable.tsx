"use client";

// Vista COMPARAR: tabla de 2–4 candidatos. El verde marca el mejor valor de
// cada fila; NO hay veredicto ni "recomendado": decide Pedro.

import { useEffect, useState } from "react";
import { Card, EmptyState, ErrorState, formatEuro, GhostButton, Skeleton } from "../ui";
import { bestIndexes, computeCandidateMargin, scoreLabel, signalValue, UNAVAILABLE_LABEL, type BestDirection } from "@/lib/product-hunter/scoring";
import {
  SATURATION_LABEL,
  SCORE_CONFIDENCE_LABEL,
  type CandidateComparison,
  type WinningProductCandidate,
} from "@/lib/product-hunter/types";
import { displayName } from "./CandidateCard";
import { CloseIcon, hunterGet, MAX_COMPARE } from "./hunter-shared";

interface Row {
  label: string;
  hint?: string;
  direction: BestDirection | null;
  cells: Array<{ text: string; value: number | null; title?: string }>;
}

const SAT_RANK = { low: 3, medium: 2, high: 1 } as const;
const CONF_RANK = { low: 1, medium: 2, high: 3 } as const;

function money(n: number | null): string {
  return n === null ? UNAVAILABLE_LABEL : formatEuro(n);
}

function buildRows(cs: WinningProductCandidate[]): Row[] {
  const margins = cs.map((c) =>
    c.economics ? computeCandidateMargin(c.economics) : { grossMargin: null, profitPerOrder: null, note: "" }
  );
  return [
    {
      label: "Precio detectado",
      hint: "En el anuncio o la landing",
      direction: null,
      cells: cs.map((c) => ({ text: c.detectedPrice ? formatEuro(c.detectedPrice.amount) : UNAVAILABLE_LABEL, value: c.detectedPrice?.amount ?? null })),
    },
    {
      label: "Precio venta est.",
      hint: "Tu supuesto",
      direction: "max",
      cells: cs.map((c) => ({ text: money(c.economics?.salePriceEstimate ?? null), value: c.economics?.salePriceEstimate ?? null })),
    },
    {
      label: "Coste est.",
      hint: "Tu supuesto",
      direction: "min",
      cells: cs.map((c) => ({ text: money(c.economics?.costEstimate ?? null), value: c.economics?.costEstimate ?? null })),
    },
    {
      label: "Margen bruto",
      hint: "precio − coste − transporte",
      direction: "max",
      cells: margins.map((m) => ({ text: money(m.grossMargin), value: m.grossMargin })),
    },
    {
      label: "Beneficio / pedido",
      hint: "Con entrega al 70 %",
      direction: "max",
      cells: margins.map((m) => ({ text: money(m.profitPerOrder), value: m.profitPerOrder })),
    },
    {
      label: "Días activos",
      direction: "max",
      cells: cs.map((c) => ({ text: c.activeDays === null ? UNAVAILABLE_LABEL : String(c.activeDays), value: c.activeDays })),
    },
    {
      label: "Variaciones",
      direction: "max",
      cells: cs.map((c) => ({ text: c.variations === null ? UNAVAILABLE_LABEL : String(c.variations), value: c.variations })),
    },
    {
      label: "Países",
      direction: "max",
      cells: cs.map((c) => ({ text: c.countries.length ? c.countries.join(" · ") : UNAVAILABLE_LABEL, value: c.countries.length || null })),
    },
    {
      label: "Saturación",
      hint: "Menos es mejor",
      direction: "max",
      cells: cs.map((c) => ({ text: c.saturation ? SATURATION_LABEL[c.saturation] : UNAVAILABLE_LABEL, value: c.saturation ? SAT_RANK[c.saturation] : null })),
    },
    {
      label: "Riesgo logístico",
      hint: "Riesgos registrados",
      direction: "min",
      cells: cs.map((c) => ({
        text: c.risks.length === 0 ? "Sin riesgos registrados" : `${c.risks.length} riesgo${c.risks.length === 1 ? "" : "s"}`,
        value: c.risks.length,
        title: c.risks.join("\n") || undefined,
      })),
    },
    {
      label: "Encaje COD",
      hint: "Señal cod_fit",
      direction: "max",
      cells: cs.map((c) => {
        const v = signalValue(c.winnerScore, "cod_fit");
        return { text: v === null ? "sin dato" : String(Math.round(v)), value: v };
      }),
    },
    {
      label: "Winner Score",
      direction: "max",
      cells: cs.map((c) => {
        const l = scoreLabel(c.winnerScore);
        return { text: l.pending ? "Pendiente" : l.text, value: l.pending ? null : (c.winnerScore?.total ?? null) };
      }),
    },
    {
      label: "Confianza",
      direction: "max",
      cells: cs.map((c) => {
        const conf = c.winnerScore?.confidence ?? null;
        return { text: conf ? SCORE_CONFIDENCE_LABEL[conf] : UNAVAILABLE_LABEL, value: conf ? CONF_RANK[conf] : null };
      }),
    },
  ];
}

export default function CompareTable({
  ids,
  onRemove,
  onClear,
  onOpenDetail,
}: {
  ids: string[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onOpenDetail: (candidate: WinningProductCandidate) => void;
}) {
  const [data, setData] = useState<WinningProductCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const key = ids.join(",");

  useEffect(() => {
    if (ids.length < 2) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void hunterGet<CandidateComparison>("compare", { ids: key }).then((r) => {
      if (cancelled) return;
      if (r.ok) setData(r.candidates);
      else setError(r.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // `key` resume `ids`; `reload` fuerza el reintento tras un error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  if (ids.length < 2) {
    return (
      <Card>
        <EmptyState
          title="Selecciona al menos 2 productos para comparar"
          hint={`Marca "Comparar" en las tarjetas de Buscar o Guardados (máximo ${MAX_COMPARE}).${ids.length === 1 ? " Llevas 1." : ""}`}
        />
        {ids.length === 1 ? (
          <div className="flex justify-center pb-8 -mt-6">
            <GhostButton onClick={onClear}>Quitar la selección</GhostButton>
          </div>
        ) : null}
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />
      </Card>
    );
  }

  if (loading || !data) {
    return (
      <Card className="p-5 space-y-3" aria-busy>
        <Skeleton className="h-6 w-1/2" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </Card>
    );
  }

  const rows = buildRows(data);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-brand-muted">
        <span>
          {data.length} de {MAX_COMPARE} · el <span className="text-emerald-600 font-medium">verde</span> marca el mejor valor de cada fila. No es una recomendación.
        </span>
        <GhostButton onClick={onClear}>Vaciar</GhostButton>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-sm border-collapse">
            <thead>
              <tr className="border-b border-brand-border/60">
                <th scope="col" className="sticky left-0 bg-brand-surface px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-brand-muted w-44">
                  Criterio
                </th>
                {data.map((c) => (
                  <th key={c.id} scope="col" className="px-4 py-3 text-left align-top font-normal">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenDetail(c)}
                        className={`text-left text-sm font-semibold leading-snug line-clamp-2 hover:text-brand-gold transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 rounded ${c.productName ? "text-brand-text" : "text-brand-muted italic"}`}
                      >
                        {displayName(c)}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(c.id)}
                        aria-label={`Quitar ${displayName(c)} de la comparación`}
                        className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-muted/60 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
                      >
                        <CloseIcon />
                      </button>
                    </div>
                    <div className="mt-0.5 text-[11px] text-brand-muted truncate">{c.advertiser ?? `Anunciante ${UNAVAILABLE_LABEL.toLowerCase()}`}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-border/60">
              {rows.map((row) => {
                const best = row.direction ? new Set(bestIndexes(row.cells.map((c) => c.value), row.direction)) : new Set<number>();
                return (
                  <tr key={row.label}>
                    <th scope="row" className="sticky left-0 bg-brand-surface px-4 py-2.5 text-left font-normal align-top">
                      <div className="text-sm text-brand-text">{row.label}</div>
                      {row.hint ? <div className="text-[11px] text-brand-muted">{row.hint}</div> : null}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td
                        key={i}
                        title={cell.title}
                        className={`px-4 py-2.5 align-top tabular-nums ${
                          best.has(i) ? "text-emerald-600 font-semibold" : cell.value === null ? "text-brand-muted" : "text-brand-text"
                        }`}
                      >
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
