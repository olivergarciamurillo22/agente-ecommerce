// ============================================================
// MODELO PEDRO — réplica EXACTA de la calculadora Excel original.
//
// NO "corregir" nada de aquí: este modo existe para que Pedro vea los
// mismos números que su Excel (continuidad y comparación histórica).
// Las dudas conocidas del modelo (NO son bugs de la migración):
//   · IVA = coste producto × IVA (el Excel aplica el IVA AL COSTE).
//   · realCPA ya divide por (envío × entrega) y el profit vuelve a
//     multiplicar por entrega — posible doble aplicación de
//     probabilidades según qué represente "profit". Marcado para
//     revisión del modelo; el MODELO REAL (real-model.ts) calcula por
//     evento sin esa ambigüedad.
//   · "SIN IRPF" = profit × 0,8 — replica el Excel; NO es cálculo fiscal.
//
// Donde el Excel daría #DIV/0!, aquí sale null (la web pinta "—").
// ============================================================

import type { CODCalculatorInputs, PedroCODResult } from "./types";

export function calculatePedroModel(i: CODCalculatorInputs): PedroCODResult {
  const vat = i.productCost * i.vatRate;

  const divisor = i.shippingRate * i.deliveryRate;
  const realCPA = divisor > 0 ? i.rawCPA / divisor : null;

  const expectedShippingCost =
    i.outboundShippingCost + i.codFee * i.deliveryRate + (1 - i.deliveryRate) * i.returnCost;

  const profit =
    realCPA === null
      ? null
      : (i.salePrice - i.productCost - vat - realCPA - expectedShippingCost) * i.deliveryRate;

  const margin = profit !== null && i.salePrice > 0 ? profit / i.salePrice : null;
  const roi = profit !== null && i.productCost > 0 ? profit / i.productCost : null;
  const afterIrpf = profit !== null ? profit * 0.8 : null;

  return { model: "pedro", vat, realCPA, expectedShippingCost, profit, margin, roi, afterIrpf };
}
