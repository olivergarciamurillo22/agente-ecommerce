"use client";

// ============================================================
// Cabecera (60 px): título de la sección en una sola jerarquía, buscador
// global compacto y el estado del canal como indicador, no como botón.
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
  /** Título de la sección activa. */
  sectionLabel: string;
  onOpenSearch: () => void;
  systemStatus: UiStatus;
}

export default function DashboardHeader({ phone, provider, sectionLabel, onOpenSearch, systemStatus }: DashboardHeaderProps) {
  const esCloud = provider === "cloud_api";
  const canal = esCloud ? "API oficial de Meta" : phone ? `+${phone}` : "sin número";
  const estado = systemStatus === "ok" ? "operativo" : systemStatus === "warn" ? "con avisos" : systemStatus === "error" ? "atención requerida" : "estado desconocido";

  return (
    <header className="shrink-0 border-b border-brand-border bg-brand-surface px-4 md:px-8 h-[60px] flex items-center gap-4">
      {/* En móvil la marca vive aquí (en desktop, en el sidebar). */}
      <div className="md:hidden">
        <Logo size={16} subtitle={false} />
      </div>

      {/* Escritorio: buscador global a la izquierda, como en una herramienta
          de trabajo; el título de la página vive en la propia página. */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label={`Buscar en ${sectionLabel} y en todo el panel`}
        className="hidden sm:flex items-center gap-2 h-9 w-[280px] rounded-lg border border-brand-border bg-brand-surface px-3 text-[13px] text-brand-tertiary hover:border-brand-border-strong hover:text-brand-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/20"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" />
        </svg>
        <span className="truncate">Buscar pedido o cliente</span>
        <kbd className="ml-auto rounded border border-brand-border px-1.5 text-[11px] font-sans text-brand-tertiary">⌘K</kbd>
      </button>

      <div className="flex-1" />

      <div
        className="flex items-center gap-2 h-9 px-2 rounded-lg text-[13px] text-brand-muted"
        title={`WhatsApp · ${canal} · ${estado}`}
        aria-label={`WhatsApp ${canal}, ${estado}`}
      >
        <StatusDot status={systemStatus} pulse={systemStatus === "error"} />
        <span className="font-medium text-brand-text">WhatsApp</span>
        <span className="hidden lg:inline text-brand-tertiary tabular-nums">{canal}</span>
      </div>
    </header>
  );
}
