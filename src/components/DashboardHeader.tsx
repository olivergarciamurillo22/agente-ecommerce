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
import { IconSearch } from "./icons";
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
        <IconSearch size={15} />
        <span className="truncate">Buscar pedido, cliente o pantalla</span>
        <kbd className="ml-auto rounded border border-brand-border px-1.5 text-[11px] font-sans text-brand-tertiary">⌘K</kbd>
      </button>

      {/* En móvil el buscador NO existía: la barra completa no cabe, así que
          simplemente se ocultaba y no había ninguna forma de buscar desde el
          teléfono. Ahora hay un botón de 44 px, que es el mínimo con el que
          se acierta con el dedo sin pensar. */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Buscar pedido, cliente o pantalla"
        className="sm:hidden ml-auto flex h-11 w-11 items-center justify-center rounded-lg text-brand-muted active:bg-brand-surface-2"
      >
        <IconSearch size={19} />
      </button>

      <div className="hidden sm:block flex-1" />

      <div
        className="hidden sm:flex items-center gap-2 h-9 px-2 rounded-lg text-[13px] text-brand-muted"
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
