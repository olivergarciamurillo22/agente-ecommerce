// ============================================================
// API del panel de Anuncios (Meta Ads) del Control Center v2.
//
// GET  ?days=N  → salud + cabecera (gasto/CPA/ROAS por ATRIBUCIÓN
//                 TEMPORAL, §32) + campañas agregadas + serie diaria.
// POST {action:"sync"} → sincronización manual (GETs read-only a Meta,
//                 escribe SOLO snapshots locales).
//
// Honestidad de datos: los CPA/ROAS relacionan el gasto TOTAL del
// periodo con los pedidos TOTALES del periodo. No existe atribución
// por campaña (no hay píxel de conversión enlazado a pedidos COD).
// ============================================================

import { NextResponse } from "next/server";
import { systemDbHandle } from "../../../lib/db";
import { getMetaAdsHealth } from "../../../lib/meta-ads/health";
import { listMetaAdsDaily, type MetaAdsDailyDbRow } from "../../../lib/meta-ads/repo";
import { syncMetaAdsInsights } from "../../../lib/meta-ads/sync";
import { getEconomicsWindowRange } from "../../../lib/system/unit-economics";
import { businessDay, startOfBusinessDay } from "../../../lib/time";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CampaignAgg {
  id: string;
  name: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function parseDays(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 7;
  if (!Number.isFinite(n)) return 7;
  return Math.min(90, Math.max(1, n));
}

function aggregateCampaigns(rows: MetaAdsDailyDbRow[]): CampaignAgg[] {
  const byId = new Map<string, { name: string | null; spend: number; impressions: number; clicks: number }>();
  for (const row of rows) {
    const acc = byId.get(row.entity_id) ?? { name: null, spend: 0, impressions: 0, clicks: 0 };
    if (row.entity_name) acc.name = row.entity_name;
    acc.spend += row.spend ?? 0;
    acc.impressions += row.impressions ?? 0;
    acc.clicks += row.clicks ?? 0;
    byId.set(row.entity_id, acc);
  }
  return [...byId.entries()]
    .map(([id, a]) => ({
      id,
      name: a.name ?? id,
      spend: r2(a.spend),
      impressions: a.impressions,
      clicks: a.clicks,
      // Recalculados desde las SUMAS (los ctr/cpc/cpm diarios de Meta no se promedian).
      ctr: a.impressions > 0 ? r2((a.clicks / a.impressions) * 100) : null,
      cpc: a.clicks > 0 ? r2(a.spend / a.clicks) : null,
      cpm: a.impressions > 0 ? r2((a.spend / a.impressions) * 1000) : null,
    }))
    .sort((a, b) => b.spend - a.spend);
}

/** Serie diaria de nivel cuenta (agregada por día por si hubiera >1 fila). */
function dailySeries(rows: MetaAdsDailyDbRow[]): Array<{ day: string; spend: number | null; impressions: number; clicks: number }> {
  const byDay = new Map<string, { spend: number | null; impressions: number; clicks: number }>();
  for (const row of rows) {
    const acc = byDay.get(row.day) ?? { spend: null, impressions: 0, clicks: 0 };
    if (row.spend != null) acc.spend = (acc.spend ?? 0) + row.spend;
    acc.impressions += row.impressions ?? 0;
    acc.clicks += row.clicks ?? 0;
    byDay.set(row.day, acc);
  }
  return [...byDay.entries()]
    .map(([day, a]) => ({ day, spend: a.spend != null ? r2(a.spend) : null, impressions: a.impressions, clicks: a.clicks }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

export async function GET(req: Request) {
  try {
    const days = parseDays(new URL(req.url).searchParams.get("days"));
    const nowMs = Date.now();
    const toDay = businessDay(nowMs);
    const fromDay = businessDay(nowMs - (days - 1) * 86400 * 1000);
    // Ventana epoch [fromS, toS): desde la medianoche (Madrid) del primer día
    // del rango hasta ahora mismo — la misma ventana para pedidos y economía.
    const fromS = startOfBusinessDay(nowMs - (days - 1) * 86400 * 1000);
    const toS = Math.floor(nowMs / 1000) + 1;

    const health = getMetaAdsHealth();
    const accountRows = listMetaAdsDaily({ fromDay, toDay, level: "account" });
    const campaignRows = listMetaAdsDaily({ fromDay, toDay, level: "campaign" });
    const economics = getEconomicsWindowRange(fromS, toS);

    // Gasto de HOY: la fila de nivel cuenta del día de negocio actual.
    const todayRows = accountRows.filter((r) => r.day === toDay && r.spend != null);
    const spendToday = todayRows.length > 0 ? r2(todayRows.reduce((s, r) => s + (r.spend ?? 0), 0)) : null;

    // Gasto del rango: suma de nivel cuenta. null si no hay ni un día con dato.
    const rangeRows = accountRows.filter((r) => r.spend != null);
    const spendRange = rangeRows.length > 0 ? r2(rangeRows.reduce((s, r) => s + (r.spend ?? 0), 0)) : null;

    // Pedidos del rango por fecha real de compra, sin los importados antiguos.
    const ordersRange = (
      systemDbHandle()
        .prepare(
          `SELECT COUNT(*) AS n FROM orders
           WHERE COALESCE(ordered_at, created_at) >= ? AND COALESCE(ordered_at, created_at) < ?
             AND status != 'ignored_old'`
        )
        .get(fromS, toS) as { n: number }
    ).n;

    const deliveredRange = economics.deliveredOrders;

    return NextResponse.json({
      ok: true,
      health,
      header: {
        days,
        fromDay,
        toDay,
        spendToday,
        spendRange,
        ordersRange,
        deliveredRange,
        cpaOrder: spendRange != null && ordersRange > 0 ? r2(spendRange / ordersRange) : null,
        cpaDelivered: spendRange != null && deliveredRange > 0 ? r2(spendRange / deliveredRange) : null,
        grossRoas: economics.grossRoas,
        netRoas: economics.netRoas,
      },
      campaigns: aggregateCampaigns(campaignRows),
      daily: dailySeries(accountRows),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error interno" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { action?: string } | null;
    if (body?.action !== "sync") {
      return NextResponse.json({ ok: false, error: "acción no soportada" }, { status: 400 });
    }
    // Read-only hacia Meta; escribe solo snapshots locales (meta_ads_daily
    // + puente daily_ad_spend). 7 días de lookback: Meta ajusta cifras
    // retroactivamente los primeros días.
    const report = await syncMetaAdsInsights({ lookbackDays: 7 });
    return NextResponse.json({ ok: !report.skipped && report.errors.length === 0, report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error interno" },
      { status: 500 }
    );
  }
}
