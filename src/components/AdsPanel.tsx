"use client";

// ============================================================
// ANUNCIOS (§32) — Meta Ads sin métricas de vanidad:
//   1. Cabecera: última sincronización + sync manual + rango.
//   2. KPIs que relacionan gasto con PEDIDOS (atribución temporal).
//   3. Serie diaria de gasto (SVG propio, sin librerías).
//   4. Tabla de campañas (solo métricas de coste/alcance reales).
// Regla de honestidad: NO hay conversión por campaña — el dato no existe.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  formatEuro,
  formatInt,
  formatPct,
  GhostButton,
  KpiTile,
  SectionTitle,
  Skeleton,
  SkeletonRows,
  timeAgo,
  type UiStatus,
} from "./ui";

interface AdsHealth {
  status: string;
  configured: boolean;
  lastSyncAt: number | null;
  message: string;
}

interface AdsHeader {
  days: number;
  spendToday: number | null;
  spendRange: number | null;
  ordersRange: number;
  deliveredRange: number;
  cpaOrder: number | null;
  cpaDelivered: number | null;
  grossRoas: number | null;
  netRoas: number | null;
}

interface AdsCampaign {
  id: string;
  name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
}

interface AdsDailyPoint {
  day: string;
  spend: number | null;
  impressions: number;
  clicks: number;
}

interface CampaignEcoRow {
  campaignId: string | null;
  campaignName: string;
  attribution: "direct_id" | "name_match";
  spend: number | null;
  orders: number;
  confirmed: number;
  delivered: number;
  deliveredRevenue: number;
  cpaOrder: number | null;
  cpaDelivered: number | null;
  grossRoas: number | null;
  netRoas: number | null;
}

interface CampaignEconomics {
  attributionCoveragePct: number;
  campaignCoveragePct: number;
  totalOrders: number;
  campaigns: CampaignEcoRow[];
  unattributed: { orders: number; confirmed: number; delivered: number; deliveredRevenue: number };
}

interface AdsData {
  ok: boolean;
  health: AdsHealth;
  header: AdsHeader;
  campaigns: AdsCampaign[];
  daily: AdsDailyPoint[];
  campaignEconomics?: CampaignEconomics;
}

const RANGES = [7, 14, 30] as const;

function netRoasStatus(v: number | null): UiStatus | undefined {
  if (v === null || !Number.isFinite(v)) return undefined;
  if (v >= 2) return "ok";
  if (v >= 1) return "warn";
  return "error";
}

/** "2026-09-01" → "1 sep" para las etiquetas del eje. */
function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

// --- Gráfica de gasto diario: SVG a mano, barras doradas ---

