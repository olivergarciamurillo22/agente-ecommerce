"use client";

// ============================================================
// INICIO v4 (§6): centro de decisiones. En diez segundos: qué pasa hoy,
// cuánto dinero está en riesgo, qué requiere atención (con importe y CTA),
// si el sistema funciona, y una actividad reciente compacta.
// Sin métricas de ingeniería. Sin cifras inventadas: lo que falta lo dice.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DockView } from "./NavRail";
import { Card, ErrorState, formatEuro, formatInt, healthToUi, SectionTitle, Skeleton, StatusDot, STATUS_TEXT, timeAgo, type UiStatus } from "./ui";

interface FlowNode { id: string; label: string; status: string; message: string }
interface AttentionItem { type: string; count: number; label: string; urgency: "urgent" | "today" | "later"; target: DockView }
interface HomeData {
  ok: boolean;
  today: { orders: number; confirmed: number; awaitingCustomer: number; needsCall: number; deliveredToday: number; grossRevenue: number; deliveredRevenue: number; estimatedMargin: number | null; marginMissing: string[]; adSpend: number | null };
  attention: AttentionItem[];
  attentionTotal: number;
  flow: FlowNode[];
  beepingCutoff: { shipsToday: boolean; minutesLeft: number | null; message: string };
  codModel: { marginPct: number | null; breakEvenDeliveryPct: number | null; currentDeliveryPct: number | null; cushionPts: number | null; sample: number; missingReason: string | null; alert: { status: string; message: string } };
  extras?: {
    today: { totalAmount: number; revenueAtRisk: number; revenueAtRiskOrders: number };
    yesterday: { orders: number; confirmed: number; totalAmount: number } | null;
    attentionAmounts: Record<string, { orders: number; amount: number }>;
    recentActivity: Array<{ at: number; integration: string; type: string; message: string; orderRef: string | null; severity: string }>;
  };
}

const URGENCY: Record<AttentionItem["urgency"], { label: string; status: UiStatus }> = {
  urgent: { label: "Urgente", status: "error" },
  today: { label: "Hoy", status: "warn" },
  later: { label: "Después", status: "muted" },
};

/** Por qué importa cada tipo de atención (§6): una frase, no un log. */
const WHY: Record<string, string> = {
  CANCEL_REQUEST: "Un cliente esperando respuesta se convierte en rehúse (~9 € cada uno).",
  POSSIBLE_DUPLICATE: "Dos envíos del mismo pedido = dos costes de envío y un cliente enfadado.",
  TRACKING_INCIDENT: "El transportista no puede entregar: sin acción, vuelve al origen.",
  NEEDS_CALL: "Sin confirmación no hay envío; cada hora baja la tasa de respuesta.",
  ADDRESS_CORRECTION: "Una dirección sin verificar es un intento de entrega perdido.",
  SUPPLIER_ERROR: "El pedido no ha salido hacia el proveedor.",
  BEEPING_AWAITING_RELEASE: "Confirmados que no llegarán al corte de hoy si no se liberan.",
  BEEPING_AMBIGUOUS: "No sabemos si el almacén lo recibió: hay que consultar antes de repetir.",
};
const CTA: Record<string, string> = {
  CANCEL_REQUEST: "Resolver",
  POSSIBLE_DUPLICATE: "Revisar",
  TRACKING_INCIDENT: "Ver envío",
  NEEDS_CALL: "Llamar",
  ADDRESS_CORRECTION: "Revisar dirección",
  SUPPLIER_ERROR: "Ver error",
  BEEPING_AWAITING_RELEASE: "Enviar a Beeping",
  BEEPING_AMBIGUOUS: "Consultar",
};
const FLOW_ORDER = ["shopify", "whatsapp", "calls", "beeping", "dropea", "meta_ads"];

