// ============================================================
// MODELO REAL — unit economics por EVENTO, sin doble probabilidad.
//
// Escenario base: 100 pedidos CREADOS.
//   sent      = 100 × %envío
//   delivered = sent × %entrega
// Cada coste se imputa al evento que lo produce:
//   ingresos   → por ENTREGADO (COD: solo se cobra al entregar)
//   ads        → por CREADO (el CPA/R de Pedro es por pedido recibido)
//   producto   → por ENVIADO, menos lo recuperado en devoluciones
//                (recuperación 0 por defecto: EXPLÍCITA, no asumida)
//   envío ida  → por ENVIADO
//   COD        → por ENTREGADO
//   devolución → por NO ENTREGADO (de los enviados)
//   otros      → por CREADO
//
// FISCALIDAD: este modelo NO aplica IVA/IRPF por defecto — el
// tratamiento fiscal real está pendiente de especificación contable y
// se declara en fiscalNote. (El Excel aplica IVA al coste: eso vive
// SOLO en el Modelo Pedro.)
// ============================================================

import type { CODCalculatorInputs, RealCODResult } from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calculateRealCODModel(i: CODCalculatorInputs, createdOrders = 100): RealCODResult {
  const created = createdOrders;
  const sent = created * i.shippingRate;
  const delivered = sent * i.deliveryRate;
  const notDelivered = sent - delivered;

  const revenue = delivered * i.salePrice;
  const ads = created * i.rawCPA;
  const productGross = sent * i.productCost;
  const productRecovered = notDelivered * i.productCost * (i.returnedProductRecoveryRate ?? 0);
  const productCost = productGross - productRecovered;
  const outboundShipping = sent * i.outboundShippingCost;
  const codFees = delivered * i.codFee;
  const returnCosts = notDelivered * i.returnCost;
  const otherCosts = created * (i.otherCostPerOrder ?? 0);

  const profit100 = revenue - ads - productCost - outboundShipping - codFees - returnCosts - otherCosts;

  return {
    model: "real",
    created,
    sent: r2(sent),
    delivered: r2(delivered),
    notDelivered: r2(notDelivered),
    revenue: r2(revenue),
    ads: r2(ads),
    productCost: r2(productCost),
    productRecovered: r2(productRecovered),
    outboundShipping: r2(outboundShipping),
    codFees: r2(codFees),
    returnCosts: r2(returnCosts),
    otherCosts: r2(otherCosts),
    profit100: r2(profit100),
    profitPerOrder: created > 0 ? profit100 / created : null,
    profitPerSent: sent > 0 ? profit100 / sent : null,
    profitPerDelivered: delivered > 0 ? profit100 / delivered : null,
    marginOnRevenue: revenue > 0 ? profit100 / revenue : null,
    fiscalNote: "Modelo fiscal pendiente de configurar: cifras antes de impuestos.",
  };
}

/** Profit por pedido CREADO — la métrica que comparan los dos modelos. */
export function realProfitPerOrder(i: CODCalculatorInputs): number | null {
  return calculateRealCODModel(i, 100).profitPerOrder;
}

/** Margen sobre ingresos cobrados. */
export function realMargin(i: CODCalculatorInputs): number | null {
  return calculateRealCODModel(i, 100).marginOnRevenue;
}
