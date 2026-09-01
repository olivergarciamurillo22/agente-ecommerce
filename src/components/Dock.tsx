"use client";

// ============================================================
// NAV DOCK — la navegación del Control Center v2 (§18).
//
// Desktop (md+): dock vertical flotante a la izquierda, iconos circulares
// con tooltip y badge de atención. Móvil: dock inferior fijo con targets
// táctiles de 44px+. Máximo 9 secciones; el estado activo es evidente.
// ============================================================

import type { ReactNode } from "react";

export type DockView =
  | "home"
  | "actions"
  | "orders"
  | "chats"
  | "agent"
  | "shipments"
  | "ads"
  | "finance"
  | "settings";

export const DOCK_ITEMS: Array<{ id: DockView; label: string }> = [
  { id: "home", label: "Inicio" },
  { id: "actions", label: "Acciones" },
  { id: "orders", label: "Pedidos" },
  { id: "chats", label: "Chats" },
  { id: "agent", label: "Agente" },
  { id: "shipments", label: "Envíos" },
  { id: "ads", label: "Anuncios" },
  { id: "finance", label: "Finanzas" },
  { id: "settings", label: "Ajustes" },
];

// Iconos propios: trazo 1.6, 20px, coherentes entre sí (nada de emojis).
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICONS: Record<DockView, ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h4V15h3v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  ),
  actions: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M4 5h16v10H8l-4 4z" />
      <path d="M9 9h6" />
      <path d="M9 12h4" />
    </svg>
  ),
  orders: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  ),
  chats: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z" />
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 8V5" />
      <circle cx="12" cy="4" r="1" />
      <path d="M9.5 12.5h.01M14.5 12.5h.01" strokeWidth="2.4" />
      <path d="M9.5 15.5c.8.7 4.2.7 5 0" />
    </svg>
  ),
  shipments: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M2 7h12v9H2z" />
      <path d="M14 10h4l3 3v3h-7z" />
      <circle cx="6.5" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
    </svg>
  ),
  ads: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M3 11v3l4 1 2 5 2-1-1.6-4.4L18 17V5z" />
      <path d="M21 9.5v3" />
    </svg>
  ),
  finance: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M21 20H3" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95A7 7 0 0 0 14.06 5l-.36-2.5h-4L9.34 5a7 7 0 0 0-2.44 1.4l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.44 1.4l.36 2.5h4l.36-2.5a7 7 0 0 0 2.44-1.4l2.36.95 2-3.46-2-1.55A7 7 0 0 0 19 12z" />
    </svg>
  ),
};

export default function Dock({
  view,
  onViewChange,
  badges = {},
}: {
  view: DockView;
  onViewChange: (v: DockView) => void;
  /** Nº de elementos que requieren atención, por sección. 0/undefined = sin badge. */
  badges?: Partial<Record<DockView, number>>;
}) {
  const item = (id: DockView, label: string, compact: boolean) => {
    const active = view === id;
    const badge = badges[id] ?? 0;
    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={() => onViewChange(id)}
        className={`group relative flex items-center justify-center transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 ${
          compact
            ? "h-12 min-w-[44px] flex-1 rounded-xl"
            : "h-11 w-11 rounded-full border"
        } ${
          active
            ? compact
              ? "text-brand-gold"
              : "border-brand-gold/60 bg-brand-gold/15 text-brand-gold shadow-[0_0_18px_rgba(250,197,28,0.15)]"
            : compact
              ? "text-brand-muted hover:text-brand-text"
              : "border-brand-border bg-brand-surface text-brand-muted hover:text-brand-text hover:border-brand-muted/60"
        }`}
      >
        {ICONS[id]}
        {badge > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-4 text-center">
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
        {/* Tooltip (solo desktop) */}
        {!compact ? (
          <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-lg border border-brand-border bg-brand-surface-2 px-2.5 py-1 text-xs text-brand-text opacity-0 translate-x-[-4px] transition-all group-hover:opacity-100 group-hover:translate-x-0 z-50">
            {label}
          </span>
        ) : (
          <span className={`absolute -bottom-0.5 text-[9px] leading-none ${active ? "text-brand-gold" : "text-transparent"}`}>•</span>
        )}
      </button>
    );
  };

  return (
    <>
      {/* Desktop: dock vertical flotante */}
      <nav
        aria-label="Navegación principal"
        className="hidden md:flex fixed left-3 top-1/2 -translate-y-1/2 z-40 flex-col gap-2 rounded-full border border-brand-border bg-brand-bg/80 backdrop-blur px-2 py-3"
      >
        {DOCK_ITEMS.map((i) => item(i.id, i.label, false))}
      </nav>

      {/* Móvil: dock inferior */}
      <nav
        aria-label="Navegación principal"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 flex items-stretch gap-0.5 border-t border-brand-border bg-brand-bg/95 backdrop-blur px-1 pb-[max(env(safe-area-inset-bottom),4px)] pt-1"
      >
        {DOCK_ITEMS.map((i) => item(i.id, i.label, true))}
      </nav>
    </>
  );
}
