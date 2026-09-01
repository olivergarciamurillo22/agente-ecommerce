"use client";

// ============================================================
// HOME = CONTROL ROOM (§19). Tres zonas, en este orden:
//   1. HOY — las cifras del día en 5 segundos.
//   2. REQUIERE TU ATENCIÓN — lo que espera una decisión de Pedro.
//   3. FLUJO — Shopify → WhatsApp → Beeping/Dropea → Ads → Llamadas.
// Cero métricas de ingeniería: eso vive en Ajustes.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { DockView } from "./Dock";
import {
  Card,
  ErrorState,
  formatEuro,
  formatInt,
  healthToUi,
  KpiTile,
  SectionTitle,
  Skeleton,
  StatusDot,
} from "./ui";

interface FlowNode {
  id: string;
  label: string;
  status: string;
  message: string;
}

interface AttentionItem {
  type: string;
  count: number;
  label: string;
  urgency: "urgent" | "today" | "later";
  target: DockView;
}

interface HomeData {
  ok: boolean;
  today: {
    orders: number;
    confirmed: number;
    awaitingCustomer: number;
    needsCall: number;
    deliveredToday: number;
    grossRevenue: number;
    deliveredRevenue: number;
    estimatedMargin: number | null;
    marginMissing: string[];
    adSpend: number | null;
  };
  attention: AttentionItem[];
  attentionTotal: number;
  flow: FlowNode[];
  beepingCutoff: { shipsToday: boolean; minutesLeft: number | null; message: string };
}

const URGENCY_STYLE: Record<AttentionItem["urgency"], { label: string; cls: string }> = {
  urgent: { label: "URGENTE", cls: "text-red-400 border-red-500/40 bg-red-500/10" },
  today: { label: "HOY", cls: "text-amber-400 border-amber-500/40 bg-amber-500/10" },
  later: { label: "DESPUÉS", cls: "text-brand-muted border-brand-border bg-brand-surface-2" },
};

export default function HomePanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as HomeData;
      if (!j.ok) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudo cargar el resumen. Reintentando…");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-7">
        {/* ── HOY ── */}
        <section>
          <SectionTitle
            right={
              data ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
                  <StatusDot status={data.beepingCutoff.shipsToday ? "ok" : "muted"} />
                  Beeping: {data.beepingCutoff.message}
                </span>
              ) : null
            }
          >
            Hoy
          </SectionTitle>
          {!data ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-[76px]" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiTile label="Pedidos" value={formatInt(data.today.orders)} />
              <KpiTile label="Confirmados" value={formatInt(data.today.confirmed)} status={data.today.confirmed > 0 ? "ok" : undefined} />
              <KpiTile
                label="Pendientes"
                value={formatInt(data.today.awaitingCustomer + data.today.needsCall)}
                support={data.today.needsCall > 0 ? `${data.today.needsCall} para llamar` : "esperando respuesta"}
              />
              <KpiTile label="Entregados" value={formatInt(data.today.deliveredToday)} status={data.today.deliveredToday > 0 ? "ok" : undefined} />
              <KpiTile label="Facturación" value={formatEuro(data.today.grossRevenue)} support="pedidos enviados hoy" />
              <KpiTile label="Cobrado (entregado)" value={formatEuro(data.today.deliveredRevenue)} />
              <KpiTile label="Publicidad" value={formatEuro(data.today.adSpend)} support={data.today.adSpend === null ? "sin dato del día" : undefined} />
              <KpiTile
                label="Beneficio est."
                value={formatEuro(data.today.estimatedMargin)}
                status={data.today.estimatedMargin === null ? undefined : data.today.estimatedMargin >= 0 ? "ok" : "error"}
                support={data.today.estimatedMargin === null ? "faltan datos (ver Finanzas)" : undefined}
              />
            </div>
          )}
        </section>

        {/* ── REQUIERE TU ATENCIÓN ── */}
        <section>
          <SectionTitle>Requiere tu atención</SectionTitle>
          {!data ? (
            <Skeleton className="h-32" />
          ) : data.attention.length === 0 ? (
            <Card className="px-5 py-6 flex items-center gap-3">
              <StatusDot status="ok" />
              <div>
                <div className="text-sm text-brand-text">Todo al día</div>
                <div className="text-xs text-brand-muted">Nada espera una decisión tuya ahora mismo.</div>
              </div>
            </Card>
          ) : (
            <Card className="divide-y divide-brand-border">
              {data.attention.map((a) => {
                const style = URGENCY_STYLE[a.urgency];
                return (
                  <button
                    key={a.type}
                    type="button"
                    onClick={() => onNavigate(a.target)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-brand-surface-2 transition-colors first:rounded-t-2xl last:rounded-b-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
                  >
                    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${style.cls}`}>
                      {style.label}
                    </span>
                    <span className="flex-1 text-sm text-brand-text">
                      <span className="font-semibold">{a.count}</span> {a.label}
                    </span>
                    <span className="text-brand-muted text-xs">Resolver →</span>
                  </button>
                );
              })}
            </Card>
          )}
        </section>

        {/* ── FLUJO ── */}
        <section>
          <SectionTitle>Flujo</SectionTitle>
          {!data ? (
            <Skeleton className="h-20" />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {data.flow.map((f) => (
                <Card key={f.id} className="px-3.5 py-3" >
                  <div className="flex items-center gap-2">
                    <StatusDot status={healthToUi(f.status)} pulse={f.status === "critical"} />
                    <span className="text-sm text-brand-text">{f.label}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-brand-muted leading-snug line-clamp-2" title={f.message}>
                    {f.message || "—"}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
