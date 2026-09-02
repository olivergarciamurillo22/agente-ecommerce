"use client";

// ============================================================
// Navegación v4 (§5): seis áreas, nombres que un operador entiende sin
// tooltip. Escritorio: sidebar estable de 232 px (colapsable a 72 px,
// preferencia recordada). Móvil: barra inferior con las 4 áreas
// principales + "Más" (Growth, Ajustes), respetando safe-area-inset.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { Emblem } from "./Logo";
import { StatusDot, type UiStatus } from "./ui";

/** Las 6 áreas reales de la navegación. */
export type NavArea = "home" | "orders" | "followup" | "hunter" | "growth" | "settings";
/** Destinos que aceptan las pantallas: las áreas + alias heredados que el
 *  shell traduce a área+pestaña (acciones/chats/envíos/agente → Seguimiento;
 *  anuncios/finanzas → Growth). */
export type DockView = NavArea | "actions" | "chats" | "agent" | "shipments" | "ads" | "finance";

export const NAV_ITEMS: Array<{ id: NavArea; label: string; hint: string }> = [
  { id: "home", label: "Inicio", hint: "Qué pasa hoy y qué necesita tu atención" },
  { id: "orders", label: "Pedidos", hint: "Confirmar, corregir y liberar pedidos" },
  { id: "followup", label: "Seguimiento", hint: "WhatsApp, llamadas y envíos por pedido" },
  { id: "hunter", label: "Cazador", hint: "Productos que podrían merecer un test" },
  { id: "growth", label: "Growth", hint: "Finanzas, embudo, productos y auditoría" },
];

/** Móvil (§5): 4 áreas + "Más". */
const MOBILE_PRIMARY: NavArea[] = ["home", "orders", "followup", "hunter"];

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const NAV_ICONS: Record<NavArea | "more", ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h4V15h3v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  ),
  orders: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  ),
  followup: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <path d="M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z" />
      <path d="M9 12h6" />
    </svg>
  ),
  hunter: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.8-3.8" />
      <path d="M11 8v6M8 11h6" />
    </svg>
  ),
  growth: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <path d="M4 19h16" />
      <path d="M5 15l4-5 4 3 6-7" />
      <path d="M15 6h4v4" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95A7 7 0 0 0 14.06 5l-.36-2.5h-4L9.34 5a7 7 0 0 0-2.44 1.4l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.44 1.4l.36 2.5h4l.36-2.5a7 7 0 0 0 2.44-1.4l2.36.95 2-3.46-2-1.55A7 7 0 0 0 19 12z" />
    </svg>
  ),
  more: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  ),
};

