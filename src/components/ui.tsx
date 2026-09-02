"use client";

// ============================================================
// Primitivas de UI del Control Center v2 — el ÚNICO vocabulario visual.
//
// Todos los paneles construyen con estas piezas (Card, KPI, StatusDot,
// Chip, EmptyState, Skeleton…) y con los tokens de marca de globals.css.
// Nada de colores sueltos por los componentes: la coherencia visual del
// panel entero vive aquí.
// ============================================================

import { useEffect, type ReactNode } from "react";

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
  ok: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-red-400",
  muted: "text-brand-muted",
  info: "text-sky-400",
};

const STATUS_BG: Record<UiStatus, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
  muted: "bg-brand-muted/60",
  info: "bg-sky-400",
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

// --- Contenedores ---

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-brand-border bg-brand-surface ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h2 className="text-[11px] font-semibold tracking-[0.18em] uppercase text-brand-muted">{children}</h2>
      {right}
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
    <Card className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-brand-muted truncate">{label}</div>
      <div className={`mt-1 text-xl font-semibold font-display leading-tight ${status ? STATUS_TEXT[status] : "text-brand-text"}`}>
        {value}
      </div>
      {support ? <div className="mt-0.5 text-[11px] text-brand-muted leading-snug">{support}</div> : null}
    </Card>
  );
}

// --- Interacción ---

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
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 ${
        active
          ? "border-brand-gold/60 bg-brand-gold/15 text-brand-gold"
          : "border-brand-border bg-brand-surface text-brand-muted hover:text-brand-text hover:border-brand-muted/60"
      }`}
    >
      {children}
      {count !== undefined ? <span className={`text-[10px] ${active ? "text-brand-gold/80" : "text-brand-muted"}`}>{count}</span> : null}
    </button>
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
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 disabled:opacity-40 disabled:cursor-not-allowed ${
        danger
          ? "bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25"
          : "bg-brand-gold text-black hover:bg-brand-gold-soft"
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
      className={`inline-flex items-center justify-center gap-2 rounded-xl border border-brand-border px-3.5 py-2 text-sm text-brand-text hover:border-brand-muted/70 hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
}

// --- Estados vacíos / carga / error ---

export function EmptyState({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {icon ? <div className="text-brand-muted/70">{icon}</div> : null}
      <div className="text-sm text-brand-text">{title}</div>
      {hint ? <div className="text-xs text-brand-muted max-w-sm">{hint}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <StatusDot status="error" />
      <div className="text-sm text-brand-text">{message}</div>
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
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-border bg-brand-surface-2 px-2.5 py-1 text-[11px] whitespace-nowrap">
      <StatusDot status={status} />
      <span className="text-brand-text">{label}</span>
    </span>
  );
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-brand-border bg-brand-surface p-5 shadow-2xl">
        {title ? <div className="mb-3 text-sm font-semibold text-brand-text">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}
