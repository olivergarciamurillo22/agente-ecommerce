"use client";

// ============================================================
// WINNER RADAR — LENGUAJE VISUAL DEL MÓDULO.
//
// Tres decisiones que gobiernan todo lo que se ve aquí:
//
// 1. UN NÚMERO NO ES UNA RESPUESTA. Un «87» no dice qué hacer. Por eso el
//    verbo (TESTEAR · VIGILAR · DESCARTAR) va primero y el score al lado,
//    nunca al revés.
//
// 2. CADA DATO DICE DE DÓNDE SALE. Observado, estimado por un proveedor,
//    calculado por nosotros o inferido por IA no son la misma cosa, y
//    mezclarlos en la misma tipografía es como se toman decisiones malas con
//    aire de rigor.
//
// 3. NADA DE MEDIDORES REDONDOS. Diez agujas no informan: decoran. Barras
//    sobrias con su etiqueta y su valor, que se leen de un vistazo y se
//    comparan entre productos sin tener que interpretar ángulos.
// ============================================================

import type { ReactNode } from "react";
import type { MetricProvenance } from "@/lib/hunter/provenance";
import type { OpportunityBadge, Recommendation, ScoreValue } from "@/lib/hunter/types";
import { BADGE_LABEL } from "@/lib/hunter/types";

export const UNKNOWN = "No disponible";

// ------------------------------------------------------------
// Veredicto
// ------------------------------------------------------------

const VERDICT_STYLE: Record<Recommendation, { chip: string; dot: string; label: string }> = {
  TESTEAR: { chip: "bg-emerald-50 text-emerald-800 ring-emerald-600/20", dot: "bg-emerald-500", label: "Testear" },
  VIGILAR: { chip: "bg-amber-50 text-amber-900 ring-amber-600/20", dot: "bg-amber-500", label: "Vigilar" },
  DESCARTAR: { chip: "bg-neutral-100 text-neutral-600 ring-neutral-500/20", dot: "bg-neutral-400", label: "Descartar" },
};

