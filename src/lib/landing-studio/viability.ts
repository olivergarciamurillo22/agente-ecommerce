import type { LandingEconomics, SourcedNumber, ViabilityResult } from "./types";

const LABELS: Record<keyof LandingEconomics, string> = {
  salePrice: "precio de venta",
  deliveryRate: "tasa de entrega",
  productCost: "coste del producto",
  vat: "IVA aplicable",
  shipping: "transporte",
  codFee: "comisión COD",
  handling: "preparación",
  returnCost: "coste de devolución",
  cac: "CAC",
};

function numberOf(field: SourcedNumber): number | null {
  return field.value !== null && Number.isFinite(field.value) && field.value >= 0 ? field.value : null;
}

export function calculateLandingViability(economics: LandingEconomics): ViabilityResult {
  const values = Object.fromEntries(Object.entries(economics).map(([key, field]) => [key, numberOf(field)])) as Record<keyof LandingEconomics, number | null>;
  const missing = (Object.keys(values) as Array<keyof LandingEconomics>).filter((key) => values[key] === null).map((key) => LABELS[key]);
  if (missing.length > 0) {
    return {
      complete: false,
      viable: null,
      expectedNetRevenue: null,
      expectedReturnCost: null,
      expectedContribution: null,
      missing,
      formula: "Ingreso neto esperado − producto − IVA − transporte − comisión COD − preparación − devoluciones esperadas − CAC",
    };
  }
  const v = values as Record<keyof LandingEconomics, number>;
  const deliveryRate = Math.min(1, v.deliveryRate);
  const expectedNetRevenue = v.salePrice * deliveryRate;
  const expectedReturnCost = v.returnCost * (1 - deliveryRate);
  const expectedContribution = expectedNetRevenue - v.productCost - v.vat - v.shipping - (v.codFee * deliveryRate) - v.handling - expectedReturnCost - v.cac;
  return {
    complete: true,
    viable: expectedContribution > 0,
    expectedNetRevenue,
    expectedReturnCost,
    expectedContribution,
    missing: [],
    formula: "Ingreso neto esperado − producto − IVA − transporte − comisión COD − preparación − devoluciones esperadas − CAC",
  };
}
