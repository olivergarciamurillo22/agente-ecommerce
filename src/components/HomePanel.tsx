"use client";

// ============================================================
// HOME = BRIEFING DE LA MAÑANA (§19, §38). Cuatro zonas, en este orden:
//   0. Saludo — "Buenos días, Pedro." + una frase que resume el día.
//   1. HOY — las cifras del día en una sola superficie agrupada.
//   2. REQUIERE TU ATENCIÓN — lo que espera una decisión de Pedro.
//   3. RENTABILIDAD — el modelo COD de un vistazo.
//   4. ESTADO DEL NEGOCIO — cada integración en una fila, no en seis cajas.
// Cero métricas de ingeniería: eso vive en Ajustes.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DockView } from "./NavRail";
import {
  Card,
  ErrorState,
  formatEuro,
  formatInt,
  healthToUi,
  SectionTitle,
  Skeleton,
  StatusDot,
  STATUS_TEXT,
  type UiStatus,
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
  codModel: {
    marginPct: number | null;
    breakEvenDeliveryPct: number | null;
    currentDeliveryPct: number | null;
    cushionPts: number | null;
    sample: number;
    missingReason: string | null;
    alert: { status: string; message: string };
  };
}

const URGENCY_STYLE: Record<AttentionItem["urgency"], { label: string; cls: string }> = {
  urgent: { label: "URGENTE", cls: "text-red-600 border-red-500/40 bg-red-500/10" },
  today: { label: "HOY", cls: "text-amber-600 border-amber-500/40 bg-amber-500/10" },
  later: { label: "DESPUÉS", cls: "text-brand-muted border-brand-border bg-brand-surface-2" },
};

/** Orden acordado de integraciones en "Estado del negocio" (§38.5). */
const FLOW_ORDER = ["whatsapp", "shopify", "calls", "beeping", "dropea", "meta_ads"];

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 6 && h < 14) return "Buenos días";
  if (h >= 14 && h < 21) return "Buenas tardes";
  return "Buenas noches";
}

/** Frase-resumen del día, con singulares/plurales bien hechos. */
function summaryLine(t: HomeData["today"], attentionTotal: number): string {
  const pedidos = t.orders === 1 ? "1 pedido nuevo" : `${formatInt(t.orders)} pedidos nuevos`;
  const confirmados = t.confirmed === 1 ? "1 confirmado" : `${formatInt(t.confirmed)} confirmados`;
  const atencion =
    attentionTotal === 0
      ? "nada requiere tu atención"
      : attentionTotal === 1
        ? "1 cosa necesita tu atención"
        : `${formatInt(attentionTotal)} cosas necesitan tu atención`;
  return `${pedidos}, ${confirmados} y ${atencion}.`;
}