function greeting(): string {
  const h = new Date().getHours();
  return h >= 6 && h < 14 ? "Buenos días" : h >= 14 && h < 21 ? "Buenas tardes" : "Buenas noches";
}
function todayLabel(): string {
  const t = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function Delta({ now, before }: { now: number; before: number }) {
  if (before <= 0) return null;
  const d = now - before;
  const pct = Math.round((d / before) * 100);
  const status: UiStatus = d > 0 ? "ok" : d < 0 ? "warn" : "muted";
  return (
    <span className={`text-[11px] tabular-nums ${STATUS_TEXT[status]}`} title="Comparado con ayer a esta misma hora">
      {d > 0 ? "▲" : d < 0 ? "▼" : "="} {Math.abs(pct)}% vs ayer
    </span>
  );
}

function Kpi({ label, value, support, status }: { label: string; value: ReactNode; support?: ReactNode; status?: UiStatus }) {
  return (
    <div className="bg-brand-surface px-4 py-4">
      <div className="text-[12px] text-brand-muted">{label}</div>
      <div className={`mt-1 font-display text-[22px] font-semibold leading-tight tabular-nums ${status ? STATUS_TEXT[status] : "text-brand-text"}`}>{value}</div>
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
      setError("No se pudo cargar el resumen.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  const flow = data ? [...data.flow].sort((a, b) => FLOW_ORDER.indexOf(a.id) - FLOW_ORDER.indexOf(b.id)) : [];
  const systemOk = flow.every((f) => f.status !== "critical");
  const ex = data?.extras;

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-6 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* ── Saludo + estado del sistema (§6, bloque 1) ── */}
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
          <div>
            <h1 className="font-display text-[28px] md:text-[34px] font-semibold text-brand-text leading-tight">{greeting()}, Pedro.</h1>
            <p className="mt-1 text-sm text-brand-muted">{todayLabel()}</p>
          </div>
          {data && (
            <div className="flex flex-wrap gap-2" aria-label="Estado del sistema">
              {flow.filter((f) => ["shopify", "whatsapp", "calls", "beeping"].includes(f.id)).map((f) => (
                <span key={f.id} className="inline-flex items-center gap-1.5 rounded-full border border-brand-border bg-brand-surface px-2.5 py-1 text-[12px] text-brand-text" title={f.message}>
                  <StatusDot status={healthToUi(f.status)} pulse={f.status === "critical"} />
                  {f.id === "calls" ? "Llamadas" : f.label}
                </span>
              ))}
            </div>
          )}
        </header>

        {/* ── KPIs (§6) ── */}
        <section>
          <SectionTitle right={data ? <span className="text-[11px] text-brand-muted">Beeping: {data.beepingCutoff.message}</span> : null}>Hoy</SectionTitle>
          {!data ? (
            <Skeleton className="h-48" />
          ) : (
            <Card className="overflow-hidden">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-brand-border">
                <Kpi label="Pedidos" value={formatInt(data.today.orders)} support={ex?.yesterday ? <Delta now={data.today.orders} before={ex.yesterday.orders} /> : "primer día con datos"} />
                <Kpi label="Importe total" value={formatEuro(ex?.today.totalAmount ?? null)} support={ex?.yesterday ? <Delta now={ex.today.totalAmount} before={ex.yesterday.totalAmount} /> : undefined} />
                <Kpi label="Confirmados" value={formatInt(data.today.confirmed)} status={data.today.confirmed > 0 ? "ok" : undefined} support={ex?.yesterday ? <Delta now={data.today.confirmed} before={ex.yesterday.confirmed} /> : undefined} />
                <Kpi label="Pendientes" value={formatInt(data.today.awaitingCustomer)} support="esperando respuesta" />
                <Kpi label="Necesitan llamada" value={formatInt(data.today.needsCall)} status={data.today.needsCall > 0 ? "warn" : undefined} />
                <Kpi
                  label="Dinero en riesgo"
                  value={formatEuro(ex?.today.revenueAtRisk ?? null)}
                  status={(ex?.today.revenueAtRisk ?? 0) > 0 ? "warn" : "ok"}
                  support={ex ? `${formatInt(ex.today.revenueAtRiskOrders)} pedidos sin confirmar o con problema` : undefined}
                />
              </div>
            </Card>
          )}
        </section>

        {/* ── Lo que necesita tu atención (§6) ── */}
        <section>
          <SectionTitle right={data && data.attentionTotal > 0 ? <span className="text-[11px] text-brand-muted">{formatInt(data.attentionTotal)} elementos</span> : null}>Lo que necesita tu atención</SectionTitle>
          {!data ? (
            <Skeleton className="h-36" />
          ) : data.attention.length === 0 ? (
            <Card className="px-5 py-6 flex items-center gap-3">
              <StatusDot status="ok" />
              <div>
                <div className="text-sm font-medium text-brand-text">No hay nada que necesite tu atención.</div>
                <div className="text-xs text-brand-muted">Cuando un pedido pida una decisión tuya, aparecerá aquí con su importe y la acción recomendada.</div>
              </div>
            </Card>
          ) : (
            <Card className="divide-y divide-brand-border">
              {data.attention.map((a) => {
                const u = URGENCY[a.urgency];
                const money = ex?.attentionAmounts[a.type];
                return (
                  <div key={a.type} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3.5">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <StatusDot status={u.status} pulse={a.urgency === "urgent"} />
                      <div className="min-w-0">
                        <div className="text-sm text-brand-text">
                          <span className="font-semibold tabular-nums">{a.count}</span> {a.label}
                          <span className="ml-2 text-[11px] uppercase tracking-wider text-brand-muted">{u.label}</span>
                        </div>
                        <div className="text-xs text-brand-muted mt-0.5">{WHY[a.type] ?? "Requiere una decisión tuya."}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between sm:justify-end gap-4 sm:pl-3">
                      {money && <span className="text-sm text-brand-text tabular-nums" title="Importe de los pedidos afectados">{formatEuro(money.amount)}</span>}
                      <button
                        type="button"
                        onClick={() => onNavigate(a.target)}
                        className="h-10 rounded-xl bg-brand-gold px-4 text-sm font-semibold text-white hover:bg-brand-gold-soft transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/50"
                      >
                        {CTA[a.type] ?? "Ver"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </Card>
          )}
        </section>

        {/* ── Rentabilidad (modelo COD) ── */}
        <section>
          <SectionTitle right={<button type="button" onClick={() => onNavigate("finance")} className="h-10 -my-2 px-3 rounded-lg text-[12px] font-medium text-brand-gold hover:bg-brand-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/50">Ver Growth →</button>}>Rentabilidad</SectionTitle>
          {!data ? (
            <Skeleton className="h-24" />
          ) : (
            <Card className="overflow-hidden">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-brand-border">
                <Kpi label="Cobrado hoy" value={formatEuro(data.today.deliveredRevenue)} support="pedidos entregados" />
                <Kpi label="Publicidad hoy" value={formatEuro(data.today.adSpend)} support={data.today.adSpend === null ? "sin dato del día" : undefined} />
                <Kpi label="Margen 30 días" value={data.codModel.marginPct === null ? "—" : `${data.codModel.marginPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })}%`} status={data.codModel.marginPct === null ? undefined : data.codModel.marginPct >= 0 ? "ok" : "error"} support={data.codModel.marginPct === null ? (data.today.marginMissing[0] ?? "faltan datos") : undefined} />
                <Kpi label="Entrega vs break-even" value={data.codModel.cushionPts === null ? "—" : `${data.codModel.cushionPts > 0 ? "+" : ""}${data.codModel.cushionPts.toLocaleString("es-ES", { maximumFractionDigits: 1 })} pts`} status={data.codModel.cushionPts === null ? undefined : data.codModel.cushionPts > 5 ? "ok" : data.codModel.cushionPts > 0 ? "warn" : "error"} support={data.codModel.currentDeliveryPct === null ? (data.codModel.missingReason ?? undefined) : `entrega ${data.codModel.currentDeliveryPct}% · n=${data.codModel.sample}`} />
              </div>
            </Card>
          )}
        </section>

        {/* ── Estado del negocio + actividad reciente ── */}
        <section className="grid md:grid-cols-2 gap-6">
          <div>
            <SectionTitle>Estado del sistema</SectionTitle>
            {!data ? (
              <Skeleton className="h-40" />
            ) : (
              <Card className="divide-y divide-brand-border">
                {flow.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                    <StatusDot status={healthToUi(f.status)} pulse={f.status === "critical"} />
                    <span className="text-sm text-brand-text w-20 sm:w-24 shrink-0">{f.id === "calls" ? "Llamadas" : f.label}</span>
                    <span className="min-w-0 flex-1 text-xs text-brand-muted truncate" title={f.message}>{f.message || "—"}</span>
                  </div>
                ))}
                {!systemOk && (
                  <button type="button" onClick={() => onNavigate("settings")} className="w-full text-left px-4 h-11 text-xs text-brand-gold hover:bg-brand-surface-2 rounded-b-2xl">Ver detalles en Ajustes →</button>
                )}
              </Card>
            )}
          </div>
          <div>
            <SectionTitle>Actividad reciente</SectionTitle>
            {!data ? (
              <Skeleton className="h-40" />
            ) : !ex || ex.recentActivity.length === 0 ? (
              <Card className="px-4 py-6 text-sm text-brand-muted">Sin actividad registrada todavía.</Card>
            ) : (
              <Card className="divide-y divide-brand-border">
                {ex.recentActivity.map((e, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                    <StatusDot status={e.severity === "critical" ? "error" : e.severity === "warning" ? "warn" : "muted"} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-brand-text break-words">{e.orderRef ? <span className="font-mono">#{e.orderRef} · </span> : null}{e.message}</div>
                      <div className="text-[11px] text-brand-muted">{e.integration} · {timeAgo(e.at)}</div>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
