"use client";

// ============================================================
// NAV RAIL premium (V3 §30-31, §48). Sustituye al dock de iconos.
//
// Desktop: rail lateral con LABELS SIEMPRE VISIBLES (~224px), colapsable a
// 72px (preferencia recordada en localStorage; expandida por defecto:
// Pedro no tiene que adivinar iconos). Ajustes abajo + estado del sistema.
//
// Móvil: barra inferior de CINCO entradas con icono + label SIEMPRE
// (Inicio · Pedidos · Chats · Acciones · Más); "Más" abre una sheet con
// el resto. Nada de 9 iconos minúsculos.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { Emblem } from "./Logo";
import { StatusDot, type UiStatus } from "./ui";

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

export const NAV_ITEMS: Array<{ id: DockView; label: string }> = [
  { id: "home", label: "Inicio" },
  { id: "actions", label: "Acciones" },
  { id: "orders", label: "Pedidos" },
  { id: "chats", label: "Chats" },
  { id: "agent", label: "Agente" },
  { id: "shipments", label: "Envíos" },
  { id: "ads", label: "Anuncios" },
  { id: "finance", label: "Finanzas" },
];

/** Las 5 entradas del móvil (§48): las operativas + "Más". */
const MOBILE_PRIMARY: DockView[] = ["home", "orders", "chats", "actions"];

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const NAV_ICONS: Record<DockView | "more", ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h4V15h3v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  ),
  actions: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M4 5h16v10H8l-4 4z" />
      <path d="M9 9h6" />
      <path d="M9 12h4" />
    </svg>
  ),
  orders: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  ),
  chats: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z" />
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <rect x="5" y="8" width="14" height="10" rx="3" />
      <path d="M12 8V5" />
      <circle cx="12" cy="4" r="1" />
      <path d="M9.5 12.5h.01M14.5 12.5h.01" strokeWidth="2.4" />
      <path d="M9.5 15.5c.8.7 4.2.7 5 0" />
    </svg>
  ),
  shipments: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M2 7h12v9H2z" />
      <path d="M14 10h4l3 3v3h-7z" />
      <circle cx="6.5" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
    </svg>
  ),
  ads: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M3 11v3l4 1 2 5 2-1-1.6-4.4L18 17V5z" />
      <path d="M21 9.5v3" />
    </svg>
  ),
  finance: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M21 20H3" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95A7 7 0 0 0 14.06 5l-.36-2.5h-4L9.34 5a7 7 0 0 0-2.44 1.4l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.44 1.4l.36 2.5h4l.36-2.5a7 7 0 0 0 2.44-1.4l2.36.95 2-3.46-2-1.55A7 7 0 0 0 19 12z" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  ),
};

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-red-500/90 text-white text-[10px] font-bold leading-[18px] text-center">
      {n > 9 ? "9+" : n}
    </span>
  );
}