function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-md bg-brand-surface-2 text-brand-muted group-aria-[current=page]:bg-white/15 group-aria-[current=page]:text-white text-[11px] font-medium leading-5 text-center tabular-nums" aria-label={`${n} pendientes`}>
      {n > 99 ? "99+" : n}
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
  view: NavArea;
  onViewChange: (v: DockView) => void;
  badges?: Partial<Record<NavArea, number>>;
  systemStatus?: UiStatus;
  systemLabel?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("nav_collapsed") === "1");
    } catch {
      /* default expandida */
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("nav_collapsed", next ? "1" : "0");
    } catch {
      /* sin persistencia */
    }
  };

  const item = (id: NavArea, label: string, hint: string) => {
    const active = view === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onViewChange(id)}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : hint}
        className={`group relative flex items-center gap-3 w-full rounded-lg h-10 text-[14px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
          collapsed ? "justify-center px-0" : "px-3"
        } ${active ? "bg-brand-text text-white" : "text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text"}`}
      >
        <span className="text-current">{NAV_ICONS[id]}</span>
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && <Badge n={badges[id] ?? 0} />}
        {collapsed && (badges[id] ?? 0) > 0 && <span className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${active ? "bg-white" : "bg-brand-text"}`} aria-hidden />}
      </button>
    );
  };

  return (
    <>
      {/* ── Escritorio ── */}
      <nav
        aria-label="Navegación principal"
        className={`hidden md:flex flex-col shrink-0 border-r border-brand-border bg-brand-surface transition-[width] duration-200 ${collapsed ? "w-[72px]" : "w-[240px]"}`}
      >
        <div className={`flex items-center gap-3 h-[60px] border-b border-brand-border ${collapsed ? "justify-center px-0" : "px-5"}`}>
          <Emblem size={26} />
          {!collapsed && (
            <div className="leading-none min-w-0">
              <div className="font-display font-semibold text-[15px] text-brand-text tracking-[-0.01em]">Casamable</div>
              <div className="mt-1 text-[12px] text-brand-muted">Control Center</div>
            </div>
          )}
        </div>

        <div className={`flex-1 min-h-0 overflow-y-auto py-4 space-y-0.5 ${collapsed ? "px-3" : "px-3"}`}>
          {NAV_ITEMS.map((i) => item(i.id, i.label, i.hint))}
        </div>

        <div className={`py-3 space-y-0.5 border-t border-brand-border ${collapsed ? "px-3" : "px-3"}`}>
          {item("settings", "Ajustes", "Integraciones, WhatsApp, llamadas y sistema")}
          <div className={`flex items-center gap-2 h-9 text-[12px] text-brand-tertiary ${collapsed ? "justify-center px-0" : "px-3"}`}>
            <StatusDot status={systemStatus} pulse={systemStatus === "error"} />
            {!collapsed && <span className="truncate">{systemLabel}</span>}
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expandir navegación" : "Colapsar navegación"}
            className={`flex items-center gap-2 w-full rounded-lg h-9 text-[12px] text-brand-tertiary hover:text-brand-text hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${collapsed ? "justify-center px-0" : "px-3"}`}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" {...stroke} className={collapsed ? "rotate-180" : ""} aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
            {!collapsed && <span>Colapsar</span>}
          </button>
        </div>
      </nav>

      {/* ── Móvil: 4 + Más, con label siempre ── */}
      <nav
        aria-label="Navegación principal"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t border-brand-border bg-brand-surface/95 backdrop-blur pb-[max(env(safe-area-inset-bottom),4px)]"
      >
        {MOBILE_PRIMARY.map((id) => {
          const it = NAV_ITEMS.find((i) => i.id === id)!;
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
              className={`relative flex flex-col items-center justify-center gap-1 h-14 min-w-[44px] text-[11px] font-medium transition-colors ${active ? "text-brand-text" : "text-brand-tertiary"}`}
            >
              {NAV_ICONS[id]}
              <span>{it.label}</span>
              {(badges[id] ?? 0) > 0 && (
                <span className="absolute top-1.5 right-1/2 translate-x-4 min-w-[16px] h-4 px-1 rounded-md bg-brand-text text-white text-[10px] font-semibold leading-4 text-center tabular-nums">
                  {(badges[id] ?? 0) > 9 ? "9+" : badges[id]}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={`flex flex-col items-center justify-center gap-1 h-14 min-w-[44px] text-[11px] font-medium ${!MOBILE_PRIMARY.includes(view) ? "text-brand-text" : "text-brand-tertiary"}`}
        >
          {NAV_ICONS.more}
          <span>Más</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal aria-label="Más secciones">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMoreOpen(false)} aria-hidden />
          <div className="absolute bottom-0 inset-x-0 rounded-t-2xl border-t border-brand-border bg-brand-surface p-4 pb-[max(env(safe-area-inset-bottom),16px)] anim-slide-up">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-brand-border" aria-hidden />
            <div className="grid grid-cols-2 gap-2">
              {[...NAV_ITEMS.filter((i) => !MOBILE_PRIMARY.includes(i.id)), { id: "settings" as NavArea, label: "Ajustes", hint: "" }].map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    onViewChange(i.id);
                  }}
                  className={`flex items-center gap-3 rounded-xl border px-4 h-14 text-[14px] font-medium transition-colors ${
                    view === i.id ? "border-brand-text bg-brand-text text-white" : "border-brand-border bg-brand-surface text-brand-text"
                  }`}
                >
                  {NAV_ICONS[i.id]}
                  <span>{i.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