/** Celda de KPI dentro de la superficie agrupada de HOY (§38.2, §39). */
function KpiCell({
  label,
  value,
  support,
  status,
}: {
  label: string;
  value: ReactNode;
  support?: ReactNode;
  status?: UiStatus;
}) {
  return (
    <div className="bg-brand-surface px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wider text-brand-muted truncate">{label}</div>
      <div className={`mt-1 font-display text-xl font-semibold leading-tight tabular-nums ${status ? STATUS_TEXT[status] : "text-brand-text"}`}>
        {value}
      </div>
      {support ? <div className="mt-0.5 text-[11px] text-brand-muted leading-snug">{support}</div> : null}
    </div>
  );
}

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

  const flowSorted = data
    ? [...data.flow].sort((a, b) => {
        const ia = FLOW_ORDER.indexOf(a.id);
        const ib = FLOW_ORDER.indexOf(b.id);
        return (ia === -1 ? FLOW_ORDER.length : ia) - (ib === -1 ? FLOW_ORDER.length : ib);
      })
    : [];

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-9">
        {/* ── SALUDO: tipografía pura, sin tarjeta (§38.1) ── */}
        <header>
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-brand-text leading-tight">
            {greeting()}, Pedro.
          </h1>
          {data ? (
            <p className="mt-2 text-sm md:text-[15px] text-brand-muted">{summaryLine(data.today, data.attentionTotal)}</p>
          ) : (
            <Skeleton className="mt-2.5 h-4 w-72 max-w-full" />
          )}
        </header>

        {/* ── HOY: una sola superficie agrupada con divisiones finas (§38.2, §39) ── */}
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
            <Skeleton className="h-42" />
          ) : (
            <Card className="overflow-hidden">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-brand-border/50">
                <KpiCell label="Pedidos" value={formatInt(data.today.orders)} />
                <KpiCell label="Confirmados" value={formatInt(data.today.confirmed)} status={data.today.confirmed > 0 ? "ok" : undefined} />
                <KpiCell
                  label="Pendientes"
                  value={formatInt(data.today.awaitingCustomer + data.today.needsCall)}
                  support={data.today.needsCall > 0 ? `${data.today.needsCall} para llamar` : "esperando respuesta"}
                />
                <KpiCell label="Entregados" value={formatInt(data.today.deliveredToday)} status={data.today.deliveredToday > 0 ? "ok" : undefined} />
                <KpiCell label="Facturación" value={formatEuro(data.today.grossRevenue)} support="pedidos enviados hoy" />
                <KpiCell label="Cobrado (entregado)" value={formatEuro(data.today.deliveredRevenue)} />
                <KpiCell label="Publicidad" value={formatEuro(data.today.adSpend)} support={data.today.adSpend === null ? "sin dato del día" : undefined} />
                <KpiCell
                  label="Beneficio est."
                  value={formatEuro(data.today.estimatedMargin)}
                  status={data.today.estimatedMargin === null ? undefined : data.today.estimatedMargin >= 0 ? "ok" : "error"}
                  support={data.today.estimatedMargin === null ? "faltan datos (ver Finanzas)" : undefined}
                />
              </div>
            </Card>
          )}
        </section>

        {/* ── REQUIERE TU ATENCIÓN (§38.3) ── */}
        <section>
          <SectionTitle>Requiere tu atención</SectionTitle>
          {!data ? (
            <Skeleton className="h-32" />
          ) : data.attention.length === 0 ? (
            <Card className="px-5 py-6 flex items-center gap-3">
              <StatusDot status="ok" />
              <div>
                <div className="text-sm text-brand-text">Todo está al día</div>
                <div className="text-xs text-brand-muted mt-0.5">No hay pedidos que necesiten tu atención ahora mismo.</div>
              </div>
            </Card>
          ) : (
            <Card className="divide-y divide-brand-border/50 overflow-hidden">
              {data.attention.map((a) => {
                const style = URGENCY_STYLE[a.urgency];
                return (
                  <button
                    key={a.type}
                    type="button"
                    onClick={() => onNavigate(a.target)}
                    className="group w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-brand-surface-2/60 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-gold/60"
                  >
                    <span className={`shrink-0 rounded border px-1.5 py-px text-[9px] font-semibold tracking-wider ${style.cls}`}>
                      {style.label}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-sm text-brand-text">
                      <span className="font-semibold tabular-nums">{a.count}</span> {a.label}
                    </span>
                    <span
                      className="shrink-0 text-xs text-brand-muted opacity-100 md:opacity-0 md:-translate-x-1 md:group-hover:opacity-100 md:group-hover:translate-x-0 transition-all duration-150"
                      aria-hidden
                    >
                      Resolver →
                    </span>
                  </button>
                );
              })}
            </Card>
          )}
        </section>

        {/* ── RENTABILIDAD (§35, §38.4): misma superficie agrupada que HOY ── */}
        <section>
          <SectionTitle
            right={
              <button
                type="button"
                onClick={() => onNavigate("finance")}
                className="text-[11px] text-brand-muted hover:text-brand-text transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 rounded"
              >
                Abrir calculadora →
              </button>
            }
          >
            Rentabilidad
          </SectionTitle>
          {!data ? (
            <Skeleton className="h-20" />
          ) : data.codModel.missingReason && data.codModel.currentDeliveryPct === null ? (
            <Card className="px-5 py-4 text-sm text-brand-muted">
              Modelo COD sin datos suficientes: {data.codModel.missingReason}.
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-brand-border/50">
                <div className="bg-brand-surface px-4 py-3.5">
                  <div className="text-[11px] uppercase tracking-wider text-brand-muted truncate">Margen actual (30d)</div>
                  <div className={`mt-1 font-display text-xl font-semibold leading-tight tabular-nums ${data.codModel.marginPct === null ? "text-brand-text" : data.codModel.marginPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {data.codModel.marginPct === null ? "—" : `${data.codModel.marginPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`}
                  </div>
                </div>
                <div className="bg-brand-surface px-4 py-3.5">
                  <div className="text-[11px] uppercase tracking-wider text-brand-muted truncate">Break-even entrega</div>
                  <div className="mt-1 font-display text-xl font-semibold leading-tight tabular-nums text-brand-text">
                    {data.codModel.breakEvenDeliveryPct === null ? "—" : `${data.codModel.breakEvenDeliveryPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`}
                  </div>
                </div>
                <div className="bg-brand-surface px-4 py-3.5">
                  <div className="text-[11px] uppercase tracking-wider text-brand-muted truncate">Entrega actual</div>
                  <div className="mt-1 font-display text-xl font-semibold leading-tight tabular-nums text-brand-text">
                    {data.codModel.currentDeliveryPct === null ? "—" : `${data.codModel.currentDeliveryPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`}
                    {data.codModel.sample > 0 && <span className="ml-1.5 text-[10px] text-brand-muted font-sans font-normal">n={data.codModel.sample}</span>}
                  </div>
                </div>
                <div className="bg-brand-surface px-4 py-3.5">
                  <div className="text-[11px] uppercase tracking-wider text-brand-muted truncate">Colchón</div>
                  <div className={`mt-1 font-display text-xl font-semibold leading-tight tabular-nums ${data.codModel.cushionPts === null ? "text-brand-text" : data.codModel.cushionPts > 5 ? "text-emerald-600" : data.codModel.cushionPts > 0 ? "text-amber-600" : "text-red-600"}`}>
                    {data.codModel.cushionPts === null ? "—" : `${data.codModel.cushionPts > 0 ? "+" : ""}${data.codModel.cushionPts.toLocaleString("es-ES", { maximumFractionDigits: 1 })} pts`}
                  </div>
                </div>
              </div>
              {(data.codModel.alert.status === "warning" || data.codModel.alert.status === "critical") && (
                <div className={`border-t border-brand-border/50 px-5 py-2.5 flex items-center gap-2 text-xs ${data.codModel.alert.status === "critical" ? "text-red-600" : "text-amber-600"}`}>
                  <StatusDot status={data.codModel.alert.status === "critical" ? "error" : "warn"} pulse={data.codModel.alert.status === "critical"} />
                  {data.codModel.alert.message}
                </div>
              )}
            </Card>
          )}
        </section>

        {/* ── ESTADO DEL NEGOCIO (§38.5): una fila por integración ── */}
        <section>
          <SectionTitle>Estado del negocio</SectionTitle>
          {!data ? (
            <Skeleton className="h-48" />
          ) : (
            <Card className="divide-y divide-brand-border/50 overflow-hidden">
              {flowSorted.map((f) => (
                <div key={f.id} className="flex items-center gap-3 px-5 py-3">
                  <StatusDot status={healthToUi(f.status)} pulse={f.status === "critical"} />
                  <span className="shrink-0 w-24 text-sm text-brand-text">{f.label}</span>
                  <span className="flex-1 min-w-0 truncate text-right text-xs text-brand-muted" title={f.message}>
                    {f.message || "—"}
                  </span>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