function SpendChart({ daily }: { daily: AdsDailyPoint[] }) {
  const W = 600;
  const H = 140;
  const LABEL_H = 18;
  const max = Math.max(...daily.map((d) => d.spend ?? 0), 0.01);
  const n = daily.length;
  const slot = W / n;
  const barW = Math.max(2, Math.min(38, slot * 0.66));
  // Etiquetas dispersas: primera, última y un paso intermedio.
  const step = Math.max(1, Math.ceil(n / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H + LABEL_H}`} className="w-full" role="img" aria-label="Gasto diario en anuncios">
      <line x1={0} y1={H} x2={W} y2={H} className="stroke-brand-border" strokeWidth={1} />
      {daily.map((d, i) => {
        const h = d.spend != null ? Math.max(d.spend > 0 ? 2 : 0, (d.spend / max) * (H - 10)) : 0;
        const x = i * slot + (slot - barW) / 2;
        const showLabel = i % step === 0 || i === n - 1;
        return (
          <g key={d.day}>
            <rect
              x={x}
              y={H - h}
              width={barW}
              height={h}
              rx={2}
              fill="currentColor"
              className="text-brand-gold"
            >
              <title>
                {`${shortDay(d.day)}: ${d.spend != null ? formatEuro(d.spend) : "sin dato"} · ${formatInt(d.clicks)} clics`}
              </title>
            </rect>
            {/* Zona de hover a toda altura para que el tooltip salga también en barras bajas */}
            <rect x={i * slot} y={0} width={slot} height={H} fill="transparent">
              <title>
                {`${shortDay(d.day)}: ${d.spend != null ? formatEuro(d.spend) : "sin dato"} · ${formatInt(d.clicks)} clics`}
              </title>
            </rect>
            {showLabel ? (
              <text
                x={i * slot + slot / 2}
                y={H + LABEL_H - 5}
                textAnchor="middle"
                fontSize={10}
                fill="currentColor"
                className="text-brand-muted"
              >
                {shortDay(d.day)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export default function AdsPanel() {
  const [data, setData] = useState<AdsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(7);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const refresh = useCallback(async (d: number) => {
    try {
      const res = await fetch(`/api/ads?days=${d}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as AdsData;
      if (!j.ok) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudieron cargar los datos de anuncios.");
    }
  }, []);

  useEffect(() => {
    setData(null);
    refresh(days);
    const t = setInterval(() => refresh(days), 60_000);
    return () => clearInterval(t);
  }, [refresh, days]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
        cache: "no-store",
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; report?: { errors?: string[]; skippedReason?: string } } | null;
      if (!res.ok || !j?.ok) {
        setSyncError(j?.report?.errors?.[0] ?? j?.report?.skippedReason ?? "la sincronización falló");
      }
      await refresh(days);
    } catch {
      setSyncError("la sincronización falló");
    } finally {
      setSyncing(false);
    }
  }, [refresh, days]);

  if (error && !data) return <ErrorState message={error} onRetry={() => refresh(days)} />;

  const header = data?.header;
  const notConfigured = data != null && data.health.configured === false;

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-[1280px] space-y-7">
        {/* ── Cabecera ── */}
        <section>
          <SectionTitle
            right={
              data ? (
                <span className="inline-flex items-center gap-3">
                  <span className="text-[11px] text-brand-muted">Sincronizado {timeAgo(data.health.lastSyncAt)}</span>
                  <GhostButton onClick={syncNow} disabled={syncing} className="!px-3 !py-1.5 text-xs">
                    {syncing ? (
                      <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />
                    ) : null}
                    {syncing ? "Sincronizando…" : "Sincronizar ahora"}
                  </GhostButton>
                </span>
              ) : null
            }
          >
            Anuncios
          </SectionTitle>
          <div className="flex items-center gap-2">
            {RANGES.map((r) => (
              <Chip key={r} active={days === r} onClick={() => setDays(r)}>
                {r} días
              </Chip>
            ))}
          </div>
          {syncError ? <div className="mt-2 text-xs text-red-600">Sincronización: {syncError}</div> : null}
        </section>

        {notConfigured ? (
          <Card>
            <EmptyState
              title="Meta Ads no está conectado"
              hint="Pega META_ADS_ACCESS_TOKEN y META_ADS_ACCOUNT_ID en el .env.local y ejecuta npm run meta-ads:doctor. Mientras tanto, Finanzas admite el gasto diario a mano y el ROAS sale de ahí."
            />
          </Card>
        ) : (
          <>
            {/* ── KPIs (§32: nada de vanidad, gasto vs. pedidos) ── */}
            <section>
              {!data || !header ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-[76px]" />
                  ))}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <KpiTile label="Gasto hoy" value={formatEuro(header.spendToday)} support={header.spendToday === null ? "sin dato del día" : undefined} />
                    <KpiTile label={`Gasto ${header.days} días`} value={formatEuro(header.spendRange)} />
                    <KpiTile label="Pedidos" value={formatInt(header.ordersRange)} support="en el periodo" />
                    <KpiTile label="Entregados" value={formatInt(header.deliveredRange)} support="atribuidos por fecha, no por campaña" />
                    <KpiTile label="CPA pedido" value={formatEuro(header.cpaOrder)} support="gasto / pedidos del periodo" />
                    <KpiTile label="CPA entregado" value={formatEuro(header.cpaDelivered)} support="gasto / entregados del periodo" />
                    <KpiTile label="ROAS bruto" value={header.grossRoas != null ? `${header.grossRoas.toLocaleString("es-ES", { maximumFractionDigits: 2 })}x` : "—"} support="facturación enviada / gasto" />
                    <KpiTile
                      label="ROAS neto"
                      value={header.netRoas != null ? `${header.netRoas.toLocaleString("es-ES", { maximumFractionDigits: 2 })}x` : "—"}
                      support="facturación ENTREGADA / gasto"
                      status={netRoasStatus(header.netRoas)}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-brand-muted leading-snug">
                    CPA y ROAS relacionan el gasto TOTAL del periodo con los pedidos TOTALES del periodo (atribución temporal). No hay
                    conversión por campaña: ese dato no existe.
                  </p>
                </>
              )}
            </section>

            {/* ── Gasto diario ── */}
            <section>
              <SectionTitle>Gasto diario</SectionTitle>
              {!data ? (
                <Skeleton className="h-[160px]" />
              ) : data.daily.length === 0 ? (
                <Card>
                  <EmptyState title="Sin gasto registrado en el periodo" hint="Sincroniza para traer los datos de Meta." />
                </Card>
              ) : (
                <Card className="px-4 py-4">
                  <SpendChart daily={data.daily} />
                </Card>
              )}
            </section>

            {/* ── Campañas ── */}
            <section>
              <SectionTitle>Campañas</SectionTitle>
              {!data ? (
                <SkeletonRows rows={4} />
              ) : data.campaigns.length === 0 ? (
                <Card>
                  <EmptyState title="Sin campañas con gasto en el periodo" />
                </Card>
              ) : (
                <>
                  {/* Tabla (md+) */}
                  <Card className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[12px] font-medium text-brand-muted border-b border-brand-border">
                          <th className="px-4 py-2.5 font-medium">Campaña</th>
                          <th className="px-4 py-2.5 font-medium text-right">Gasto</th>
                          <th className="px-4 py-2.5 font-medium text-right">Impresiones</th>
                          <th className="px-4 py-2.5 font-medium text-right">Clics</th>
                          <th className="px-4 py-2.5 font-medium text-right">CTR</th>
                          <th className="px-4 py-2.5 font-medium text-right">CPC</th>
                          <th className="px-4 py-2.5 font-medium text-right">CPM</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-brand-border">
                        {data.campaigns.map((c) => (
                          <tr key={c.id}>
                            <td className="px-4 py-2.5">
                              <div className="text-brand-text">{c.name}</div>
                              <div className="text-[10px] text-brand-muted">{c.id}</div>
                            </td>
                            <td className="px-4 py-2.5 text-right text-brand-text whitespace-nowrap">{formatEuro(c.spend)}</td>
                            <td className="px-4 py-2.5 text-right text-brand-muted whitespace-nowrap">{formatInt(c.impressions)}</td>
                            <td className="px-4 py-2.5 text-right text-brand-muted whitespace-nowrap">{formatInt(c.clicks)}</td>
                            <td className="px-4 py-2.5 text-right text-brand-muted whitespace-nowrap">{formatPct(c.ctr)}</td>
                            <td className="px-4 py-2.5 text-right text-brand-muted whitespace-nowrap">{formatEuro(c.cpc, { decimals: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-brand-muted whitespace-nowrap">{formatEuro(c.cpm)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                  {/* Tarjetas apiladas (<md) */}
                  <div className="md:hidden space-y-3">
                    {data.campaigns.map((c) => (
                      <Card key={c.id} className="px-4 py-3">
                        <div className="text-sm text-brand-text">{c.name}</div>
                        <div className="text-[10px] text-brand-muted">{c.id}</div>
                        <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
                          <div>
                            <div className="text-[12px] font-medium text-brand-muted">Gasto</div>
                            <div className="text-brand-text">{formatEuro(c.spend)}</div>
                          </div>
                          <div>
                            <div className="text-[12px] font-medium text-brand-muted">Impresiones</div>
                            <div className="text-brand-text">{formatInt(c.impressions)}</div>
                          </div>
                          <div>
                            <div className="text-[12px] font-medium text-brand-muted">Clics</div>
                            <div className="text-brand-text">{formatInt(c.clicks)}</div>
                          </div>
                          <div>
                            <div className="text-[12px] font-medium text-brand-muted">CTR</div>
                            <div className="text-brand-text">{formatPct(c.ctr)}</div>
                          </div>
                          <div>
                            <div className="text-[12px] font-medium text-brand-muted">CPC</div>
                            <div className="text-brand-text">{formatEuro(c.cpc, { decimals: 2 })}</div>
                          </div>
                          <div>
                            <div className="text-[12px] font-medium text-brand-muted">CPM</div>
                            <div className="text-brand-text">{formatEuro(c.cpm)}</div>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </>
              )}
            </section>

            {/* ── Rendimiento por campaña (atribución REAL, v17) ── */}
            {data?.campaignEconomics && (
              <section>
                <SectionTitle
                  right={
                    <span className="text-[11px] text-brand-muted">
                      Cobertura de atribución: {data.campaignEconomics.campaignCoveragePct.toLocaleString("es-ES")}% de {data.campaignEconomics.totalOrders} pedidos
                    </span>
                  }
                >
                  Rendimiento por campaña
                </SectionTitle>
                {data.campaignEconomics.campaignCoveragePct < 100 && data.campaignEconomics.totalOrders > 0 && (
                  <p className="text-[11px] text-amber-600/90 mb-2.5">
                    Cifras PARCIALES: solo cuentan los pedidos cuya campaña se pudo resolver (UTM de Shopify contra las campañas
                    de Meta). Lo no resuelto está en «Sin atribución» — nunca se reparte proporcionalmente.
                  </p>
                )}
                {data.campaignEconomics.campaigns.length === 0 && data.campaignEconomics.unattributed.orders === 0 ? (
                  <Card>
                    <EmptyState
                      title="Aún sin pedidos con atribución en el periodo"
                      hint="La captura de UTM empieza con los pedidos creados a partir de hoy: el histórico no trae este dato."
                    />
                  </Card>
                ) : (
                  <Card className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[680px]">
                      <thead>
                        <tr className="text-left text-[12px] font-medium text-brand-muted border-b border-brand-border">
                          <th className="px-4 py-2.5 font-medium">Campaña</th>
                          <th className="px-4 py-2.5 font-medium text-right">Gasto</th>
                          <th className="px-4 py-2.5 font-medium text-right">Pedidos</th>
                          <th className="px-4 py-2.5 font-medium text-right">Confirmados</th>
                          <th className="px-4 py-2.5 font-medium text-right">Entregados</th>
                          <th className="px-4 py-2.5 font-medium text-right">Fact. entregada</th>
                          <th className="px-4 py-2.5 font-medium text-right">CPA pedido</th>
                          <th className="px-4 py-2.5 font-medium text-right">CPA entregado</th>
                          <th className="px-4 py-2.5 font-medium text-right">ROAS neto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.campaignEconomics.campaigns.map((c) => (
                          <tr key={c.campaignId ?? c.campaignName} className="border-b border-brand-border/40 last:border-0">
                            <td className="px-4 py-2.5">
                              <span className="text-brand-text">{c.campaignName}</span>
                              <span
                                className="ml-1.5 text-[9px] uppercase tracking-wider text-brand-muted"
                                title={c.attribution === "direct_id" ? "Atribución directa: utm_campaign trae el ID de la campaña" : "Atribución inferida: coincide el nombre de la campaña"}
                              >
                                {c.attribution === "direct_id" ? "directa" : "inferida"}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatEuro(c.spend)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatInt(c.orders)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatInt(c.confirmed)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatInt(c.delivered)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatEuro(c.deliveredRevenue)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatEuro(c.cpaOrder)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatEuro(c.cpaDelivered)}</td>
                            <td className={`px-4 py-2.5 text-right tabular-nums ${c.netRoas !== null && c.netRoas < 1 ? "text-red-600" : "text-brand-text"}`}>
                              {c.netRoas === null ? "—" : `${c.netRoas.toLocaleString("es-ES", { maximumFractionDigits: 2 })}x`}
                            </td>
                          </tr>
                        ))}
                        {data.campaignEconomics.unattributed.orders > 0 && (
                          <tr className="text-brand-muted">
                            <td className="px-4 py-2.5">Sin atribución</td>
                            <td className="px-4 py-2.5 text-right">—</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatInt(data.campaignEconomics.unattributed.orders)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatInt(data.campaignEconomics.unattributed.confirmed)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatInt(data.campaignEconomics.unattributed.delivered)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatEuro(data.campaignEconomics.unattributed.deliveredRevenue)}</td>
                            <td className="px-4 py-2.5 text-right">—</td>
                            <td className="px-4 py-2.5 text-right">—</td>
                            <td className="px-4 py-2.5 text-right">—</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </Card>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
