"use client";

// ============================================================
// Primitivas de UI del Control Center — el ÚNICO vocabulario visual.
//
// Dirección de arte v4.1: sobria, densa y precisa. Contraste por
// tipografía y espacio, no por adornos. Las píldoras quedan reservadas a
// badges de estado; pestañas, filtros y botones usan radios contenidos.
// Todos los paneles construyen con estas piezas y con los tokens de
// globals.css. Nada de colores sueltos por los componentes.
// ============================================================

import { useEffect, useRef, type ReactNode } from "react";

// --- Formateadores compartidos ---

export function formatEuro(n: number | null | undefined, opts: { decimals?: number } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: opts.decimals ?? 2,
    maximumFractionDigits: opts.decimals ?? 2,
  }).format(n);
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("es-ES").format(n);
}

export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`;
}

/** "hace 5 min", "hace 3 h", "hace 2 días" — para últimas sincronizaciones. */
export function timeAgo(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "nunca";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} día(s)`;
}

// --- Estados y colores ---

export type UiStatus = "ok" | "warn" | "error" | "muted" | "info";

export const STATUS_TEXT: Record<UiStatus, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  error: "text-red-600",
  muted: "text-brand-muted",
  info: "text-sky-600",
};

const STATUS_BG: Record<UiStatus, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  muted: "bg-brand-tertiary/70",
  info: "bg-sky-500",
};

const STATUS_SOFT: Record<UiStatus, string> = {
  ok: "bg-emerald-600/10 text-emerald-700",
  warn: "bg-amber-600/10 text-amber-700",
  error: "bg-red-600/10 text-red-700",
  muted: "bg-brand-surface-2 text-brand-muted",
  info: "bg-sky-600/10 text-sky-700",
};

/** Traduce los HealthStatus del backend al vocabulario visual. */
export function healthToUi(status: string): UiStatus {
  if (status === "healthy") return "ok";
  if (status === "warning") return "warn";
  if (status === "critical") return "error";
  if (status === "disabled") return "muted";
  return "muted";
}

export function StatusDot({ status, pulse = false }: { status: UiStatus; pulse?: boolean }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${STATUS_BG[status]} ${pulse ? "brand-pulse" : ""}`} aria-hidden />
  );
}

/** Badge de estado: la ÚNICA píldora del sistema. Corto, con punto y texto. */
export function Badge({ status = "muted", children, dot = true }: { status?: UiStatus; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 h-[22px] text-[12px] font-medium whitespace-nowrap ${STATUS_SOFT[status]}`}>
      {dot ? <StatusDot status={status} /> : null}
      {children}
    </span>
  );
}

/** Madurez de un módulo (§15). No es un framework: es vocabulario visual
 *  para que Pedro sepa QUÉ puede esperar antes de entrar.
 *   · live            → conectado a datos reales, se puede operar
 *   · beta            → funciona, pero con límites que hay que declarar
 *   · not_configured  → la interfaz existe, la fuente de datos no */
export type FeatureReadiness = "live" | "beta" | "not_configured";

const READINESS: Record<FeatureReadiness, { label: string; status: UiStatus }> = {
  live: { label: "Conectado", status: "ok" },
  beta: { label: "Beta", status: "info" },
  not_configured: { label: "Sin conectar", status: "muted" },
};

export function ReadinessBadge({ readiness, title }: { readiness: FeatureReadiness; title?: string }) {
  const { label, status } = READINESS[readiness];
  return (
    <span title={title}>
      <Badge status={status}>{label}</Badge>
    </span>
  );
}

