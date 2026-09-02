"use client";

// ============================================================
// GROWTH (§10): Resumen · Embudo · Productos · Anuncios · Calculadora ·
// Auditoría · Recompra · Competencia. Los datos reales (Finanzas, Meta Ads,
// calculadora) se conectan; lo que aún no tiene integración se muestra
// como estado vacío HONESTO que dice qué falta. Nada de porcentajes
// inventados.
// ============================================================

import { useState } from "react";
import AdsPanel from "./AdsPanel";
import CodCalculatorPanel from "./CodCalculatorPanel";
import FinancePanel from "./FinancePanel";
import GrowthProductsPanel from "./GrowthProductsPanel";
import type { DockView } from "./NavRail";
import { Card, Chip, EmptyState, SectionTitle } from "./ui";

export type GrowthTab = "summary" | "funnel" | "products" | "ads" | "calculator" | "audit" | "repurchase" | "competition";

const TABS: Array<{ id: GrowthTab; label: string }> = [
  { id: "summary", label: "Resumen" },
  { id: "funnel", label: "Embudo" },
  { id: "products", label: "Productos" },
  { id: "ads", label: "Anuncios" },
  { id: "calculator", label: "Calculadora COD" },
  { id: "audit", label: "Auditoría" },
  { id: "repurchase", label: "Recompra" },
  { id: "competition", label: "Competencia" },
];

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

const FUNNEL_STEPS = [
  { label: "Visita", source: "Shopify Web Pixels", available: false },
  { label: "Producto visto", source: "Shopify Web Pixels", available: false },
  { label: "Añadido al carrito", source: "Shopify Web Pixels", available: false },
  { label: "Checkout iniciado", source: "Shopify Web Pixels", available: false },
  { label: "Pedido COD", source: "Shopify webhooks", available: true },
  { label: "WhatsApp enviado", source: "outbox", available: true },
  { label: "Pedido confirmado", source: "máquina de confirmación", available: true },
  { label: "Pedido enviado", source: "tracking (Dropea/Beeping)", available: true },
  { label: "Pedido entregado", source: "eje de cierre", available: true },
  { label: "Pedido devuelto", source: "eje de cierre", available: true },
];

function ScrollRoot({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-5">{children}</div>
    </div>
  );
}

function FunnelPanel() {
  return (
    <ScrollRoot>
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-text">Embudo</h1>
        <p className="mt-1 text-sm text-brand-muted">De la visita a la entrega. Los pasos de la tienda (visita → checkout) necesitan Shopify Web Pixels, que todavía no está integrado: se muestran sin cifras, no con cifras inventadas.</p>
      </div>
      <Card className="divide-y divide-brand-border">
        {FUNNEL_STEPS.map((s, i) => (
          <div key={s.label} className="flex items-center gap-3 px-4 py-3">
            <span className="w-6 text-xs text-brand-muted tabular-nums">{i + 1}</span>
            <span className="flex-1 text-sm text-brand-text">{s.label}</span>
            <span className="text-xs text-brand-muted hidden sm:inline">{s.source}</span>
            {s.available ? <DataKind kind="real" /> : <span className="text-xs text-brand-muted">No disponible</span>}
          </div>
        ))}
      </Card>
      <p className="text-xs text-brand-muted">Los pasos con «Dato real» ya se miden en Resumen y Productos (pedidos, confirmación, entrega, devolución). Para los cuatro primeros hace falta activar Web Pixels en Shopify y un endpoint que los reciba — no forma parte de esta versión.</p>
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
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 md:px-8 pt-4">
        <div className="max-w-5xl mx-auto flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" role="tablist" aria-label="Secciones de Growth">
          {TABS.map((t) => (
            <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </Chip>
          ))}
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
