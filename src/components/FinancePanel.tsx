"use client";

// ============================================================
// FINANZAS (§38–§39) — la pantalla más clara del producto.
//
// De arriba a abajo: presets de periodo → KPIs del P&L → qué falta para
// completarlo (con alta manual del gasto en ads) → cascada ingresos→costes→
// beneficio → beneficio por día → rendimiento por producto y transportista.
//
// Regla contable: el ingreso REAL solo cuenta pedidos ENTREGADOS; el coste
// se asume al ENVIAR. Nunca se pinta un número inventado: si falta un dato,
// se dice qué falta.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type {
  CourierPerformanceRow,
  FinanceDayPoint,
  FinanceOverview,
  FinancePreset,
  ProductPerformanceRow,
} from "@/lib/system/finance";
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  formatEuro,
  formatInt,
  formatPct,
  KpiTile,
  PrimaryButton,
  SectionTitle,
  Skeleton,
  STATUS_TEXT,
  type UiStatus,
} from "./ui";

const PRESET_LABELS: Array<{ preset: FinancePreset; label: string }> = [
  { preset: "today", label: "Hoy" },
  { preset: "7d", label: "7 días" },
  { preset: "30d", label: "30 días" },
  { preset: "month", label: "Mes" },
  { preset: "custom", label: "Personalizado" },
];

const DATE_INPUT_CLS =
  "rounded-lg border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-sm text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 [color-scheme:dark]";

function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** "12 días Meta · 3 manual · 2 sin dato" — sin ceros ruidosos. */
function adSourcesText(s: { meta: number; manual: number; without: number }): string {
  const parts: string[] = [];
  if (s.meta > 0) parts.push(`${s.meta} día(s) Meta`);
  if (s.manual > 0) parts.push(`${s.manual} manual`);
  if (s.without > 0) parts.push(`${s.without} sin dato`);
  return parts.length > 0 ? parts.join(" · ") : "sin días con gasto registrado";
}

/** Semáforo de la tasa de entrega: ≥70 bien, 65–70 justo, <65 mal. */
function rateStatus(rate: number | null): UiStatus {
  if (rate === null || !Number.isFinite(rate)) return "muted";
  if (rate >= 70) return "ok";
  if (rate >= 65) return "warn";
  return "error";
}

// ------------------------------------------------------------
// Cascada ingresos → costes → beneficio (CSS puro, sin librerías)
// ------------------------------------------------------------

