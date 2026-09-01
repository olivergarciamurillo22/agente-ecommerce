"use client";

// ============================================================
// Cabecera v3 (§36, §47): contexto de la sección + búsqueda (⌘K) +
// estado del canal de WhatsApp, PROVIDER-AWARE.
//
// Con cloud_api NO hay sesión QR: aquí no existe "Desconectar" ni nada
// con semántica de Baileys. Gestionar la conexión vive en Ajustes →
// WhatsApp (y solo enseña acciones válidas para el proveedor activo).
// ============================================================

import Logo from "./Logo";
import { StatusDot, type UiStatus } from "./ui";

interface DashboardHeaderProps {
  phone: string | null;
  provider?: string;
  /** Título de la sección activa (breadcrumb simple). */
  sectionLabel: string;
  onOpenSearch: () => void;
  systemStatus: UiStatus;
}

export default function DashboardHeader({ phone, provider, sectionLabel, onOpenSearch, systemStatus }: DashboardHeaderProps) {
  const esCloud = provider === "cloud_api";
  const canal = esCloud ? "WhatsApp · API oficial de Meta" : phone ? `WhatsApp · +${phone}` : "WhatsApp";

  return (
    <header className="shrink-0 border-b border-brand-border bg-brand-surface/60 backdrop-blur px-4 md:px-6 h-[64px] flex items-center gap-4">
      {/* En móvil la marca vive aquí (en desktop, en el rail). */}
      <div className="md:hidden">
        <Logo size={17} subtitle={false} />
      </div>

      <div className="hidden md:block min-w-0">
        <div className="text-[11px] text-brand-muted leading-none">Casamable</div>
        <div className="text-[15px] font-semibold text-brand-text leading-tight truncate">{sectionLabel}</div>
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onOpenSearch}
        className="hidden sm:flex items-center gap-2 rounded-xl border border-brand-border bg-brand-surface-2/60 px-3 py-2 text-xs text-brand-muted hover:text-brand-text hover:border-brand-muted/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/50"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" />
        </svg>
        <span>Buscar</span>
        <kbd className="rounded border border-brand-border px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
      </button>

      <div className="flex items-center gap-2 rounded-xl border border-brand-border bg-brand-surface-2/60 px-3 py-2">
        <StatusDot status={systemStatus} pulse={systemStatus === "error"} />
        <span className="text-xs text-brand-muted hidden sm:inline">{canal}</span>
        <span className="text-xs text-brand-muted sm:hidden">WhatsApp</span>
      </div>
    </header>
  );
}
