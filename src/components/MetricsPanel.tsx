"use client";

import { useEffect, useState } from "react";

interface DayBucket {
  day: string;
  convos: number;
  userMsgs: number;
  botMsgs: number;
  leads: number;
  costUsd: number;
}
interface Duda {
  tema: string;
  count: number;
  pct: number;
  ejemplo?: string;
}
interface AnalyticsResponse {
  rangeDays: number;
  days: DayBucket[];
  totals: {
    convos: number;
    userMsgs: number;
    botMsgs: number;
    leads: number;
    leadsConEmail: number;
    costUsd: number;
    inTokens: number;
    outTokens: number;
    avgRespSec: number | null;
  };
  funnel: { escribieron: number; email: number; enlace: number };
  dudas: Duda[];
}

function money(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0,01";
  return "$" + usd.toFixed(2).replace(".", ",");
}
function fmtDay(d: string): string {
  const [, m, day] = d.split("-");
  return `${parseInt(day, 10)}/${parseInt(m, 10)}`;
}
function respTime(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-brand-border bg-brand-surface/70 px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wider text-brand-muted">{label}</div>
      <div className="font-display text-3xl font-bold text-brand-text mt-1 leading-none">{value}</div>
      {sub && <div className="text-[11px] text-brand-muted mt-1.5">{sub}</div>}
    </div>
  );
}

// Barras verticales apiladas (lead vs agente) por día
function ActivityChart({ data }: { data: DayBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.userMsgs + d.botMsgs));
  const step = Math.ceil(data.length / 8);
  return (
    <div className="rounded-xl border border-brand-border bg-brand-surface/70 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] uppercase tracking-wider text-brand-muted">Mensajes por día</div>
        <div className="flex items-center gap-3 text-[11px] text-brand-muted">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-brand-gold" />Agente</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-brand-muted" />Lead</span>
        </div>
      </div>
      <div className="relative h-44 flex items-end gap-1.5">
        {data.map((d, i) => {
          const total = d.userMsgs + d.botMsgs;
          const h = (total / max) * 100;
          const botH = total ? (d.botMsgs / total) * 100 : 0;
          return (
            <div
              key={d.day}
              className="flex-1 h-full flex flex-col justify-end items-center relative"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {hover === i && (
                <div className="absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-lg border border-brand-border bg-brand-bg px-2.5 py-1.5 text-[11px] shadow-xl">
                  <div className="text-brand-text font-semibold">{fmtDay(d.day)}</div>
                  <div className="text-brand-gold">{d.botMsgs} del agente</div>
                  <div className="text-brand-muted">{d.userMsgs} del lead</div>
                  {d.leads > 0 && <div className="text-wa-green">{d.leads} lead(s)</div>}
                </div>
              )}
              <div className="w-full rounded-t-[4px] overflow-hidden flex flex-col" style={{ height: `${h}%` }}>
                <div className="bg-brand-gold" style={{ height: `${botH}%` }} />
                <div className="bg-brand-muted/60 mt-[2px] flex-1" />
              </div>
              <div className="text-[9px] text-brand-muted mt-1 h-3">
                {i % step === 0 ? fmtDay(d.day) : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Funnel({ f }: { f: { escribieron: number; email: number; enlace: number } }) {
  const max = Math.max(1, f.escribieron);
  const rows = [
    { label: "Escribieron", n: f.escribieron, note: "" },
    { label: "Dejaron su email", n: f.email, note: f.escribieron ? `${Math.round((f.email / f.escribieron) * 100)}%` : "" },
    { label: "Recibieron el enlace", n: f.enlace, note: f.escribieron ? `${Math.round((f.enlace / f.escribieron) * 100)}%` : "" },
  ];
  return (
    <div className="rounded-xl border border-brand-border bg-brand-surface/70 p-4">
      <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-3">Embudo de conversión</div>
      <div className="space-y-2.5">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-brand-text">{r.label}</span>
              <span className="text-brand-muted">
                <span className="text-brand-text font-semibold">{r.n}</span> {r.note && `· ${r.note}`}
              </span>
            </div>
            <div className="h-3 rounded-[4px] bg-brand-bg overflow-hidden">
              <div
                className="h-full rounded-[4px] bg-gradient-to-r from-brand-gold-soft to-brand-gold"
                style={{ width: `${(r.n / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DudasList({ dudas, loading }: { dudas: Duda[]; loading: boolean }) {
  const max = Math.max(1, ...dudas.map((d) => d.count));
  return (
    <div className="rounded-xl border border-brand-border bg-brand-surface/70 p-4">
      <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-3">
        Dudas más frecuentes <span className="text-brand-gold/70">· IA</span>
      </div>
      {loading && <div className="text-sm text-brand-muted py-6 text-center">Analizando conversaciones…</div>}
      {!loading && dudas.length === 0 && (
        <div className="text-sm text-brand-muted py-6 text-center">
          Aún no hay suficientes mensajes para detectar dudas.
        </div>
      )}
      <div className="space-y-3">
        {dudas.map((d) => (
          <div key={d.tema}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-brand-text font-medium">{d.tema}</span>
              <span className="text-brand-muted">{d.count} · {d.pct}%</span>
            </div>
            <div className="h-2 rounded-[4px] bg-brand-bg overflow-hidden">
              <div className="h-full rounded-[4px] bg-brand-gold" style={{ width: `${(d.count / max) * 100}%` }} />
            </div>
            {d.ejemplo && <div className="text-[11px] text-brand-muted italic mt-1">“{d.ejemplo}”</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MetricsPanel() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetch(`/api/analytics?days=${days}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (mounted) setData(j);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [days]);

  const dayBuckets: DayBucket[] = Array.isArray(data?.days) ? data.days : [];
  const totals = data?.totals;
  const funnel = data?.funnel ?? { escribieron: 0, email: 0, enlace: 0 };
  const dudas = data?.dudas ?? [];

  return (
    <section className="h-full overflow-y-auto p-5 bg-brand-bg/30">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Rango */}
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-bold text-brand-text">Métricas del agente</h2>
          <div className="inline-flex rounded-lg border border-brand-border p-0.5 bg-brand-bg">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  days === d ? "bg-brand-gold text-black" : "text-brand-muted hover:text-brand-text"
                }`}
              >
                {d} días
              </button>
            ))}
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label="Leads guardados" value={String(totals?.leads ?? 0)} sub={`${totals?.leadsConEmail ?? 0} con email`} />
          <StatTile label="Conversaciones" value={String(totals?.convos ?? 0)} />
          <StatTile label="Mensajes" value={String((totals?.userMsgs ?? 0) + (totals?.botMsgs ?? 0))} sub={`${totals?.botMsgs ?? 0} del agente`} />
          <StatTile label="Coste IA" value={money(totals?.costUsd ?? 0)} sub={`${(((totals?.inTokens ?? 0) + (totals?.outTokens ?? 0)) / 1000).toFixed(0)}k tokens`} />
          <StatTile label="Resp. media" value={respTime(totals?.avgRespSec ?? null)} sub="incluye la espera" />
        </div>

        {/* Actividad */}
        <ActivityChart data={dayBuckets} />

        {/* Embudo + Dudas */}
        <div className="grid md:grid-cols-2 gap-4">
          <Funnel f={funnel} />
          <DudasList dudas={dudas} loading={loading} />
        </div>

        <div className="text-[11px] text-brand-muted text-center pt-2">
          El consumo y los leads se registran desde que se activó el panel. El coste es una estimación por tokens.
        </div>
      </div>
    </section>
  );
}
