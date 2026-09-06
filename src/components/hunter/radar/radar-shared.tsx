"use client";

// Piezas visuales del AI Winner Radar. Reutilizan los tokens y las clases que
// ya usa el resto del panel: esto se integra en Casamable, no lo rediseña.
//
// La idea que gobierna estos componentes: LA PROCEDENCIA SE VE. Un número
// observado y uno inferido por IA no pueden pintarse igual, porque quien mira
// la pantalla decide con dinero de verdad.

import type { ReactNode } from "react";
import type { MetricProvenance } from "@/lib/hunter/provenance";
import type { OpportunityBadge, ScoreValue } from "@/lib/hunter/types";

export const UNKNOWN = "No disponible";

const PROVENANCE_STYLE: Record<MetricProvenance, { label: string; cls: string; title: string }> = {
  OBSERVED: { label: "observado", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", title: "Lo dice la fuente tal cual" },
  INTERNAL_REAL: { label: "dato propio", cls: "bg-sky-50 text-sky-700 border-sky-200", title: "Medido en pedidos reales de Casamable" },
  CALCULATED: { label: "calculado", cls: "bg-slate-50 text-slate-700 border-slate-200", title: "Fórmula determinista sobre datos conocidos" },
  PROVIDER_ESTIMATE: { label: "estimado por terceros", cls: "bg-amber-50 text-amber-700 border-amber-200", title: "Lo estima un proveedor externo: NO es un hecho" },
  AI_INFERENCE: { label: "inferido por IA", cls: "bg-violet-50 text-violet-700 border-violet-200", title: "Lo dedujo un modelo leyendo texto público" },
};

export function ProvenanceTag({ provenance }: { provenance: MetricProvenance }) {
  const s = PROVENANCE_STYLE[provenance];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${s.cls}`} title={s.title}>
      {s.label}
    </span>
  );
}

const BADGE_STYLE: Record<OpportunityBadge, { label: string; cls: string }> = {
  RISING: { label: "En alza", cls: "bg-emerald-100 text-emerald-800" },
  EARLY: { label: "Temprano", cls: "bg-sky-100 text-sky-800" },
  SATURATED: { label: "Saturado", cls: "bg-red-100 text-red-800" },
  EVERGREEN: { label: "Todo el año", cls: "bg-teal-100 text-teal-800" },
  HIGH_COD_FIT: { label: "Encaja con COD", cls: "bg-indigo-100 text-indigo-800" },
  HIGH_RETURN_RISK: { label: "Riesgo devolución", cls: "bg-orange-100 text-orange-800" },
  INSUFFICIENT_DATA: { label: "Datos insuficientes", cls: "bg-neutral-200 text-neutral-700" },
};

export function Badge({ badge }: { badge: OpportunityBadge }) {
  const s = BADGE_STYLE[badge];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.cls}`}>{s.label}</span>;
}

/**
 * Score con su confianza SIEMPRE al lado. Nunca se pinta un número solo:
 * un 88 sin contexto es falsa precisión, y esa es la forma más silenciosa
 * de que alguien se gaste el presupuesto en la oportunidad equivocada.
 */
export function ScoreChip({ label, value, size = "sm" }: { label: string; value: ScoreValue; size?: "sm" | "lg" }) {
  const grande = size === "lg";
  if (value.score === null) {
    return (
      <div className="rounded-lg border border-brand-line/60 px-3 py-2">
        <div className="text-[11px] text-brand-muted">{label}</div>
        <div className={`${grande ? "text-lg" : "text-sm"} font-semibold text-brand-muted`}>—</div>
        <div className="text-[10px] text-brand-muted">
          {value.unavailableReason === "INSUFFICIENT_HISTORY" ? "sin histórico todavía" : "sin datos suficientes"}
        </div>
      </div>
    );
  }
  const tono = value.score >= 70 ? "text-emerald-700" : value.score >= 45 ? "text-amber-700" : "text-neutral-700";
  return (
    <div className="rounded-lg border border-brand-line/60 px-3 py-2">
      <div className="text-[11px] text-brand-muted">{label}</div>
      <div className={`${grande ? "text-2xl" : "text-lg"} font-semibold ${tono}`}>{value.score}</div>
      <div className="text-[10px] text-brand-muted">confianza {Math.round(value.confidence * 100)} %</div>
    </div>
  );
}

/** Cartel imposible de pasar por alto cuando los datos son de mentira. */
export function FixtureBanner() {
  return (
    <div className="mb-4 rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3">
      <div className="text-[13px] font-semibold text-amber-900">FUENTE DE DATOS: EJEMPLO</div>
      <p className="mt-0.5 text-[12px] text-amber-800">
        Todo lo que ves está inventado para poder probar la herramienta. No sirve para decidir nada.
      </p>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] text-brand-muted">{label}</div>
      <div className="text-[13px] font-medium">{value}</div>
      {hint && <div className="text-[10px] text-brand-muted">{hint}</div>}
    </div>
  );
}

export function money(n: number | null, currency = "EUR"): string {
  if (n === null || !Number.isFinite(n)) return UNKNOWN;
  return `${n.toFixed(2)} ${currency === "EUR" ? "€" : currency}`;
}

export function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return UNKNOWN;
  return `${Math.round(n * 100)} %`;
}
