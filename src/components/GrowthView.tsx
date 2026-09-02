"use client";

// ============================================================
// GROWTH (§10): Resumen · Embudo · Productos · Anuncios · Calculadora ·
// Auditoría · Recompra · Competencia. Los datos reales (Finanzas, Meta Ads,
// calculadora) se conectan; lo que aún no tiene integración se muestra
// como estado vacío HONESTO que dice qué falta. Nada de porcentajes
// inventados.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import AdsPanel from "./AdsPanel";
import CodCalculatorPanel from "./CodCalculatorPanel";
import FinancePanel from "./FinancePanel";
import GrowthProductsPanel from "./GrowthProductsPanel";
import type { DockView } from "./NavRail";
import { Card, Chip, EmptyState, ErrorState, SectionTitle, SkeletonRows, TabBar, formatInt } from "./ui";

export type GrowthTab = "summary" | "funnel" | "products" | "ads" | "calculator" | "audit" | "repurchase" | "competition";

/** Jerarquía (regla de superficie): lo que se mira a diario va en pestañas;
 *  el análisis ocasional vive en "Más análisis". Misma funcionalidad, menos
 *  ruido — ninguna sub-área desaparece. */
const TABS: Array<{ id: GrowthTab; label: string }> = [
  { id: "summary", label: "Resumen" },
  { id: "funnel", label: "Embudo" },
  { id: "products", label: "Productos" },
  { id: "ads", label: "Anuncios" },
];

const SECONDARY_TABS: Array<{ id: GrowthTab; label: string }> = [
  { id: "calculator", label: "Calculadora COD" },
  { id: "audit", label: "Auditoría" },
  { id: "repurchase", label: "Recompra" },
  { id: "competition", label: "Competencia" },
];

export const ALL_GROWTH_TABS = [...TABS, ...SECONDARY_TABS];