function Waterfall({ data }: { data: FinanceOverview }) {
  const w = data.window;
  if (
    w.estimatedMargin === null ||
    w.productCost === null ||
    w.shippingCost === null ||
    w.codFees === null ||
    w.adSpend === null
  ) {
    return (
      <EmptyState
        title="Todavía no se puede dibujar la cascada"
        hint="Faltan datos del P&L en este periodo. Completa lo que se lista arriba y aparecerá aquí."
      />
    );
  }

  const rows: Array<{ label: string; value: number; kind: "in" | "cost" | "result" }> = [
    { label: "Facturación entregada", value: w.deliveredRevenue, kind: "in" },
    { label: "Producto", value: -w.productCost, kind: "cost" },
    { label: "Envío + manipulación", value: -(w.shippingCost + w.handlingCost), kind: "cost" },
    { label: "Comisión COD", value: -w.codFees, kind: "cost" },
    { label: "Publicidad", value: -w.adSpend, kind: "cost" },
    { label: "Beneficio", value: w.estimatedMargin, kind: "result" },
  ];
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const pct = Math.max(1, Math.round((Math.abs(r.value) / max) * 100));
        const barCls =
          r.kind === "in"
            ? "bg-brand-gold/85"
            : r.kind === "cost"
              ? "bg-red-500/40"
              : r.value >= 0
                ? "bg-emerald-500/85"
                : "bg-red-500/85";
        const valueCls =
          r.kind === "result" ? (r.value >= 0 ? "text-emerald-600" : "text-red-600") : "text-brand-text";
        return (
          <div key={r.label} className="flex items-center gap-3">
            <div className="w-36 md:w-44 shrink-0 text-xs text-brand-muted truncate" title={r.label}>
              {r.label}
            </div>
            <div className="flex-1 h-5 rounded-md bg-brand-surface-2 overflow-hidden">
              <div className={`h-full rounded-md ${barCls}`} style={{ width: `${pct}%` }} />
            </div>
            <div className={`w-24 shrink-0 text-right text-xs tabular-nums ${valueCls}`}>{formatEuro(r.value)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------
// Beneficio por día + tasa de entrega (SVG inline, sin librerías)
// ------------------------------------------------------------

const CHART_W = 720;
const CHART_H = 170;
const PAD_X = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;

function DailyChart({ series }: { series: FinanceDayPoint[] }) {
  if (series.length === 0) {
    return <EmptyState title="Sin días en este periodo" hint="Elige un periodo con actividad para ver la evolución." />;
  }

  const innerW = CHART_W - PAD_X * 2;
  const innerH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const margins = series.map((p) => p.margin).filter((m): m is number => m !== null);
  const maxPos = Math.max(0, ...margins);
  const minNeg = Math.min(0, ...margins);
  const range = maxPos - minNeg || 1;
  const zeroY = PAD_TOP + (maxPos / range) * innerH;
  const slot = innerW / series.length;
  const barW = Math.max(2, slot * 0.62);
  const xOf = (i: number) => PAD_X + i * slot + slot / 2;

  const maxAd = Math.max(1, ...series.map((p) => p.adSpend ?? 0));
  // Segmentos de la línea de ads: se corta en los días sin dato.
  const adSegments: string[] = [];
  let seg: string[] = [];
  series.forEach((p, i) => {
    if (p.adSpend === null) {
      if (seg.length > 1) adSegments.push(seg.join(" "));
      seg = [];
    } else {
      const y = PAD_TOP + innerH - (p.adSpend / maxAd) * innerH;
      seg.push(`${xOf(i).toFixed(1)},${y.toFixed(1)}`);
    }
  });
  if (seg.length > 1) adSegments.push(seg.join(" "));

  const labelEvery = Math.max(1, Math.ceil(series.length / 8));

  // Mini-gráfica de tasa de entrega (0–100 %), también por segmentos.
  const RATE_H = 56;
  const rateInnerH = RATE_H - 14;
  const rateSegments: string[] = [];
  let rseg: string[] = [];
  series.forEach((p, i) => {
    if (p.deliveryRate === null) {
      if (rseg.length > 1) rateSegments.push(rseg.join(" "));
      rseg = [];
    } else {
      const y = 6 + (1 - p.deliveryRate / 100) * rateInnerH;
      rseg.push(`${xOf(i).toFixed(1)},${y.toFixed(1)}`);
    }
  });
  if (rseg.length > 1) rateSegments.push(rseg.join(" "));
  const ratePoints = series
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.deliveryRate !== null);

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" role="img" aria-label="Beneficio por día">
        {/* línea de cero */}
        <line x1={PAD_X} x2={CHART_W - PAD_X} y1={zeroY} y2={zeroY} className="stroke-brand-border" strokeWidth={1} />
        {/* barras de margen */}
        {series.map((p, i) => {
          const x = xOf(i) - barW / 2;
          if (p.margin === null) {
            return (
              <rect key={p.day} x={x} y={zeroY - 2} width={barW} height={4} rx={1} className="fill-brand-muted/35">
                <title>{`${p.day} · beneficio sin calcular (faltan datos)`}</title>
              </rect>
            );
          }
          const h = Math.max(1.5, (Math.abs(p.margin) / range) * innerH);
          const y = p.margin >= 0 ? zeroY - h : zeroY;
          return (
            <rect
              key={p.day}
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={1.5}
              className={p.margin >= 0 ? "fill-emerald-400/80" : "fill-red-400/80"}
            >
              <title>{`${p.day} · beneficio ${formatEuro(p.margin)} · entregado ${formatEuro(p.deliveredRevenue)} · ads ${formatEuro(p.adSpend)}`}</title>
            </rect>
          );
        })}
        {/* línea fina dorada del gasto en ads */}
        {adSegments.map((pts, i) => (
          <polyline key={i} points={pts} fill="none" className="stroke-brand-gold" strokeWidth={1.5} strokeLinejoin="round" />
        ))}
        {/* etiquetas del eje X */}
        {series.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={p.day} x={xOf(i)} y={CHART_H - 6} textAnchor="middle" fontSize={9} className="fill-brand-muted">
              {p.day.slice(5)}
            </text>
          ) : null
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-brand-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[3px] bg-emerald-500/80" aria-hidden /> beneficio del día
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[3px] bg-red-500/80" aria-hidden /> pérdida
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-brand-gold" aria-hidden /> gasto en ads
        </span>
      </div>

      {/* Tasa de entrega por día */}
      <div className="mt-4 border-t border-brand-border pt-3">
        <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">Tasa de entrega por día</div>
        {ratePoints.length === 0 ? (
          <div className="text-xs text-brand-muted py-2">Todavía no hay pedidos resueltos en este periodo para medir la tasa.</div>
        ) : (
          <svg viewBox={`0 0 ${CHART_W} ${RATE_H}`} className="w-full" role="img" aria-label="Tasa de entrega por día">
            <line x1={PAD_X} x2={CHART_W - PAD_X} y1={6 + (1 - 0.7) * rateInnerH} y2={6 + (1 - 0.7) * rateInnerH} className="stroke-brand-border" strokeWidth={1} strokeDasharray="3 3">
              <title>Referencia: 70 %</title>
            </line>
            {rateSegments.map((pts, i) => (
              <polyline key={i} points={pts} fill="none" className="stroke-sky-400" strokeWidth={1.5} strokeLinejoin="round" />
            ))}
            {ratePoints.map(({ p, i }) => (
              <circle key={p.day} cx={xOf(i)} cy={6 + (1 - (p.deliveryRate as number) / 100) * rateInnerH} r={2.5} className="fill-sky-400">
                <title>{`${p.day} · tasa ${formatPct(p.deliveryRate)} (${p.delivered} entregados, ${p.refused} rehusados)`}</title>
              </circle>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Tablas por producto y por transportista (tabla en md+, tarjetas en móvil)
// ------------------------------------------------------------

const TH_CLS = "px-4 py-2.5 font-medium";
const TD_NUM = "px-4 py-3 text-right tabular-nums text-brand-text";

function ProductTable({ rows }: { rows: ProductPerformanceRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Sin envíos en este periodo" hint="Cuando salga el primer pedido aparecerá aquí su rendimiento." />;
  }
  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
              <th className={TH_CLS}>Producto</th>
              <th className={`${TH_CLS} text-right`}>Enviados</th>
              <th className={`${TH_CLS} text-right`}>Entregados</th>
              <th className={`${TH_CLS} text-right`}>Tasa entrega</th>
              <th className={`${TH_CLS} text-right`}>Facturación entregada</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border">
            {rows.map((p) => (
              <tr key={p.sku}>
                <td className="px-4 py-3">
                  <div className="text-brand-text">{p.title || "—"}</div>
                  <div className="text-[11px] text-brand-muted">{p.sku}</div>
                </td>
                <td className={TD_NUM}>{formatInt(p.shipped)}</td>
                <td className={TD_NUM}>{formatInt(p.delivered)}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${STATUS_TEXT[rateStatus(p.deliveryRate)]}`}>
                  {formatPct(p.deliveryRate)}
                </td>
                <td className={TD_NUM}>{formatEuro(p.deliveredRevenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden divide-y divide-brand-border">
        {rows.map((p) => (
          <div key={p.sku} className="px-4 py-3">
            <div className="text-sm text-brand-text">{p.title || "—"}</div>
            <div className="text-[11px] text-brand-muted">{p.sku}</div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-brand-muted">Enviados</span>
              <span className="text-right tabular-nums text-brand-text">{formatInt(p.shipped)}</span>
              <span className="text-brand-muted">Entregados</span>
              <span className="text-right tabular-nums text-brand-text">{formatInt(p.delivered)}</span>
              <span className="text-brand-muted">Tasa entrega</span>
              <span className={`text-right tabular-nums ${STATUS_TEXT[rateStatus(p.deliveryRate)]}`}>{formatPct(p.deliveryRate)}</span>
              <span className="text-brand-muted">Facturación entregada</span>
              <span className="text-right tabular-nums text-brand-text">{formatEuro(p.deliveredRevenue)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CourierTable({ rows }: { rows: CourierPerformanceRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Sin envíos con transportista en este periodo" hint="Cuando un pedido salga con transportista asignado aparecerá aquí." />;
  }
  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
              <th className={TH_CLS}>Transportista</th>
              <th className={`${TH_CLS} text-right`}>Enviados</th>
              <th className={`${TH_CLS} text-right`}>Entregados</th>
              <th className={`${TH_CLS} text-right`}>Rehusados</th>
              <th className={`${TH_CLS} text-right`}>Tasa</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border">
            {rows.map((c) => (
              <tr key={c.carrier}>
                <td className="px-4 py-3 text-brand-text">{c.carrier}</td>
                <td className={TD_NUM}>{formatInt(c.shipped)}</td>
                <td className={TD_NUM}>{formatInt(c.delivered)}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${c.refused > 0 ? "text-amber-600" : "text-brand-text"}`}>
                  {formatInt(c.refused)}
                </td>
                <td className={`px-4 py-3 text-right tabular-nums ${STATUS_TEXT[rateStatus(c.deliveryRate)]}`}>
                  {formatPct(c.deliveryRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="md:hidden divide-y divide-brand-border">
        {rows.map((c) => (
          <div key={c.carrier} className="px-4 py-3">
            <div className="text-sm text-brand-text">{c.carrier}</div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-brand-muted">Enviados</span>
              <span className="text-right tabular-nums text-brand-text">{formatInt(c.shipped)}</span>
              <span className="text-brand-muted">Entregados</span>
              <span className="text-right tabular-nums text-brand-text">{formatInt(c.delivered)}</span>
              <span className="text-brand-muted">Rehusados</span>
              <span className={`text-right tabular-nums ${c.refused > 0 ? "text-amber-600" : "text-brand-text"}`}>{formatInt(c.refused)}</span>
              <span className="text-brand-muted">Tasa</span>
              <span className={`text-right tabular-nums ${STATUS_TEXT[rateStatus(c.deliveryRate)]}`}>{formatPct(c.deliveryRate)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------
// Panel principal
// ------------------------------------------------------------

export default function FinancePanel() {
  const [preset, setPreset] = useState<FinancePreset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Alta manual del gasto en ads (fallback de §39)
  const [adDay, setAdDay] = useState(todayIso);
  const [adAmount, setAdAmount] = useState("");
  const [savingAd, setSavingAd] = useState(false);
  const [adMsg, setAdMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      let qs = `preset=${preset}`;
      if (preset === "custom") {
        if (!customFrom || !customTo) return; // rango a medias: esperamos a que elija las dos fechas
        const from = Math.floor(new Date(`${customFrom}T00:00:00`).getTime() / 1000);
        const to = Math.floor(new Date(`${customTo}T23:59:59`).getTime() / 1000);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return;
        qs += `&from=${from}&to=${to}`;
      }
      const res = await fetch(`/api/finance?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { ok: boolean; data?: FinanceOverview; error?: string };
      if (!j.ok || !j.data) throw new Error(j.error ?? "respuesta inválida");
      setData(j.data);
      setError(null);
    } catch {
      setError("No se pudieron cargar las finanzas.");
    }
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const saveAdSpend = useCallback(async () => {
    const amount = Number.parseFloat(adAmount.replace(",", "."));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(adDay) || !Number.isFinite(amount) || amount < 0) {
      setAdMsg("Revisa la fecha y el importe antes de guardar.");
      return;
    }
    setSavingAd(true);
    setAdMsg(null);
    try {
      const res = await fetch("/api/finance", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: adDay, amount }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? "no se pudo guardar");
      setAdAmount("");
      setAdMsg("Gasto guardado. Cifras actualizadas.");
      await refresh();
    } catch {
      setAdMsg("No se pudo guardar el gasto. Inténtalo otra vez.");
    } finally {
      setSavingAd(false);
    }
  }, [adDay, adAmount, refresh]);

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  const w = data?.window;
  const missingMentionsAds = (data?.window.missing ?? []).some((m) => {
    const t = m.toLowerCase();
    return t.includes("ads") || t.includes("gasto") || t.includes("publicidad");
  });

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-7">
        {/* ── Cabecera: título + presets ── */}
        <section>
          <SectionTitle
            right={
              <div className="flex flex-wrap justify-end gap-1.5">
                {PRESET_LABELS.map(({ preset: p, label }) => (
                  <Chip key={p} active={preset === p} onClick={() => setPreset(p)}>
                    {label}
                  </Chip>
                ))}
              </div>
            }
          >
            Finanzas
          </SectionTitle>
          {preset === "custom" ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-brand-muted">
              <span>Desde</span>
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className={DATE_INPUT_CLS}
                aria-label="Fecha de inicio"
              />
              <span>hasta</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className={DATE_INPUT_CLS}
                aria-label="Fecha de fin"
              />
              {!customFrom || !customTo ? <span className="text-xs">Elige las dos fechas para ver el periodo.</span> : null}
            </div>
          ) : null}

          {/* ── KPIs del P&L ── */}
          {!data || !w ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-[84px]" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <KpiTile
                label="Facturación pedidos"
                value={formatEuro(w.grossRevenue)}
                support={`${formatInt(w.shippedOrders)} enviados`}
              />
              <KpiTile
                label="Facturación entregada"
                value={formatEuro(w.deliveredRevenue)}
                support={`${formatInt(w.deliveredOrders)} entregados — ingreso REAL`}
              />
              <KpiTile
                label="Publicidad"
                value={formatEuro(w.adSpend)}
                status={w.adSpend === null ? "warn" : undefined}
                support={w.adSpend === null ? "sin dato de gasto" : adSourcesText(data.adSpendSources)}
              />
              <KpiTile
                label="Producto"
                value={formatEuro(w.productCost)}
                support={w.productCost === null ? "faltan costes de SKU" : "coste asumido al enviar"}
              />
              <KpiTile
                label="Envío + manipulación"
                value={w.shippingCost === null ? "—" : formatEuro(w.shippingCost + w.handlingCost)}
                support={w.shippingCost === null ? "faltan costes de envío por SKU" : "incluye manipulación"}
              />
              <KpiTile
                label="Retornos"
                value={formatInt(data.closure.refused)}
                status={data.closure.refused > 0 ? "warn" : undefined}
                support="rehusados (~9,37 € cada uno)"
              />
              <KpiTile
                label="Coste por entregado"
                value={formatEuro(data.costPerDelivered)}
                support={data.costPerDelivered === null ? "incompleto: faltan costes o entregas" : "todo el coste ÷ entregados"}
              />
              <KpiTile label="Llamadas / IA" value="—" support="sin coste registrado aún" />
              <KpiTile
                label="Beneficio"
                value={formatEuro(w.estimatedMargin)}
                status={w.estimatedMargin === null ? undefined : w.estimatedMargin >= 0 ? "ok" : "error"}
                support={w.estimatedMargin === null ? `incompleto: ${w.missing[0] ?? "faltan datos"}` : "entregado menos todos los costes"}
              />
              <KpiTile
                label="Margen"
                value={formatPct(w.estimatedMarginPct)}
                status={w.estimatedMarginPct === null ? undefined : w.estimatedMarginPct >= 0 ? "ok" : "error"}
                support="sobre facturación de pedidos"
              />
            </div>
          )}
        </section>

        {/* ── Qué falta para completar el P&L ── */}
        {data && w && w.missing.length > 0 ? (
          <section>
            <Card className="border-amber-500/40 px-5 py-4">
              <div className="text-sm font-semibold text-amber-600">Para completar el beneficio falta:</div>
              <ul className="mt-2 space-y-1">
                {w.missing.map((m) => (
                  <li key={m} className="text-xs text-brand-muted">
                    · {m}
                  </li>
                ))}
              </ul>
              {missingMentionsAds ? (
                <div className="mt-4 border-t border-brand-border pt-3">
                  <div className="text-xs font-semibold text-brand-text mb-2">Apuntar gasto en ads a mano</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      value={adDay}
                      onChange={(e) => setAdDay(e.target.value)}
                      className={DATE_INPUT_CLS}
                      aria-label="Día del gasto"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      placeholder="Importe en €"
                      value={adAmount}
                      onChange={(e) => setAdAmount(e.target.value)}
                      className={`${DATE_INPUT_CLS} w-32`}
                      aria-label="Importe del gasto en euros"
                    />
                    <PrimaryButton onClick={saveAdSpend} busy={savingAd} disabled={!adAmount}>
                      Guardar gasto
                    </PrimaryButton>
                  </div>
                  {adMsg ? <div className="mt-2 text-xs text-brand-muted">{adMsg}</div> : null}
                  <div className="mt-2 text-[11px] text-brand-muted">
                    El gasto con fuente Meta API sustituye al manual del mismo día.
                  </div>
                </div>
              ) : null}
            </Card>
          </section>
        ) : null}

        {/* ── Cascada ingresos → costes → beneficio ── */}
        <section>
          <SectionTitle>Ingresos → costes → beneficio</SectionTitle>
          {!data ? (
            <Skeleton className="h-48" />
          ) : (
            <Card className="p-4">
              <Waterfall data={data} />
            </Card>
          )}
        </section>

        {/* ── Beneficio por día ── */}
        <section>
          <SectionTitle>Beneficio por día</SectionTitle>
          {!data ? (
            <Skeleton className="h-56" />
          ) : (
            <Card className="p-4">
              <DailyChart series={data.series} />
            </Card>
          )}
        </section>

        {/* ── Por producto ── */}
        <section>
          <SectionTitle>Por producto</SectionTitle>
          {!data ? (
            <Skeleton className="h-40" />
          ) : (
            <Card className="overflow-hidden">
              <ProductTable rows={data.products} />
            </Card>
          )}
        </section>

        {/* ── Por transportista ── */}
        <section>
          <SectionTitle>Por transportista</SectionTitle>
          {!data ? (
            <Skeleton className="h-40" />
          ) : (
            <Card className="overflow-hidden">
              <CourierTable rows={data.couriers} />
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
