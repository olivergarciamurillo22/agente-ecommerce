import { computeBreakEven } from "../cod-calculator/break-even";
import { calculateRealCODModel } from "../cod-calculator/real-model";
import type { CandidateFacts, CandidateScore, ScoreReason, ShippingTier, Verdict } from "./types";

// ESTIMACIÓN INTERNA, no dato confirmado por Pedro: CPA histórico de referencia
// contra el que se puntúa el CPA máximo. Pendiente de sustituir por el real de Meta Ads.
export const HISTORIC_CPA_EUR = 7.77;
// Tasa de entrega SUPUESTA por defecto cuando no hay histórico del producto.
// Coincide numéricamente con el break-even documentado en BUSINESS-METRICS.md
// (62,9 %), pero aquí NO es un break-even calculado: es la hipótesis de partida
// del scoring. No existe (aún) un dato de entrega por producto en CandidateFacts
// ni en el esquema, así que exigirlo dejaría todos los candidatos sin puntuar;
// por eso se mantiene como default explícito y con este nombre. Ver
// docs/FINANCE-MODEL.md §5 y docs/deploy/NUMEROS-SIN-FUENTE-v4.3.md.
export const DEFAULT_ASSUMED_DELIVERY_RATE = 0.629;
export const BASE_SHIPPING_RATE = 1;
// Confirmado por Pedro (contrato Beeping, 2026-09-05/06): comisión COD 0,70 €.
export const COD_FEE_EUR = 0.7;
// Confirmado por Pedro (contrato Beeping actualizado, 2026-09-05/06): picking &
// packing 1,40 € por pedido ENVIADO. Única fuente: la estimación predictiva
// (predictive/estimate.ts) la importa de aquí.
export const PICKING_EUR = 1.4;
// ESTIMACIÓN INTERNA, no dato confirmado por Pedro: coste de un rechazo
// (picking ida + envío + retorno + picking vuelta). Pendiente de contrastar
// con la tarifa real de devolución del contrato Beeping/Correos Express.
export const REFUSAL_COST_EUR = 9.37;

// Pesos del scoring: ESTIMACIÓN INTERNA (criterio de ingeniería), no datos de Pedro.
// El margen y el CPA mandan porque determinan cuánto se puede invertir sin perder dinero.
export const WEIGHT_MARGIN = 30;
export const WEIGHT_CPA = 25;
// Tramo de envío. DECISIÓN 07-09-2026 (Pedro): con la tarifa real casi plana
// (3,80–4,00 € entre 1 y 4 kg, ver SHIPPING_TIERS) la penalización de peso ya
// no tiene base de coste, y el coste del tramo YA entra en margen_unitario
// (outboundShippingCost). Penalizar además por peso era contar dos veces. El
// factor se conserva con sus 20 puntos para todo paquete dentro de un tramo
// confirmado — así la escala sigue siendo 100 y los umbrales de veredicto no
// cambian — y vuelve a ser 0 solo cuando NO hay tramo (fuera de 4 kg: sin
// puntuar, fail-closed). Redistribuir esos 20 puntos es decisión de Pedro.
export const WEIGHT_SHIPPING = 20;
// Menos variantes reducen errores, stock inmovilizado y complejidad de fulfillment.
export const WEIGHT_VARIANTS = 10;
// Un ticket sano deja absorber incidencias sin puntuar demanda inexistente.
export const WEIGHT_TICKET = 10;
// La recompra solo suma cuando Pedro la declara de forma explícita en la nota manual.
export const WEIGHT_REPURCHASE = 5;

// ESTIMACIÓN INTERNA, no dato confirmado por Pedro: rango de "ticket sano".
// Los PVP reales de Casamable (29,99 / 34,99 / 49,99 €) caen dentro, pero el rango
// en sí no procede de un dato suyo.
export const TICKET_MIN_EUR = 29.9;
export const TICKET_MAX_EUR = 59.9;

/**
 * Tarifa de envío de salida por tramo de peso facturable.
 * FUENTE: contrato Beeping — Correos Express con recargo de combustible,
 * confirmado por Pedro el 2026-09-06. Prácticamente plana: ~3,80 € (1 kg),
 * ~3,86 € (2 kg), ~3,94 € (3 kg), ~4,00 € (4 kg). Por encima de 4 kg no hay
 * tramo confirmado, así que no se puntúa (fail-closed).
 */
export const SHIPPING_TIERS: ReadonlyArray<{ tier: ShippingTier; maxGrams: number; eur: number }> = [
  { tier: "hasta_1kg", maxGrams: 1000, eur: 3.8 },
  { tier: "hasta_2kg", maxGrams: 2000, eur: 3.86 },
  { tier: "hasta_3kg", maxGrams: 3000, eur: 3.94 },
  { tier: "hasta_4kg", maxGrams: 4000, eur: 4.0 },
];

