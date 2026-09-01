"use client";

// ============================================================
// AGENTE (§24) — el copiloto operativo, NO un chatbot vacío.
//
// Lee /api/agent (determinista: Action Center + cola de Beeping) y enseña,
// pedido a pedido: QUÉ PASA / QUÉ FALTA / RECOMENDACIÓN. "Abrir" lleva a
// la pestaña donde se resuelve (Acciones o Pedidos).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { DockView } from "./Dock";
import {
  Card,
  EmptyState,
  ErrorState,
  formatInt,
  GhostButton,
  KpiTile,
  SectionTitle,
  Skeleton,
  timeAgo,
} from "./ui";

interface AgentItem {
  orderId: number;
  orderNumber: string;
  customer: string;
  urgency: number;
  whatsHappening: string;
  whatsMissing: string;
  recommendation: string;
  type: string;
  sinceAt: number;
}

interface AgentData {
  ok: boolean;
  summary: { total: number; urgent: number; awaitingRelease: number };
  items: AgentItem[];
}

/** Acento de urgencia en el borde izquierdo de cada tarjeta. */
function accentClass(urgency: number): string {
  if (urgency <= 2) return "border-l-2 border-l-red-500/70";
  if (urgency <= 4) return "border-l-2 border-l-amber-500/70";
  return "border-l-2 border-l-brand-border";
}

function MicroSection({ label, children }: { label: string; children: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-brand-muted font-semibold mb-1">{label}</div>
      <div className="text-sm text-brand-text leading-snug">{children}</div>
    </div>
  );
}

export default function AgentPanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const [data, setData] = useState<AgentData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agent", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as AgentData;
      if (!j.ok) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudo cargar el copiloto. Reintentando…");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <section>
          <SectionTitle>Agente</SectionTitle>
          <p className="text-sm text-brand-muted -mt-1 mb-4">
            Tu copiloto operativo: qué está pasando, qué falta y qué haría yo.
          </p>

          {/* Resumen */}
          {!data ? (
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[76px]" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <KpiTile label="Pendientes" value={formatInt(data.summary.total)} />
              <KpiTile
                label="Urgentes"
                value={formatInt(data.summary.urgent)}
                status={data.summary.urgent > 0 ? "error" : "ok"}
              />
              <KpiTile
                label="Para Beeping"
                value={formatInt(data.summary.awaitingRelease)}
                status={data.summary.awaitingRelease > 0 ? "warn" : undefined}
              />
            </div>
          )}
        </section>

        {/* Lista de trabajo */}
        <section className="space-y-3">
          {!data ? (
            <>
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </>
          ) : data.items.length === 0 ? (
            <Card>
              <EmptyState title="Nada requiere intervención. El agente sigue vigilando." />
            </Card>
          ) : (
            data.items.map((item) => (
              <Card key={`${item.type}:${item.orderId}`} className={`px-4 py-3.5 ${accentClass(item.urgency)}`}>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <span className="text-sm font-semibold text-brand-text">#{item.orderNumber}</span>
                    <span className="text-sm text-brand-muted"> · {item.customer}</span>
                    <span className="ml-2 text-[11px] text-brand-muted whitespace-nowrap">{timeAgo(item.sinceAt)}</span>
                  </div>
                  <GhostButton
                    className="px-3 py-1.5 text-xs shrink-0"
                    onClick={() => onNavigate(item.type === "BEEPING_RELEASE" ? "orders" : "actions")}
                  >
                    Abrir
                  </GhostButton>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <MicroSection label="Qué pasa">{item.whatsHappening}</MicroSection>
                  <MicroSection label="Qué falta">{item.whatsMissing}</MicroSection>
                  <MicroSection label="Recomendación">{item.recommendation}</MicroSection>
                </div>
              </Card>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
