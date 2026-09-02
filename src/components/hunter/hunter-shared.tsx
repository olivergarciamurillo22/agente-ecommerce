"use client";

// ============================================================
// Cazador de productos — piezas compartidas del módulo.
//
// Construye SOBRE las primitivas de ../ui (Card, Chip, StatusDot…); aquí
// solo viven las piezas específicas del cazador: drawer responsive,
// píldoras de estado de dato / saturación, mini Winner Score, clases de
// formulario y el cliente fetch de /api/product-hunter.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { formatEuro, StatusDot, type UiStatus } from "../ui";
import { UNAVAILABLE_LABEL, scoreLabel } from "@/lib/product-hunter/scoring";
import {
  COMPARE_MAX,
  DATA_STATUS_LABEL,
  SATURATION_LABEL,
  SCORE_CONFIDENCE_LABEL,
  type DataStatus,
  type DetectedPrice,
  type SaturationLevel,
  type ScoreConfidence,
  type WinnerScoreBreakdown,
} from "@/lib/product-hunter/types";

export const MAX_COMPARE = COMPARE_MAX;

// --- Formularios (no hay primitiva de input en ui.tsx: se define aquí una vez) ---

// Base sin tamaño + variantes con tamaño COMPLETO cada una: en Tailwind v4 el
// conflicto entre dos utilidades de la misma propiedad lo decide el orden de la
// hoja, no el del atributo, así que nunca se "sobrescribe" un tamaño anexando.
const CONTROL_BASE =
  "rounded-xl border border-brand-border bg-brand-surface text-brand-text placeholder:text-brand-muted/60 transition-colors duration-150 hover:border-brand-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 disabled:opacity-40";
export const INPUT_CLASS = `${CONTROL_BASE} w-full min-h-11 px-3 py-2 text-sm`;
export const SELECT_CLASS = `${INPUT_CLASS} cursor-pointer`;
/** Select pequeño para barras de herramientas (orden, "Mover a…"). */
export const SELECT_COMPACT_CLASS = `${CONTROL_BASE} w-auto min-h-9 px-3 py-1.5 text-xs cursor-pointer`;
export const TEXTAREA_CLASS = `${CONTROL_BASE} w-full min-h-24 px-3 py-2 text-sm resize-y leading-relaxed`;
export const LABEL_CLASS = "block text-[11px] uppercase tracking-wider text-brand-muted mb-1.5";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-brand-muted">{hint}</span> : null}
    </label>
  );
}

// --- Cliente de la API (nunca lanza: devuelve {ok:false} para que la UI decida) ---

export type ApiFail = { ok: false; error: string; code?: string };
export type ApiResult<T> = ({ ok: true } & T) | ApiFail;

function asResult<T>(j: unknown): ApiResult<T> {
  if (typeof j === "object" && j !== null && typeof (j as { ok?: unknown }).ok === "boolean") return j as ApiResult<T>;
  return { ok: false, error: "Respuesta inválida del panel." };
}

export async function hunterGet<T>(op: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<ApiResult<T>> {
  try {
    const q = new URLSearchParams({ op });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    const res = await fetch(`/api/product-hunter?${q.toString()}`, { cache: "no-store" });
    return asResult<T>(await res.json());
  } catch {
    return { ok: false, error: "No se pudo contactar con el panel." };
  }
}

export async function hunterPost<T>(body: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const res = await fetch("/api/product-hunter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
    return asResult<T>(await res.json());
  } catch {
    return { ok: false, error: "No se pudo contactar con el panel." };
  }
}

// --- Formato ---

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(iso: string | null): string {
  if (!iso) return UNAVAILABLE_LABEL;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNAVAILABLE_LABEL;
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: DATE_ONLY.test(iso) ? "UTC" : "Europe/Madrid",
  }).format(d);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return UNAVAILABLE_LABEL;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNAVAILABLE_LABEL;
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  }).format(d);
}

export function formatPrice(p: DetectedPrice | null): string {
  if (!p) return UNAVAILABLE_LABEL;
  if (p.currency === "EUR") return formatEuro(p.amount);
  return `${p.amount.toLocaleString("es-ES", { maximumFractionDigits: 2 })} ${p.currency}`;
}

export function formatDays(n: number | null): string {
  if (n === null) return UNAVAILABLE_LABEL;
  return n === 1 ? "1 día activo" : `${n} días activo`;
}

export function formatVariations(n: number | null): string {
  if (n === null) return UNAVAILABLE_LABEL;
  return n === 1 ? "1 variación" : `${n} variaciones`;
}

export function confidenceStatus(c: ScoreConfidence | null): UiStatus {
  if (c === "high") return "ok";
  if (c === "medium") return "warn";
  return "muted";
}

export function confidenceLabel(c: ScoreConfidence | null): string {
  return c ? SCORE_CONFIDENCE_LABEL[c] : "Sin confianza asignada";
}

// --- Píldoras ---

