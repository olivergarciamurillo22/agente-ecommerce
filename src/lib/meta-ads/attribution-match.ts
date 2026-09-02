// ============================================================
// CRUCE pedido ↔ campaña de Meta (02-09). Sin inventar equivalencias:
//
//   DIRECTA  → utm_campaign ES un id numérico de campaña que existe en
//              nuestros snapshots (p.ej. la macro {{campaign.id}} de Meta).
//   INFERIDA → coincide el NOMBRE (case-insensitive, espacios colapsados).
//   NONE     → ni id ni nombre casan: el pedido queda "Sin atribución
//              a campaña" — JAMÁS se reparte proporcionalmente.
//
// La economía por campaña declara SIEMPRE su cobertura: con el 62% de
// pedidos atribuidos, las cifras se presentan como parciales, no totales.
// ============================================================

import { systemDbHandle } from "../db";
import { businessDay } from "../time";
import { listMetaAdsDaily, type MetaAdsDailyDbRow } from "./repo";

export type CampaignMatchKind = "direct_id" | "name_match" | "none";

export interface CampaignRef {
  kind: CampaignMatchKind;
  campaignId: string | null;
  campaignName: string | null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Resuelve el utm_campaign de un pedido contra las campañas conocidas. */
export function resolveCampaignRef(
  marketingCampaign: string | null,
  campaigns: Array<{ id: string; name: string | null }>
): CampaignRef {
  const v = (marketingCampaign ?? "").trim();
  if (!v) return { kind: "none", campaignId: null, campaignName: null };

  // DIRECTA: un id de campaña de Meta es un entero largo. Solo cuenta si
  // ADEMÁS existe en nuestros snapshots — un número suelto no es un id.
  if (/^\d{8,}$/.test(v)) {
    const porId = campaigns.find((c) => c.id === v);
    if (porId) return { kind: "direct_id", campaignId: porId.id, campaignName: porId.name };
  }

  const porNombre = campaigns.find((c) => c.name !== null && norm(c.name) === norm(v));
  if (porNombre) return { kind: "name_match", campaignId: porNombre.id, campaignName: porNombre.name };

  return { kind: "none", campaignId: null, campaignName: null };
}

export interface CampaignEconomicsRow {
  campaignId: string | null;
  campaignName: string;
  /** direct_id | name_match — cómo se resolvió la atribución. */
  attribution: CampaignMatchKind;
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

export interface CampaignEconomics {
  fromDay: string;
  toDay: string;
  /** Pedidos del periodo con CUALQUIER atribución / total (0-100). */
  attributionCoveragePct: number;
  /** Pedidos con campaña RESUELTA contra Meta / total (0-100). */
  campaignCoveragePct: number;
  totalOrders: number;
  campaigns: CampaignEconomicsRow[];
  /** El cubo honesto: pedidos sin campaña resuelta. NUNCA se reparte. */
  unattributed: { orders: number; confirmed: number; delivered: number; deliveredRevenue: number };
}

interface OrderLite {
  marketing_campaign: string | null;
  has_attr: number;
  confirmed_at: number | null;
  closure_status: string;
  total_price: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Economía por campaña de una ventana [fromS, toS). READ-ONLY.
 * El gasto por campaña sale de los snapshots (meta_ads_daily); el ROAS de
 * campaña usa la facturación de SUS pedidos, bruta (todos) y neta
 * (entregados) — y solo se calcula donde hay gasto.
 */
export function getCampaignEconomics(fromS: number, toS: number): CampaignEconomics {
  const fromDay = businessDay(fromS * 1000);
  const toDay = businessDay((toS - 1) * 1000);

  // Campañas conocidas del periodo (snapshots).
  const rows = listMetaAdsDaily({ fromDay, toDay, level: "campaign" });
  const porCampana = new Map<string, { name: string | null; spend: number }>();
  for (const r of rows as MetaAdsDailyDbRow[]) {
    const acc = porCampana.get(r.entity_id) ?? { name: r.entity_name, spend: 0 };
    acc.spend += r.spend ?? 0;
    if (!acc.name && r.entity_name) acc.name = r.entity_name;
    porCampana.set(r.entity_id, acc);
  }
  const campanas = [...porCampana].map(([id, v]) => ({ id, name: v.name }));

  // Pedidos del periodo (por fecha real de compra), sin históricos.
  const pedidos = systemDbHandle()
    .prepare(
      `SELECT marketing_campaign,
              CASE WHEN COALESCE(marketing_source, marketing_campaign, marketing_medium, marketing_fbclid, landing_site, referring_site) IS NULL THEN 0 ELSE 1 END AS has_attr,
              confirmed_at, closure_status, total_price
       FROM orders
       WHERE COALESCE(ordered_at, created_at) >= ? AND COALESCE(ordered_at, created_at) < ?
         AND status != 'ignored_old'`
    )
    .all(fromS, toS) as OrderLite[];

  const agregados = new Map<string, CampaignEconomicsRow>();
  const unattributed = { orders: 0, confirmed: 0, delivered: 0, deliveredRevenue: 0 };
  let conAtribucion = 0;
  let conCampana = 0;

  for (const p of pedidos) {
    if (p.has_attr === 1) conAtribucion++;
    const ref = resolveCampaignRef(p.marketing_campaign, campanas);
    const total = parseFloat(p.total_price) || 0;
    const entregado = p.closure_status === "delivered";
    if (ref.kind === "none") {
      unattributed.orders++;
      if (p.confirmed_at) unattributed.confirmed++;
      if (entregado) {
        unattributed.delivered++;
        unattributed.deliveredRevenue = r2(unattributed.deliveredRevenue + total);
      }
      continue;
    }
    conCampana++;
    const clave = ref.campaignId!;
    const fila =
      agregados.get(clave) ??
      ({
        campaignId: ref.campaignId,
        campaignName: ref.campaignName ?? clave,
        attribution: ref.kind,
        spend: porCampana.get(clave) ? r2(porCampana.get(clave)!.spend) : null,
        orders: 0,
        confirmed: 0,
        delivered: 0,
        deliveredRevenue: 0,
        cpaOrder: null,
        cpaDelivered: null,
        grossRoas: null,
        netRoas: null,
      } satisfies CampaignEconomicsRow);
    fila.orders++;
    if (p.confirmed_at) fila.confirmed++;
    if (entregado) {
      fila.delivered++;
      fila.deliveredRevenue = r2(fila.deliveredRevenue + total);
    }
    // direct_id manda si conviven ambas clases de match en la misma campaña.
    if (ref.kind === "direct_id") fila.attribution = "direct_id";
    agregados.set(clave, fila);
  }

  // Derivados por campaña (solo donde hay gasto — nada de dividir por 0).
  let grossPorCampana = new Map<string, number>();
  {
    // Facturación BRUTA por campaña: total de sus pedidos (entregados o no).
    grossPorCampana = new Map();
    for (const p of pedidos) {
      const ref = resolveCampaignRef(p.marketing_campaign, campanas);
      if (ref.kind === "none") continue;
      grossPorCampana.set(ref.campaignId!, r2((grossPorCampana.get(ref.campaignId!) ?? 0) + (parseFloat(p.total_price) || 0)));
    }
  }
  for (const fila of agregados.values()) {
    if (fila.spend !== null && fila.spend > 0) {
      fila.cpaOrder = fila.orders > 0 ? r2(fila.spend / fila.orders) : null;
      fila.cpaDelivered = fila.delivered > 0 ? r2(fila.spend / fila.delivered) : null;
      const gross = grossPorCampana.get(fila.campaignId!) ?? 0;
      fila.grossRoas = r2(gross / fila.spend);
      fila.netRoas = r2(fila.deliveredRevenue / fila.spend);
    }
  }

  const total = pedidos.length;
  return {
    fromDay,
    toDay,
    attributionCoveragePct: total > 0 ? Math.round((conAtribucion / total) * 1000) / 10 : 0,
    campaignCoveragePct: total > 0 ? Math.round((conCampana / total) * 1000) / 10 : 0,
    totalOrders: total,
    campaigns: [...agregados.values()].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0)),
    unattributed,
  };
}
