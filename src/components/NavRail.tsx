"use client";

// ============================================================
// Navegación v4.2 — REGLA DE SUPERFICIE: una función no gana espacio
// principal porque exista en el código. Lo gana por frecuencia de uso,
// impacto operativo, datos reales, acciones reales y valor diario.
//
// Escritorio: sidebar de 240 px agrupada (Operación · Crecimiento ·
// Herramientas · Sistema), colapsable a 72 px con preferencia recordada.
// Móvil: CINCO entradas — Inicio, Pedidos, Seguimiento, Growth y "Más"
// (Cazador, Landing Studio, Ajustes), respetando safe-area-inset.
//
// Cazador (sin fuente real) y Landing Studio (beta, localStorage) viven
// en Herramientas: accesibles, pero sin competir con la operación diaria.
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { Emblem } from "./Logo";
import { StatusDot, type UiStatus } from "./ui";

/** Las 6 áreas reales de la navegación. */
export type NavArea = "home" | "orders" | "followup" | "hunter" | "growth" | "settings";
/** Destinos que aceptan las pantallas: las áreas + alias heredados que el
 *  shell traduce a área+pestaña (acciones/chats/envíos/agente → Seguimiento;
 *  anuncios/finanzas → Growth). */
export type DockView = NavArea | "landing" | "actions" | "chats" | "agent" | "shipments" | "ads" | "finance";

/** Clave de resaltado: las áreas + "landing" (que es Cazador en su pestaña
 *  de Landing Studio, no un área propia). */
export type NavKey = NavArea | "landing";

/** Grupos de la sidebar. El orden es la prioridad operativa. */
export type NavGroup = "operation" | "growth" | "tools" | "system";

export const NAV_GROUPS: Array<{ id: NavGroup; label: string }> = [
  { id: "operation", label: "Operación" },
  { id: "growth", label: "Crecimiento" },
  { id: "tools", label: "Herramientas" },
  { id: "system", label: "Sistema" },
];

export const NAV_ITEMS: Array<{ id: NavKey; target: DockView; label: string; hint: string; group: NavGroup }> = [
  { id: "home", target: "home", label: "Inicio", hint: "Qué pasa hoy y qué necesita tu atención", group: "operation" },
  { id: "orders", target: "orders", label: "Pedidos", hint: "Confirmar, corregir y liberar pedidos", group: "operation" },
  { id: "followup", target: "followup", label: "Seguimiento", hint: "WhatsApp, llamadas y envíos por pedido", group: "operation" },
  { id: "growth", target: "growth", label: "Growth", hint: "Finanzas, embudo, productos y auditoría", group: "growth" },
  { id: "hunter", target: "hunter", label: "Cazador", hint: "Explorar productos — sin fuente de datos conectada", group: "tools" },
  { id: "landing", target: "landing", label: "Landing Studio", hint: "Beta: los proyectos se guardan en este navegador", group: "tools" },
  { id: "settings", target: "settings", label: "Ajustes", hint: "Integraciones, WhatsApp, llamadas y sistema", group: "system" },
];

/** Móvil: las CUATRO áreas de operación diaria + "Más" = 5 entradas.
 *  Cazador y Landing Studio NO están aquí a propósito (regla de superficie). */
const MOBILE_PRIMARY: NavKey[] = ["home", "orders", "followup", "growth"];