type PillTone = "neutral" | "ok" | "warn" | "error" | "accent";

const PILL_TONE: Record<PillTone, string> = {
  neutral: "border-brand-border bg-brand-surface-2 text-brand-muted",
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600",
  error: "border-red-500/30 bg-red-500/10 text-red-600",
  accent: "border-brand-gold/40 bg-brand-gold/10 text-brand-gold",
};

export function Pill({ tone = "neutral", children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap leading-4 ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function DataStatusPill({ status }: { status: DataStatus }) {
  const tone: PillTone = status === "complete" ? "ok" : status === "partial" ? "warn" : "neutral";
  return <Pill tone={tone}>{DATA_STATUS_LABEL[status]}</Pill>;
}

export function SaturationPill({ level }: { level: SaturationLevel | null }) {
  if (!level) return <Pill>Saturación: {UNAVAILABLE_LABEL.toLowerCase()}</Pill>;
  const tone: PillTone = level === "low" ? "ok" : level === "medium" ? "warn" : "error";
  return <Pill tone={tone}>{SATURATION_LABEL[level]}</Pill>;
}

export function CountryChips({ countries }: { countries: string[] }) {
  if (countries.length === 0) return <Pill>País {UNAVAILABLE_LABEL.toLowerCase()}</Pill>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {countries.map((c) => (
        <span key={c} className="rounded-md border border-brand-border bg-brand-surface-2 px-1.5 py-px text-[10px] font-semibold tracking-wide text-brand-muted">
          {c}
        </span>
      ))}
    </span>
  );
}

/** Winner Score compacto: número + punto de confianza, o "Pendiente". */
export function ScoreMini({ score, size = "sm" }: { score: WinnerScoreBreakdown | null; size?: "sm" | "lg" }) {
  const label = scoreLabel(score);
  if (label.pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-brand-muted" title={label.text}>
        <StatusDot status="muted" />
        Pendiente
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5" title={`Winner Score ${label.text} · ${confidenceLabel(label.confidence)}`}>
      <span className={`font-display font-semibold tabular-nums text-brand-text ${size === "lg" ? "text-3xl" : "text-base"}`}>{label.text}</span>
      <StatusDot status={confidenceStatus(label.confidence)} />
    </span>
  );
}

// --- Iconos mínimos (trazo 1,5, sin relleno) ---

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden>
      <path d="M2 4h12M4.5 8h7M7 12h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- Drawer responsive ---

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () => setDesktop(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return desktop;
}

/**
 * Panel lateral en escritorio (derecha) y hoja en móvil (a pantalla completa
 * o desde abajo). Escape cierra; el fondo cierra; el botón lleva aria-label.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  header,
  widthClass = "md:w-[560px]",
  mobile = "full",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  header?: ReactNode;
  widthClass?: string;
  mobile?: "full" | "sheet";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const desktop = useIsDesktop();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;

  const mobileClass =
    mobile === "sheet" ? "inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl border-t" : "inset-0";

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal aria-label={title}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div
        className={`absolute ${mobileClass} md:inset-auto md:top-0 md:bottom-0 md:right-0 md:max-h-full md:rounded-none md:border-t-0 md:border-l ${widthClass} md:max-w-full border-brand-border bg-brand-surface shadow-2xl flex flex-col ${
          desktop ? "anim-slide-right" : "anim-slide-up"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-brand-border/60 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-display text-lg md:text-xl font-semibold text-brand-text leading-tight">{title}</div>
            {subtitle ? <div className="mt-1 text-xs text-brand-muted">{subtitle}</div> : null}
            {header}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 flex h-11 w-11 md:h-9 md:w-9 items-center justify-center rounded-lg border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-muted/60 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
        {footer ? <div className="shrink-0 border-t border-brand-border/60 px-5 py-3 bg-brand-surface">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Sección plana del drawer: título pequeño + contenido, separada por hairline. */
export function DrawerSection({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-5 py-4 border-b border-brand-border/60 last:border-b-0">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <h3 className="text-[11px] font-semibold tracking-[0.18em] uppercase text-brand-muted">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Fila etiqueta → valor (valor null → "No disponible", nunca 0). */
export function FactRow({ label, value, muted = false }: { label: string; value: ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-brand-muted shrink-0">{label}</span>
      <span className={`text-right min-w-0 truncate ${muted ? "text-brand-muted" : "text-brand-text"}`}>{value}</span>
    </div>
  );
}

/** Aviso corto y transitorio (sustituye a alert()). */
export function InlineNotice({ tone, children }: { tone: "ok" | "error" | "info"; children: ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600"
      : tone === "error"
        ? "border-red-500/30 bg-red-500/5 text-red-600"
        : "border-brand-border bg-brand-surface-2 text-brand-muted";
  return (
    <div role="status" className={`rounded-xl border px-3.5 py-2.5 text-sm ${cls}`}>
      {children}
    </div>
  );
}