export function VerdictChip({ verdict, size = "sm" }: { verdict: Recommendation | null; size?: "sm" | "lg" }) {
  if (!verdict) return null;
  const s = VERDICT_STYLE[verdict];
  const grande = size === "lg";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ring-1 ring-inset font-semibold uppercase ${s.chip} ${
        grande ? "px-3 py-1 text-[12px] tracking-[.10em]" : "px-2.5 py-0.5 text-[11px] tracking-[.08em]"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

// ------------------------------------------------------------
// Score
// ------------------------------------------------------------

/**
 * El número grande. Va SIEMPRE con su confianza al lado: un 88 con 42 % de
 * confianza es información honesta; un 88 a secas es falsa precisión.
 */
export function ScoreBig({ value, label = "Oportunidad" }: { value: ScoreValue; label?: string }) {
  const n = value.score;
  return (
    <div className="flex items-baseline gap-2">
      <div className="flex items-baseline">
        <span className="text-[40px] leading-none font-semibold tabular-nums tracking-tight">
          {n === null ? "—" : Math.round(n)}
        </span>
        {n !== null && <span className="text-[15px] text-brand-tertiary ml-0.5">/100</span>}
      </div>
      <div className="text-[11px] leading-tight text-brand-tertiary">
        <div className="uppercase tracking-[.10em]">{label}</div>
        <div>{n === null ? motivoCorto(value.unavailableReason) : `${Math.round(value.confidence * 100)} % de confianza`}</div>
      </div>
    </div>
  );
}

function motivoCorto(reason: string | null): string {
  if (reason === "INSUFFICIENT_DATA") return "sin datos suficientes";
  if (reason === "INSUFFICIENT_HISTORY") return "sin histórico todavía";
  return "no calculable";
}

/** Escala verbal. Un «72» sin referencia no significa nada para nadie. */
export function scoreWord(n: number | null): string {
  if (n === null) return UNKNOWN;
  if (n >= 80) return "Muy alto";
  if (n >= 62) return "Alto";
  if (n >= 40) return "Medio";
  if (n >= 22) return "Bajo";
  return "Muy bajo";
}

/** Para saturación, «alto» es malo: la palabra cambia, el número no. */
export function saturationWord(n: number | null): string {
  if (n === null) return UNKNOWN;
  if (n >= 75) return "Muy saturado";
  if (n >= 55) return "Concurrido";
  if (n >= 35) return "Media";
  return "Baja";
}

export function ScoreBar({
  label,
  value,
  word,
  tone = "neutral",
}: {
  label: string;
  value: number | null;
  word?: string;
  tone?: "neutral" | "good" | "warn";
}) {
  const pct = value === null ? 0 : Math.max(2, Math.min(100, value));
  const color = tone === "good" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-brand-gold";
  return (
    <div className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto] items-center gap-3 py-1">
      <span className="text-[12px] text-brand-muted truncate">{label}</span>
      <span className="h-1.5 rounded-full bg-brand-surface-2 overflow-hidden" aria-hidden>
        {value !== null && <span className={`block h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />}
      </span>
      <span className="text-[12px] font-medium tabular-nums min-w-[5.5rem] text-right">
        {word ?? (value === null ? UNKNOWN : Math.round(value))}
      </span>
    </div>
  );
}

// ------------------------------------------------------------
// Procedencia del dato
// ------------------------------------------------------------

const PROVENANCE_TEXT: Record<MetricProvenance, string> = {
  OBSERVED: "Observado: contado directamente sobre los anuncios.",
  PROVIDER_ESTIMATE: "Estimación del proveedor: no lo hemos medido nosotros.",
  INTERNAL_REAL: "Dato real de Casamable.",
  CALCULATED: "Calculado por nosotros a partir de los datos de arriba.",
  AI_INFERENCE: "Inferido por IA leyendo el texto de los anuncios. Es una lectura, no una medición.",
};

const PROVENANCE_SHORT: Record<MetricProvenance, string> = {
  OBSERVED: "observado",
  PROVIDER_ESTIMATE: "estimado",
  INTERNAL_REAL: "real",
  CALCULATED: "calculado",
  AI_INFERENCE: "IA",
};

export function ProvenanceTag({ provenance }: { provenance: MetricProvenance }) {
  return (
    <span
      title={PROVENANCE_TEXT[provenance]}
      className="inline-block rounded px-1.5 py-px text-[10px] uppercase tracking-[.08em] bg-brand-surface-2 text-brand-tertiary align-middle"
    >
      {PROVENANCE_SHORT[provenance]}
    </span>
  );
}

// ------------------------------------------------------------
// Piezas menores
// ------------------------------------------------------------

export function Badge({ badge }: { badge: OpportunityBadge }) {
  const tono =
    badge === "SATURATED" || badge === "HIGH_RETURN_RISK"
      ? "bg-red-50 text-red-800 ring-red-600/15"
      : badge === "INSUFFICIENT_DATA"
        ? "bg-neutral-100 text-neutral-600 ring-neutral-500/15"
        : "bg-brand-surface-2 text-brand-muted ring-brand-border";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tono}`}>
      {BADGE_LABEL[badge]}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[11px] uppercase tracking-[.08em] text-brand-tertiary">{label}</div>
      <div className="text-[15px] font-medium tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

export function FixtureBanner() {
  return (
    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="text-[13px] font-semibold text-amber-900">Datos de ejemplo</div>
      <p className="mt-0.5 text-[12px] text-amber-800">
        Todo lo que ves está inventado para poder desarrollar sin claves. No sirve para decidir nada.
      </p>
    </div>
  );
}

export function money(n: number | null, currency = "EUR"): string {
  if (n === null || !Number.isFinite(n)) return UNKNOWN;
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function pct(n: number | null): string {
  return n === null || !Number.isFinite(n) ? UNKNOWN : `${Math.round(n * 100)} %`;
}

export function miles(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : new Intl.NumberFormat("es-ES").format(n);
}

// ------------------------------------------------------------
// Portada del producto
// ------------------------------------------------------------

/** Tonos de portada. Estables por nombre: el mismo producto sale igual siempre. */
const COVER_TONES = [
  "from-[#1f2937] to-[#374151]",
  "from-[#312e2b] to-[#4b4237]",
  "from-[#1e3a34] to-[#2f5d52]",
  "from-[#332545] to-[#4a3665]",
  "from-[#3a2a2a] to-[#5c4040]",
  "from-[#1e3050] to-[#2e4a72]",
];

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * La Biblioteca de Anuncios NO entrega la imagen del creativo por API. En vez
 * de un icono gris de «sin imagen» —que hace que media pantalla parezca
 * rota—, se compone una portada con el nombre del producto.
 *
 * Es deliberadamente ABSTRACTA: no puede confundirse con una foto real del
 * producto, que sería peor que no tener imagen.
 */
export function ProductCover({
  name,
  imageUrl,
  size = "md",
}: {
  name: string;
  imageUrl?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const alto = size === "lg" ? "h-44" : size === "sm" ? "h-16" : "h-28";
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        className={`w-full ${alto} object-cover rounded-lg bg-brand-surface-2`}
      />
    );
  }
  const tono = COVER_TONES[hashOf(name) % COVER_TONES.length];
  const iniciales = name
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      className={`w-full ${alto} rounded-lg bg-gradient-to-br ${tono} relative overflow-hidden flex items-center justify-center`}
      aria-hidden
    >
      <span className="absolute -right-6 -top-8 h-24 w-24 rounded-full bg-white/5" />
      <span className="absolute -left-8 -bottom-10 h-28 w-28 rounded-full bg-white/5" />
      <span className={`font-semibold text-white/85 tracking-tight ${size === "lg" ? "text-4xl" : size === "sm" ? "text-base" : "text-2xl"}`}>
        {iniciales || "·"}
      </span>
    </div>
  );
}
