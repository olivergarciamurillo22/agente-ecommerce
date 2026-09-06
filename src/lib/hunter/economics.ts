// ============================================================
// AI Winner Radar — PUENTE CON EL MOTOR FINANCIERO.
//
// NO se reimplementa ni una fórmula. El Modelo Pedro y el break-even ya viven
// en `src/lib/cod-calculator/` y son el mismo cálculo que usa la Calculadora
// COD del panel. Tener dos versiones de "beneficio por pedido" que se
// desvían un céntimo es como se pierde la confianza en ambas.
//
// Lo que SÍ hace este fichero: reunir los inputs desde tres orígenes
// distintos y dejar por escrito de dónde salió cada uno.
//   · tasas reales de Casamable (entrega, envío, CPA)  → INTERNAL_REAL
//   · coste de proveedor                                → INTERNAL_REAL / PROVIDER_ESTIMATE
//   · precio observado en anuncios de la competencia    → OBSERVED
// ============================================================

import { calculatePedroModel } from "../cod-calculator/pedro-model";
import { computeBreakEven } from "../cod-calculator/break-even";
import type { CODCalculatorInputs } from "../cod-calculator/types";
import { measured, unknownMetric, type MetricProvenance } from "./provenance";
import type { EconomicAssumption, OpportunityEconomics } from "./types";

export interface EconomicsInput {
  /** Precio al que planeamos vender. */
  salePrice: number | null;
  salePriceProvenance: MetricProvenance;
  supplierCost: number | null;
  supplierCostProvenance: MetricProvenance;
  supplierCostSource: string | null;
  /** Tasas reales de Casamable; si faltan, no se inventan. */
  deliveryRate: number | null;
  deliveryRateSource: string | null;
  shippingRate: number | null;
  shippingRateSource: string | null;
  rawCPA: number | null;
  rawCPASource: string | null;
  outboundShippingCost: number;
  codFee: number;
  returnCost: number;
  vatRate: number;
  otherCostPerOrder: number;
}

/**
 * Sin precio o sin coste no hay economía posible. Devolver ceros aquí sería
 * el peor error del módulo: un "beneficio 0,00 €" se lee como un cálculo,
 * no como una ausencia.
 */
export function computeOpportunityEconomics(input: EconomicsInput): OpportunityEconomics | null {
  if (input.salePrice === null || input.supplierCost === null) return null;
  if (input.deliveryRate === null || input.shippingRate === null) return null;

  const inputs: CODCalculatorInputs = {
    salePrice: input.salePrice,
    productCost: input.supplierCost,
    vatRate: input.vatRate,
    rawCPA: input.rawCPA ?? 0,
    shippingRate: input.shippingRate,
    deliveryRate: input.deliveryRate,
    outboundShippingCost: input.outboundShippingCost,
    codFee: input.codFee,
    returnCost: input.returnCost,
    otherCostPerOrder: input.otherCostPerOrder,
  };

  const pedro = calculatePedroModel(inputs);
  const be = computeBreakEven("pedro", inputs, 0);

  const assumptions: EconomicAssumption[] = [
    assume("deliveryRate", "Tasa de entrega", input.deliveryRate, "INTERNAL_REAL", input.deliveryRateSource),
    assume("shippingRate", "Tasa de envío", input.shippingRate, "INTERNAL_REAL", input.shippingRateSource),
    assume("outboundShippingCost", "Coste de envío", input.outboundShippingCost, "INTERNAL_REAL", "ajustes de la calculadora"),
    assume("codFee", "Comisión contrareembolso", input.codFee, "INTERNAL_REAL", "ajustes de la calculadora"),
    assume("returnCost", "Coste de devolución", input.returnCost, "INTERNAL_REAL", "ajustes de la calculadora"),
    assume("vatRate", "IVA aplicado al coste", input.vatRate, "INTERNAL_REAL", "ajustes de la calculadora"),
  ];
  if (input.rawCPA !== null) {
    assumptions.push(assume("rawCPA", "CPA por pedido recibido", input.rawCPA, "INTERNAL_REAL", input.rawCPASource));
  }

  // Sin CPA real, el beneficio sale sin coste publicitario: sería un número
  // bonito y falso. Se marca la confianza a la baja y se dice en el resumen.
  const cpaKnown = input.rawCPA !== null;

  return {
    salePrice: measured(input.salePrice, input.salePriceProvenance, { source: "radar" }),
    supplierCost: measured(input.supplierCost, input.supplierCostProvenance, { source: input.supplierCostSource }),
    realCPA: cpaKnown
      ? measured(pedro.realCPA, "CALCULATED", { source: "modelo Pedro" })
      : unknownMetric<number>("CALCULATED", "sin CPA real"),
    expectedShippingCost: measured(pedro.expectedShippingCost, "CALCULATED", { source: "modelo Pedro" }),
    expectedProfit: measured(pedro.profit, "CALCULATED", {
      source: "modelo Pedro",
      confidence: cpaKnown ? 0.8 : 0.4,
    }),
    margin: measured(pedro.margin, "CALCULATED", { source: "modelo Pedro", confidence: cpaKnown ? 0.8 : 0.4 }),
    roi: measured(pedro.roi, "CALCULATED", { source: "modelo Pedro", confidence: cpaKnown ? 0.8 : 0.4 }),
    breakEvenCPA: measured(be.cpaBreakEven, "CALCULATED", { source: "modelo Pedro" }),
    assumptions,
  };
}

function assume(
  key: string,
  label: string,
  value: number,
  provenance: MetricProvenance,
  source: string | null
): EconomicAssumption {
  return { key, label, value, provenance, source };
}
