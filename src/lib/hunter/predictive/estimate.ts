import { shippingTierForGrams } from "../scoring";
import type { PredictiveEstimate, PredictiveSearchProvider, PriceRange, PreliminaryViability, SearchEvidence } from "./types";

// ESTIMACIÓN INTERNA, no dato confirmado por Pedro: caducidad de una estimación.
export const ESTIMATE_TTL_DAYS = 30;
// Confirmado por Pedro (contrato Beeping actualizado, 2026-09-05/06): picking & packing 1,40 €.
export const PICKING_EUR = 1.4;
// Confirmado por Pedro (contrato Beeping): comisión COD 0,70 €.
export const COD_EUR = 0.7;
// ESTIMACIÓN INTERNA, no dato confirmado por Pedro: umbral de "candidato fuerte".
export const STRONG_MIN_WORST_MARGIN_EUR = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;

function range(sources: SearchEvidence[], consultedAt: number, expiresAt: number): PriceRange | null {
  const uniqueDomains = new Set(sources.map((s) => s.sourceDomain));
  if (uniqueDomains.size === 0) return null;
  const prices = sources.map((s) => s.priceEur).sort((a, b) => a - b);
  const domainMeans = [...uniqueDomains].map((domain) => {
    const values = sources.filter((s) => s.sourceDomain === domain).map((s) => s.priceEur);
    return values.reduce((a, b) => a + b, 0) / values.length;
  });
  return {
    min: round2(prices[0]), max: round2(prices.at(-1)!),
    probable: round2(domainMeans.reduce((a, b) => a + b, 0) / domainMeans.length),
    sources, consultedAt, expiresAt, confidence: uniqueDomains.size === 1 ? "baja" : "media",
  };
}

function wholesaleForQuantity(all: SearchEvidence[], target: 100 | 500): SearchEvidence[] {
  const nearestByDomain = new Map<string, SearchEvidence>();
  for (const source of all) {
    if (source.quantity === null || source.quantity > target) continue;
    const previous = nearestByDomain.get(source.sourceDomain);
    if (!previous || (previous.quantity ?? 0) < source.quantity) nearestByDomain.set(source.sourceDomain, source);
  }
  return [...nearestByDomain.values()];
}

function logistics(evidence: SearchEvidence[]): Pick<PreliminaryViability, "logisticsEur" | "shippingTier" | "reason"> {
  const weights = evidence.map((e) => e.weightGrams).filter((n): n is number => n !== null);
  if (!weights.length) return { logisticsEur: null, shippingTier: null, reason: "sin peso fiable para aplicar el tramo logistico" };
  const worstWeight = Math.max(...weights);
  // Envío por tramo: la MISMA tabla que el scoring (SHIPPING_TIERS, contrato Beeping / Correos Express).
  const shipping = shippingTierForGrams(worstWeight);
  if (!shipping) return { logisticsEur: null, shippingTier: null, reason: "peso fuera de los tramos Beeping conocidos" };
  return { logisticsEur: round2(PICKING_EUR + COD_EUR + shipping.eur), shippingTier: shipping.tier, reason: null };
}

export async function estimatePredictiveCandidate(
  productQuery: string,
  competitorUrl: string | null,
  provider: PredictiveSearchProvider,
  now = Math.floor(Date.now() / 1000)
): Promise<PredictiveEstimate> {
  const query = productQuery.trim();
  if (!query) throw new Error("falta --producto");
  if (competitorUrl) new URL(competitorUrl);
  const expiresAt = now + ESTIMATE_TTL_DAYS * 86400;
  if (!provider.available) return {
    productQuery: query, competitorUrl, searchAvailable: false, searchMechanism: null,
    wholesale: { at100: null, at500: null, reason: "sin acceso a busqueda real" },
    retail: { unit: null, tiers: null, reason: "sin acceso a busqueda real" },
    viability: { verdict: null, worstContributionEur: null, bestContributionEur: null, logisticsEur: null, shippingTier: null, reason: "sin fuentes suficientes" },
    consultedAt: now, expiresAt,
  };

  let wholesale: SearchEvidence[] = [], retail: SearchEvidence[] = [];
  try {
    [wholesale, retail] = await Promise.all([
      provider.search({ query, competitorUrl, kind: "wholesale" }),
      provider.search({ query, competitorUrl, kind: "retail" }),
    ]);
  } catch {
    return {
      productQuery: query, competitorUrl, searchAvailable: true, searchMechanism: provider.mechanism,
      wholesale: { at100: null, at500: null, reason: "la busqueda real fallo" },
      retail: { unit: null, tiers: null, reason: "la busqueda real fallo" },
      viability: { verdict: null, worstContributionEur: null, bestContributionEur: null, logisticsEur: null, shippingTier: null, reason: "sin fuentes suficientes" },
      consultedAt: now, expiresAt,
    };
  }

  const at100 = range(wholesaleForQuantity(wholesale, 100), now, expiresAt);
  const at500 = range(wholesaleForQuantity(wholesale, 500), now, expiresAt);
  const unit = range(retail, now, expiresAt);
  const sourceStatuses = provider.sourceStatuses?.();
  const allPublicSourcesUnavailable = sourceStatuses?.length === 3 && sourceStatuses.every((source) => source.status === "no_disponible");
  const wholesaleEstimate = { at100, at500, reason: at100 && at500 ? null : "sin fuentes mayoristas suficientes para ambos volumenes", sourceStatuses };
  const retailEstimate = { unit, tiers: unit ? { unit, pack2Reference: "pack 2 con descuento: estructura a validar", pack4Reference: "pack 4 con descuento mayor: estructura a validar" } : null, reason: unit ? null : "sin fuentes DTC suficientes" };
  const shipping = logistics([...wholesale, ...retail]);
  let viability: PreliminaryViability;
  if (!at500 || !unit || shipping.logisticsEur === null) {
    viability = { verdict: null, worstContributionEur: null, bestContributionEur: null, ...shipping, reason: shipping.reason ?? "sin rangos suficientes" };
  } else {
    const worst = round2(unit.min - at500.max - shipping.logisticsEur);
    const best = round2(unit.max - at500.min - shipping.logisticsEur);
    const verdict = best <= 0 ? "descartar" : worst >= STRONG_MIN_WORST_MARGIN_EUR ? "candidato_fuerte" : "investigar";
    viability = { verdict, worstContributionEur: worst, bestContributionEur: best, logisticsEur: shipping.logisticsEur, shippingTier: shipping.shippingTier, reason: null };
  }
  return { productQuery: query, competitorUrl, searchAvailable: !allPublicSourcesUnavailable, searchMechanism: provider.mechanism, wholesale: wholesaleEstimate, retail: retailEstimate, viability, consultedAt: now, expiresAt };
}