export default function NavRail({
  view,
  onViewChange,
  badges = {},
  systemStatus = "muted",
  systemLabel = "Sistema",
}: {
  view: DockView;
  onViewChange: (v: DockView) => void;
  badges?: Partial<Record<DockView, number>>;
  /** El punto de salud global que se ve SIEMPRE (§30). */
  systemStatus?: UiStatus;
  systemLabel?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("nav_collapsed") === "1");
    } catch {
      /* default: expandida */
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("nav_collapsed", next ? "1" : "0");
    } catch {
      /* preferencia no persistida: no pasa nada */
    }
  };

  const railItem = (id: DockView, label: string) => {
    const active = view === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onViewChange(id)}
        aria-current={active ? "page" : undefined}
        title={collapsed ? label : undefined}
        className={`group relative flex items-center gap-3 w-full rounded-xl px-3 h-10 text-[13px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/50 ${
          active
            ? "bg-brand-surface-2 text-brand-text shadow-[inset_2px_0_0_0_var(--color-brand-gold)]"
            : "text-brand-muted hover:text-brand-text hover:bg-brand-surface-2/60"
        } ${collapsed ? "justify-center px-0" : ""}`}
      >
        <span className={active ? "text-brand-gold" : "text-current"}>{NAV_ICONS[id]}</span>
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && <Badge n={badges[id] ?? 0} />}
        {collapsed && (badges[id] ?? 0) > 0 && (
          <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-red-500" aria-hidden />
        )}
      </button>
    );
  };

  return (
    <>
      {/* ── Desktop: rail lateral ── */}
      <nav
        aria-label="Navegación principal"
        className={`hidden md:flex flex-col shrink-0 border-r border-brand-border bg-brand-surface/60 backdrop-blur transition-[width] duration-200 ${
          collapsed ? "w-[72px]" : "w-[224px]"
        }`}
      >
        {/* Marca */}
        <div className={`flex items-center gap-2.5 px-4 h-[64px] ${collapsed ? "justify-center px-0" : ""}`}>
          <Emblem size={30} />
          {!collapsed && (
            <div className="leading-none">
              <div className="font-display font-bold text-[15px] text-brand-text tracking-tight">Casamable</div>
              <div className="mt-0.5 text-[8px] font-semibold tracking-[0.3em] uppercase text-brand-muted">Control Center</div>
            </div>
          )}
        </div>

        <div className={`flex-1 min-h-0 overflow-y-auto py-2 space-y-0.5 relative ${collapsed ? "px-2" : "px-3"}`}>
          {NAV_ITEMS.map((i) => railItem(i.id, i.label))}
        </div>

        <div className={`py-3 space-y-2 border-t border-brand-border ${collapsed ? "px-2" : "px-3"}`}>
          {railItem("settings", "Ajustes")}
          <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] text-brand-muted ${collapsed ? "justify-center px-0" : ""}`}>
            <StatusDot status={systemStatus} pulse={systemStatus === "error"} />
            {!collapsed && <span className="truncate">{systemLabel}</span>}
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expandir navegación" : "Colapsar navegación"}
            className={`flex items-center gap-2 w-full rounded-lg px-3 py-1.5 text-[11px] text-brand-muted hover:text-brand-text transition-colors ${collapsed ? "justify-center px-0" : ""}`}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" {...stroke} className={collapsed ? "rotate-180" : ""}>
              <path d="M15 6l-6 6 6 6" />
            </svg>
            {!collapsed && <span>Colapsar</span>}
          </button>
        </div>
      </nav>

      {/* ── Móvil: 5 entradas con label ── */}
      <nav
        aria-label="Navegación principal"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t border-brand-border bg-brand-bg/95 backdrop-blur pb-[max(env(safe-area-inset-bottom),2px)]"
      >
        {MOBILE_PRIMARY.map((id) => {
          const item = NAV_ITEMS.find((i) => i.id === id)!;
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMoreOpen(false);
                onViewChange(id);
              }}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-0.5 h-[56px] text-[10px] font-medium transition-colors ${
                active ? "text-brand-gold" : "text-brand-muted"
              }`}
            >
              {NAV_ICONS[id]}
              <span>{item.label}</span>
              {(badges[id] ?? 0) > 0 && (
                <span className="absolute top-1.5 right-1/2 translate-x-4 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold leading-[15px] text-center">
                  {(badges[id] ?? 0) > 9 ? "9+" : badges[id]}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex flex-col items-center justify-center gap-0.5 h-[56px] text-[10px] font-medium ${
            !MOBILE_PRIMARY.includes(view) ? "text-brand-gold" : "text-brand-muted"
          }`}
        >
          {NAV_ICONS.more}
          <span>Más</span>
        </button>
      </nav>

      {/* Sheet de "Más" (móvil) */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal aria-label="Más secciones">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMoreOpen(false)} aria-hidden />
          <div className="absolute bottom-0 inset-x-0 rounded-t-2xl border-t border-brand-border bg-brand-surface p-4 pb-[max(env(safe-area-inset-bottom),16px)]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-brand-border" aria-hidden />
            <div className="grid grid-cols-3 gap-2">
              {[...NAV_ITEMS.filter((i) => !MOBILE_PRIMARY.includes(i.id)), { id: "settings" as DockView, label: "Ajustes" }].map(
                (i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      onViewChange(i.id);
                    }}
                    className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3.5 text-[11px] font-medium transition-colors ${
                      view === i.id
                        ? "border-brand-gold/50 bg-brand-gold/10 text-brand-gold"
                        : "border-brand-border bg-brand-surface-2/60 text-brand-text"
                    }`}
                  >
                    {NAV_ICONS[i.id]}
                    <span>{i.label}</span>
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