// --- Contenedores ---

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-brand-border bg-brand-surface shadow-[var(--shadow-card)] ${className}`}>{children}</div>
  );
}

/** Etiqueta de sección: pequeña, medium, sin gritar. */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <h2 className="text-[13px] font-medium text-brand-muted">{children}</h2>
      {right}
    </div>
  );
}

/** Cabecera de página: título 28–30 px + contexto en una sola jerarquía. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] md:text-[30px] font-semibold text-brand-text leading-[1.15] tracking-[-0.02em]">{title}</h1>
        {description ? <p className="mt-1.5 text-[14px] text-brand-muted leading-snug">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}

/** Tarjeta de KPI: cifra grande + etiqueta + apoyo opcional. */
export function KpiTile({
  label,
  value,
  support,
  status,
}: {
  label: string;
  value: ReactNode;
  support?: ReactNode;
  status?: UiStatus;
}) {
  return (
    <Card className="px-5 py-4">
      <div className="text-[13px] font-medium text-brand-muted leading-snug">{label}</div>
      <div className={`mt-1.5 font-display text-[26px] font-semibold leading-none tabular-nums ${status ? STATUS_TEXT[status] : "text-brand-text"}`}>
        {value}
      </div>
      {support ? <div className="mt-1.5 text-[12px] text-brand-tertiary leading-snug">{support}</div> : null}
    </Card>
  );
}

/** Resumen operativo compacto: N métricas en UNA superficie con divisores. */
export function MetricGroup({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 }) {
  const grid = cols === 2 ? "grid-cols-2" : cols === 3 ? "grid-cols-2 md:grid-cols-3" : cols === 5 ? "grid-cols-2 md:grid-cols-5" : "grid-cols-2 md:grid-cols-4";
  return (
    <Card className="overflow-hidden">
      <div className={`grid ${grid} gap-px bg-brand-border`}>{children}</div>
    </Card>
  );
}

export function MetricCell({ label, value, support, status, onClick, active }: { label: string; value: ReactNode; support?: ReactNode; status?: UiStatus; onClick?: () => void; active?: boolean }) {
  const inner = (
    <>
      <div className="text-[13px] font-medium text-brand-muted leading-snug">{label}</div>
      <div className={`mt-1.5 font-display text-[26px] font-semibold leading-none tabular-nums ${status ? STATUS_TEXT[status] : "text-brand-text"}`}>{value}</div>
      {support ? <div className="mt-1.5 text-[12px] text-brand-tertiary leading-snug">{support}</div> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={active} className={`text-left px-5 py-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-text/30 ${active ? "bg-brand-surface-subtle" : "bg-brand-surface hover:bg-brand-surface-subtle"}`}>
        {inner}
      </button>
    );
  }
  return <div className="bg-brand-surface px-5 py-4">{inner}</div>;
}

// --- Navegación secundaria ---

/** Pestañas con indicador inferior. Distintas de los filtros a propósito.
 *  En móvil la fila no cabe entera: la pestaña activa se trae SOLA a la
 *  vista, para que nadie tenga que adivinar dónde está ni descubrir por
 *  accidente que la fila se desplaza. */
export function TabBar<T extends string>({ tabs, value, onChange, label, counts }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (t: T) => void; label: string; counts?: Partial<Record<T, number | undefined>> }) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // `nearest` no mueve la página, solo el carril de pestañas.
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [value]);
  return (
    <div role="tablist" aria-label={label} className="flex gap-5 md:gap-6 overflow-x-auto border-b border-brand-border no-scrollbar">
      {tabs.map((t) => {
        const active = t.id === value;
        const n = counts?.[t.id];
        return (
          <button
            key={t.id}
            ref={active ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={`relative shrink-0 h-11 md:h-10 text-[14px] font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 rounded-sm ${active ? "text-brand-text" : "text-brand-muted hover:text-brand-text"}`}
          >
            {t.label}
            {n !== undefined && n > 0 ? <span className={`ml-1.5 text-[12px] tabular-nums ${active ? "text-brand-muted" : "text-brand-tertiary"}`}>{n}</span> : null}
            <span className={`absolute inset-x-0 -bottom-px h-[2px] rounded-full ${active ? "bg-brand-text" : "bg-transparent"}`} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

// --- Interacción ---

/** Filtro compacto (NO una píldora): texto + contador, activo en carbón. */
export function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 h-11 md:h-8 text-[13px] font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
        active
          ? "bg-brand-text text-white"
          : "text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text"
      }`}
    >
      {children}
      {count !== undefined ? <span className={`text-[12px] tabular-nums ${active ? "text-white/70" : "text-brand-tertiary"}`}>{count}</span> : null}
    </button>
  );
}

/** Toolbar de filtros: búsqueda + selectores + fila de estados. */
export function Toolbar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

export const INPUT_CLASS =
  "h-11 md:h-9 rounded-lg border border-brand-border bg-brand-surface px-3 text-[13px] text-brand-text placeholder:text-brand-tertiary transition-colors hover:border-brand-border-strong focus:border-brand-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/15";