/** Lo que vive dentro de "Más", agrupado. */
const MORE_GROUPS: Array<{ label: string; items: NavKey[] }> = [
  { label: "Herramientas", items: ["hunter", "landing"] },
  { label: "Sistema", items: ["settings"] },
];

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const NAV_ICONS: Record<NavKey | "more", ReactNode> = {
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
  landing: (
    <svg viewBox="0 0 24 24" width="20" height="20" {...stroke} aria-hidden>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 9h17" />
      <path d="M7 13h6M7 16.5h4" />
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
  view: NavKey;
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

  const item = (id: NavKey, target: DockView, label: string, hint: string) => {
    const active = view === id;
    const n = id === "landing" ? 0 : (badges[id as NavArea] ?? 0);
    return (
      <button
        key={id}
        type="button"
        onClick={() => onViewChange(target)}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : hint}
        className={`group relative flex items-center gap-3 w-full rounded-lg h-10 text-[14px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
          collapsed ? "justify-center px-0" : "px-3"
        } ${active ? "bg-brand-text text-white" : "text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text"}`}
      >
        <span className="text-current">{NAV_ICONS[id]}</span>
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && <Badge n={n} />}
        {collapsed && n > 0 && <span className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${active ? "bg-white" : "bg-brand-text"}`} aria-hidden />}
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

        <div className={`flex-1 min-h-0 overflow-y-auto py-3 px-3`}>
          {NAV_GROUPS.filter((g) => g.id !== "system").map((group) => {
            const items = NAV_ITEMS.filter((i) => i.group === group.id);
            if (items.length === 0) return null;
            return (
              <div key={group.id} className="mb-4 last:mb-0">
                {collapsed ? (
                  <div className="mx-3 mb-2 h-px bg-brand-border first:hidden" aria-hidden />
                ) : (
                  <div className="px-3 pb-1.5 text-[11px] font-medium text-brand-tertiary">{group.label}</div>
                )}
                <div className="space-y-0.5">{items.map((i) => item(i.id, i.target, i.label, i.hint))}</div>
              </div>
            );
          })}
        </div>

        <div className={`py-3 space-y-0.5 border-t border-brand-border ${collapsed ? "px-3" : "px-3"}`}>
          {NAV_ITEMS.filter((i) => i.group === "system").map((i) => item(i.id, i.target, i.label, i.hint))}
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

      {/* ── Móvil: 4 áreas de operación + Más, con label SIEMPRE visible ── */}
      <nav
        aria-label="Navegación principal"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t border-brand-border bg-brand-surface/95 backdrop-blur pb-[max(env(safe-area-inset-bottom),4px)]"
      >
        {MOBILE_PRIMARY.map((id) => {
          const it = NAV_ITEMS.find((i) => i.id === id)!;
          const active = view === id;
          const n = id === "landing" ? 0 : (badges[id as NavArea] ?? 0);
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMoreOpen(false);
                onViewChange(it.target);
              }}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-1 h-14 min-w-[44px] text-[11px] font-medium transition-colors ${active ? "text-brand-text" : "text-brand-tertiary"}`}
            >
              {NAV_ICONS[id]}
              <span>{it.label}</span>
              {n > 0 && (
                <span className="absolute top-1.5 right-1/2 translate-x-4 min-w-[16px] h-4 px-1 rounded-md bg-brand-text text-white text-[10px] font-semibold leading-4 text-center tabular-nums">
                  {n > 9 ? "9+" : n}
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
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-brand-border" aria-hidden />
            {MORE_GROUPS.map((group) => (
              <div key={group.label} className="mb-4 last:mb-0">
                <div className="px-1 pb-2 text-[12px] font-medium text-brand-tertiary">{group.label}</div>
                <div className="space-y-2">
                  {group.items.map((id) => {
                    const i = NAV_ITEMS.find((x) => x.id === id)!;
                    const active = view === id;
                    return (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => {
                          setMoreOpen(false);
                          onViewChange(i.target);
                        }}
                        aria-current={active ? "page" : undefined}
                        className={`flex w-full items-center gap-3 rounded-xl border px-4 h-14 text-[14px] font-medium transition-colors ${
                          active ? "border-brand-text bg-brand-text text-white" : "border-brand-border bg-brand-surface text-brand-text"
                        }`}
                      >
                        {NAV_ICONS[i.id]}
                        <span className="flex-1 text-left">{i.label}</span>
                        <span className={`text-[12px] font-normal ${active ? "text-white/70" : "text-brand-tertiary"}`}>
                          {i.id === "hunter" ? "Sin conectar" : i.id === "landing" ? "Beta" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
