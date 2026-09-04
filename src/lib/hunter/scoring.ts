import { computeBreakEven } from "../cod-calculator/break-even";
import { calculateRealCODModel } from "../cod-calculator/real-model";
import type { CandidateFacts, CandidateScore, ScoreReason, Verdict } from "./types";

export const HISTORIC_CPA_EUR = 7.77;
export const BASE_DELIVERY_RATE = 0.629;
export const BASE_SHIPPING_RATE = 1;
export const COD_FEE_EUR = 0.7;
export const REFUSAL_COST_EUR = 9.37;

// El margen y el CPA mandan porque determinan cuánto se puede invertir sin perder dinero.
export const WEIGHT_MARGIN = 30;
export const WEIGHT_CPA = 25;
// El tramo pesa mucho: saltar de 1 a 4 kg consume una parte material del presupuesto.
export const WEIGHT_SHIPPING = 20;
// Menos variantes reducen errores, stock inmovilizado y complejidad de fulfillment.
export const WEIGHT_VARIANTS = 10;
// Un ticket sano deja absorber incidencias sin puntuar demanda inexistente.
export const WEIGHT_TICKET = 10;
// La recompra solo suma cuando Pedro la declara de forma explícita en la nota manual.
export const WEIGHT_REPURCHASE = 5;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function configuredVolumetricDivisor():number|null {
  const raw=process.env.HUNTER_VOLUMETRIC_DIVISOR;if(!raw)return null;const value=Number(raw);
  return Number.isFinite(value)&&value>0?value:null;
}

export function shippingTier(f: CandidateFacts,volumetricDivisor:number|null=configuredVolumetricDivisor()): { tier: "hasta_1kg" | "hasta_4kg"; eur: number } | null {
  if ([f.weightGrams, f.lengthCm, f.widthCm, f.heightCm].some((v) => v === null || !Number.isFinite(v))) return null;
  // Beeping no documenta peso volumétrico: solo se aplica con un divisor configurado explícitamente.
  const volumetricGrams = volumetricDivisor ? ((f.lengthCm as number) * (f.widthCm as number) * (f.heightCm as number) / volumetricDivisor) * 1000 : 0;
  const chargeableGrams = Math.max(f.weightGrams as number, volumetricGrams);
  if (chargeableGrams <= 1000) return { tier: "hasta_1kg", eur: 4.08 };
  if (chargeableGrams <= 4000) return { tier: "hasta_4kg", eur: 6.5 };
  return null;
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
    shippingRate: BASE_SHIPPING_RATE, deliveryRate: BASE_DELIVERY_RATE,
    outboundShippingCost: shipment.eur, codFee: COD_FEE_EUR,
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
  add("tramo_envio", shipment.tier === "hasta_1kg" ? WEIGHT_SHIPPING : WEIGHT_SHIPPING / 2, `${shipment.eur} € (${shipment.tier.replace("_", " ")})`);
  const variantCount = f.variants?.length ?? 0;
  add("variantes", variantCount <= 1 ? WEIGHT_VARIANTS : variantCount <= 3 ? 6 : 2, `${variantCount} variantes`);
  add("ticket", price >= 29.9 && price <= 59.9 ? WEIGHT_TICKET : 5, `PVP propuesto ${price} €`);
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