export function SelectInput({ value, onChange, options, label, className = "" }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; label: string; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={`${INPUT_CLASS} pr-8 ${className}`}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function SearchInput({ value, onChange, placeholder, label, className = "" }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-brand-tertiary pointer-events-none">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" />
        </svg>
      </span>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} className={`${INPUT_CLASS} w-full pl-8`} />
    </div>
  );
}

export function PrimaryButton({
  onClick,
  disabled,
  busy,
  children,
  danger = false,
  className = "",
}: {
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 h-11 md:h-9 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? "bg-red-600 text-white hover:bg-red-700"
          : "bg-brand-gold text-white hover:bg-brand-gold-soft"
      } ${className}`}
    >
      {busy ? <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function GhostButton({
  onClick,
  disabled,
  children,
  className = "",
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-brand-border bg-brand-surface px-3 h-11 md:h-9 text-[13px] font-medium text-brand-text hover:border-brand-border-strong hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
}

/** Enlace-acción discreto (texto medium, sin caja). */
export function TextButton({ onClick, children, className = "" }: { onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 rounded-sm ${className}`}>
      {children}
    </button>
  );
}

// --- Estados vacíos / carga / error ---

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-center">
      {icon ? <div className="text-brand-tertiary mb-1">{icon}</div> : null}
      <div className="text-[14px] font-medium text-brand-text">{title}</div>
      {hint ? <div className="text-[13px] text-brand-muted max-w-sm leading-snug">{hint}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <StatusDot status="error" />
      <div className="text-[14px] text-brand-text">{message}</div>
      {onRetry ? <GhostButton onClick={onRetry}>Reintentar</GhostButton> : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-brand-surface-2 ${className}`} aria-hidden />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

// --- Badge de estado del pedido (vocabulario único, §21) ---

export type OrderUiState =
  | "waiting_customer"
  | "confirmed"
  | "ready_beeping"
  | "preparing"
  | "shipped"
  | "delivered"
  | "incident"
  | "cancelled"
  | "needs_call"
  | "other";

export const ORDER_STATE_LABEL: Record<OrderUiState, { label: string; status: UiStatus }> = {
  waiting_customer: { label: "Esperando cliente", status: "info" },
  needs_call: { label: "Necesita llamada", status: "warn" },
  confirmed: { label: "Confirmado", status: "ok" },
  ready_beeping: { label: "Listo Beeping", status: "warn" },
  preparing: { label: "Preparando", status: "info" },
  shipped: { label: "Enviado", status: "info" },
  delivered: { label: "Entregado", status: "ok" },
  incident: { label: "Incidencia", status: "error" },
  cancelled: { label: "Cancelado", status: "muted" },
  other: { label: "—", status: "muted" },
};

export function OrderStateBadge({ state }: { state: OrderUiState }) {
  const { label, status } = ORDER_STATE_LABEL[state];
  return <Badge status={status}>{label}</Badge>;
}

// --- Modal / Drawer ligeros (sustituyen a window.confirm/prompt) ---

export function ModalShell({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}) {
  // Escape cierra (accesibilidad): el hook va ANTES del return condicional.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-brand-border bg-brand-surface p-5 shadow-[var(--shadow-float)]">
        {title ? <div className="mb-3 text-[15px] font-semibold text-brand-text">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

/** Drawer lateral de detalle: cabecera fija, cuerpo con scroll, pie de acciones. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  meta,
  children,
  footer,
  label,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal aria-label={label}>
      <div className="absolute inset-0 bg-black/25" onClick={onClose} aria-hidden />
      <div className="relative h-full w-full sm:w-[520px] bg-brand-surface border-l border-brand-border shadow-[var(--shadow-float)] flex flex-col anim-slide-right">
        <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-brand-border">
          <div className="min-w-0">
            <div className="font-display text-[18px] font-semibold text-brand-text leading-tight">{title}</div>
            {subtitle ? <div className="mt-0.5 text-[13px] text-brand-muted">{subtitle}</div> : null}
            {meta ? <div className="mt-2">{meta}</div> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="h-11 w-11 md:h-9 md:w-9 -mr-2 -mt-1 shrink-0 rounded-lg text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="mx-auto" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <div className="shrink-0 px-6 py-3 border-t border-brand-border flex gap-2 pb-[max(env(safe-area-inset-bottom),12px)]">{footer}</div> : null}
      </div>
    </div>
  );
}