/** Tramo y coste de envío para un peso facturable; null fuera de los tramos confirmados. */
export function shippingTierForGrams(chargeableGrams: number): { tier: ShippingTier; eur: number } | null {
  if (!Number.isFinite(chargeableGrams) || chargeableGrams < 0) return null;
  const found = SHIPPING_TIERS.find((t) => chargeableGrams <= t.maxGrams);
  return found ? { tier: found.tier, eur: found.eur } : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function configuredVolumetricDivisor():number|null {
  const raw=process.env.HUNTER_VOLUMETRIC_DIVISOR;if(!raw)return null;const value=Number(raw);
  return Number.isFinite(value)&&value>0?value:null;
}

export function shippingTier(f: CandidateFacts,volumetricDivisor:number|null=configuredVolumetricDivisor()): { tier: ShippingTier; eur: number } | null {
  if ([f.weightGrams, f.lengthCm, f.widthCm, f.heightCm].some((v) => v === null || !Number.isFinite(v))) return null;
  // Beeping no documenta peso volumétrico: solo se aplica con un divisor configurado explícitamente.
  const volumetricGrams = volumetricDivisor ? ((f.lengthCm as number) * (f.widthCm as number) * (f.heightCm as number) / volumetricDivisor) * 1000 : 0;
  const chargeableGrams = Math.max(f.weightGrams as number, volumetricGrams);
  return shippingTierForGrams(chargeableGrams);
}

function verdictOf(score: number): Verdict {
  if (score >= 80) return "prioritario";
  if (score >= 60) return "probar";
  if (score >= 40) return "dudoso";
  return "descartar";
}

export function scoreCandidate(f: CandidateFacts, manualNote: string | null = null): CandidateScore | null {
  const shipment = shippingTier(f);
  if (!shipment || f.unitCostEur === null || f.salePriceEur == null || !Number.isFinite(f.salePriceEur) || f.salePriceEur <= 0) return null;
  const price = f.salePriceEur;
  const inputs = {
    salePrice: price, productCost: f.unitCostEur, vatRate: 0, rawCPA: 0,
    shippingRate: BASE_SHIPPING_RATE, deliveryRate: DEFAULT_ASSUMED_DELIVERY_RATE,
    // Coste por pedido ENVIADO = transporte del tramo + picking & packing.
    // (07-09-2026: el picking faltaba en el scoring; solo estaba en la
    // estimación predictiva. Ambos usan ahora la misma constante.)
    outboundShippingCost: shipment.eur + PICKING_EUR, codFee: COD_FEE_EUR,
    returnCost: REFUSAL_COST_EUR, returnedProductRecoveryRate: 0,
  };
  const model = calculateRealCODModel(inputs);
  const be = computeBreakEven("real", inputs, 0.1);
  const margin = model.profitPerSent;
  if (margin === null || be.cpaBreakEven === null || be.deliveryRateBreakEven === null) return null;
  const reasons: ScoreReason[] = [];
  const add = (factor: string, points: number, detail: string) => reasons.push({ factor, points: round2(points), detail });
  add("margen_unitario", Math.max(0, Math.min(WEIGHT_MARGIN, margin / 12 * WEIGHT_MARGIN)), `${round2(margin)} € por enviado`);
  add("cpa_maximo", Math.max(0, Math.min(WEIGHT_CPA, be.cpaBreakEven / HISTORIC_CPA_EUR * WEIGHT_CPA)), `${round2(be.cpaBreakEven)} € frente a ${HISTORIC_CPA_EUR} € históricos`);
  add("tramo_envio", WEIGHT_SHIPPING, `${shipment.eur} € (${shipment.tier.replace("_", " ")}) + picking ${PICKING_EUR} € · coste ya en el margen; tarifa casi plana: sin penalización por peso`);
  const variantCount = f.variants?.length ?? 0;
  add("variantes", variantCount <= 1 ? WEIGHT_VARIANTS : variantCount <= 3 ? 6 : 2, `${variantCount} variantes`);
  add("ticket", price >= TICKET_MIN_EUR && price <= TICKET_MAX_EUR ? WEIGHT_TICKET : 5, `PVP propuesto ${price} €`);
  const repurchase = /recompra\s*:\s*s[ií]/i.test(manualNote ?? "");
  add("recompra", repurchase ? WEIGHT_REPURCHASE : 0, repurchase ? "confirmada manualmente" : "dato manual pendiente");
  const score = round2(reasons.reduce((sum, r) => sum + r.points, 0));
  return { shippingTier: shipment.tier, shippingEur: shipment.eur, proposedPriceEur: price,
    unitMarginEur: round2(margin), maxCpaEur: round2(be.cpaBreakEven),
    breakEvenDeliveryPct: round2(be.deliveryRateBreakEven * 100), score,
    verdict: verdictOf(score), reasons };
}

export function missingScoreReasons(f: CandidateFacts): ScoreReason[] {
  if ([f.weightGrams, f.lengthCm, f.widthCm, f.heightCm].some((v) => v === null))
    return [{ factor: "medidas", points: 0, detail: "faltan medidas del paquete de venta" }];
  if (f.unitCostEur === null) return [{ factor: "coste", points: 0, detail: "falta el coste unitario" }];
  if (f.salePriceEur == null || !Number.isFinite(f.salePriceEur) || f.salePriceEur <= 0)
    return [{ factor: "precio_venta", points: 0, detail: "falta el precio de venta" }];
  return [{ factor: "tramo_envio", points: 0, detail: "el paquete queda fuera de los tramos configurados" }];
}