/** Etiqueta de naturaleza del dato (§10): hecho, hipótesis, escenario, IA. */
export function DataKind({ kind }: { kind: "real" | "hypothesis" | "scenario" | "ai" }) {
  const map = {
    real: { label: "Dato real", cls: "text-emerald-700 border-emerald-500/40 bg-emerald-500/10" },
    hypothesis: { label: "Hipótesis", cls: "text-amber-700 border-amber-500/40 bg-amber-500/10" },
    scenario: { label: "Escenario", cls: "text-sky-700 border-sky-500/40 bg-sky-500/10" },
    ai: { label: "Recomendación IA", cls: "text-violet-700 border-violet-500/40 bg-violet-500/10" },
  }[kind];
  return <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${map.cls}`}>{map.label}</span>;
}

interface FunnelSnapshot { steps: Array<{ id: string; label: string; source: string; value: number | null; available: boolean }>; missingIntegrations: string[]; period: "30d" }

function ScrollRoot({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-[1280px] space-y-5">{children}</div>
    </div>
  );
}

function FunnelPanel() {
  const [data, setData] = useState<FunnelSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/growth/funnel", { cache: "no-store" });
      const json = await response.json() as { ok: boolean; data?: FunnelSnapshot; error?: string };
      if (!response.ok || !json.ok || !json.data) throw new Error(json.error ?? "respuesta inválida");
      setData(json.data); setError(null);
    } catch { setError("No se pudo cargar el embudo real."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <ScrollRoot>
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-text">Embudo</h1>
        <p className="mt-1 text-sm text-brand-muted">De la visita a la entrega. Los pasos de la tienda (visita → checkout) necesitan Shopify Web Pixels, que todavía no está integrado: se muestran sin cifras, no con cifras inventadas.</p>
      </div>
      {error && !data ? <ErrorState message={error} onRetry={load} /> : !data ? <SkeletonRows rows={10} /> : <Card className="divide-y divide-brand-border">
        {data.steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-3 px-4 py-3">
            <span className="w-6 text-xs text-brand-muted tabular-nums">{i + 1}</span>
            <span className="flex-1 text-sm text-brand-text">{s.label}</span>
            <span className="text-xs text-brand-muted hidden sm:inline">{s.source}</span>
            {s.available ? <><span className="min-w-10 text-right text-sm font-semibold tabular-nums text-brand-text">{formatInt(s.value)}</span><DataKind kind="real" /></> : <span className="text-xs text-brand-muted">No disponible</span>}
          </div>
        ))}
      </Card>}
      <p className="text-xs text-brand-muted">Ventana: últimos 30 días. Pedido, WhatsApp, confirmación, envío y cierre son recuentos reales de pedidos; no se presentan como ventas ni como margen. «Devuelto» es un cierre alternativo a «Entregado», no un paso posterior. Falta: Shopify Web Pixels para visita, producto, carrito y checkout.</p>
    </ScrollRoot>
  );
}

const AUDIT_AREAS = ["Ficha de producto", "Carrito y checkout", "Confianza", "Catálogo", "Ticket medio", "Móvil", "Velocidad", "SEO", "Captación", "Medición", "Recompra", "Reputación", "Competencia"];

function AuditPanel() {
  return (
    <ScrollRoot>
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-text">Auditoría</h1>
        <p className="mt-1 text-sm text-brand-muted">Cada hallazgo llevará título, evidencia, fuente, fecha, impacto, esfuerzo, confianza, acción, estado, responsable y resultado. Aún no hay análisis automáticos ejecutados: no hay hallazgos que mostrar.</p>
      </div>
      <Card className="p-4">
        <SectionTitle>Áreas que se auditarán</SectionTitle>
        <div className="flex flex-wrap gap-1.5">
          {AUDIT_AREAS.map((a) => (
            <Chip key={a}>{a}</Chip>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <DataKind kind="real" /> <DataKind kind="hypothesis" /> <DataKind kind="scenario" /> <DataKind kind="ai" />
          <span className="text-xs text-brand-muted self-center">— así se distinguirán los hallazgos cuando existan.</span>
        </div>
      </Card>
      <Card>
        <EmptyState title="Sin auditorías ejecutadas." hint="Cuando exista el motor de análisis (Shopify Admin API + IA), los hallazgos aparecerán aquí con su evidencia. Nada se rellena a mano ni se estima." />
      </Card>
    </ScrollRoot>
  );
}

function RepurchasePanel() {
  return (
    <ScrollRoot>
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-text">Recompra</h1>
        <p className="mt-1 text-sm text-brand-muted">Clientes que repiten, frecuencia y valor por cliente.</p>
      </div>
      <Card>
        <EmptyState title="Todavía no hay datos de recompra." hint="Se calcula cruzando teléfonos normalizados entre pedidos entregados. Con el histórico actual (pedidos únicos en su mayoría) no hay muestra suficiente; aparecerá solo cuando haya clientes con más de un pedido entregado." />
      </Card>
    </ScrollRoot>
  );
}

function CompetitionPanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  return (
    <ScrollRoot>
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-text">Competencia</h1>
        <p className="mt-1 text-sm text-brand-muted">Quién anuncia qué y desde cuándo. Se alimenta del Cazador de productos (Meta Ad Library).</p>
      </div>
      <Card>
        <EmptyState title="Sin datos de competencia todavía." hint="Cuando el backend del Cazador esté conectado, aquí verás anunciantes y productos vigilados. Mientras tanto, la búsqueda vive en Cazador." />
        <div className="flex justify-center pb-6">
          <Chip onClick={() => onNavigate("hunter")}>Ir al Cazador →</Chip>
        </div>
      </Card>
    </ScrollRoot>
  );
}

export default function GrowthView({ initialTab, onNavigate }: { initialTab?: GrowthTab; onNavigate: (v: DockView) => void }) {
  const [tab, setTab] = useState<GrowthTab>(initialTab ?? "summary");
  // La sub-área secundaria activa se muestra como pestaña extra mientras se
  // está en ella: si no, el operador no vería dónde está.
  const secondary = SECONDARY_TABS.find((t) => t.id === tab) ?? null;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 md:px-8 bg-brand-surface border-b border-brand-border">
        <div className="-mb-px flex items-center gap-4">
          <TabBar
            tabs={secondary ? [...TABS, secondary] : TABS}
            value={tab}
            onChange={setTab}
            label="Secciones de Growth"
          />
          <select
            value=""
            onChange={(e) => e.target.value && setTab(e.target.value as GrowthTab)}
            aria-label="Más análisis"
            className={`ml-auto h-8 shrink-0 rounded-lg border-0 bg-transparent pl-2 pr-7 text-[13px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/20 ${secondary ? "text-brand-text" : "text-brand-muted"}`}
          >
            <option value="">Más análisis</option>
            {SECONDARY_TABS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "summary" ? (
          <FinancePanel />
        ) : tab === "funnel" ? (
          <FunnelPanel />
        ) : tab === "products" ? (
          <GrowthProductsPanel onNavigate={onNavigate} />
        ) : tab === "ads" ? (
          <AdsPanel />
        ) : tab === "calculator" ? (
          <CodCalculatorPanel />
        ) : tab === "audit" ? (
          <AuditPanel />
        ) : tab === "repurchase" ? (
          <RepurchasePanel />
        ) : (
          <CompetitionPanel onNavigate={onNavigate} />
        )}
      </div>
    </div>
  );
}
