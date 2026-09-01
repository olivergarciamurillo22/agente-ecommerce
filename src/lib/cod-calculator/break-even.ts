// ============================================================
// Break-even y objetivos de la Calculadora COD.
//
// En vez de despejar cada fórmula a mano (y equivocarse al cambiar un
// modelo), un ÚNICO solucionador numérico por bisección busca el valor de
// un input que hace profit = objetivo. Funciona igual para el Modelo
// Pedro y el Real, y los tests lo verifican contra casos con solución
// conocida. Nada de NaN/Infinity hacia fuera: si no hay solución en el
// rango, null (la UI pinta "—").
// ============================================================

import { calculatePedroModel } from "./pedro-model";
import { realMargin, realProfitPerOrder } from "./real-model";
import type { CODBreakEven, CODCalculatorInputs, CODModelType, SensitivityCell } from "./types";

/** Profit POR PEDIDO CREADO del modelo elegido (métrica comparable). */
export function profitPerOrder(model: CODModelType, i: CODCalculatorInputs): number | null {
  if (model === "pedro") return calculatePedroModel(i).profit;
  return realProfitPerOrder(i);
}

/** Margen del modelo elegido (Pedro: sobre precio; Real: sobre cobrado). */
export function marginOf(model: CODModelType, i: CODCalculatorInputs): number | null {
  if (model === "pedro") return calculatePedroModel(i).margin;
  return realMargin(i);
}

type NumericKey = "deliveryRate" | "rawCPA" | "salePrice" | "productCost" | "shippingRate";

const BOUNDS: Record<NumericKey, [number, number]> = {
  deliveryRate: [0.0001, 1],
  shippingRate: [0.0001, 1],
  rawCPA: [0, 500],
  salePrice: [0.01, 10_000],
  productCost: [0, 10_000],
};

/**
 * Busca el valor de `key` que hace f(inputs con key=x) = 0.
 * f debe ser monótona en el rango (lo es en todos los usos de abajo);
 * si f no cambia de signo entre los límites, no hay solución → null.
 */
export function solveForZero(
  f: (x: number) => number | null,
  [lo0, hi0]: [number, number]
): number | null {
  let lo = lo0;
  let hi = hi0;
  const flo = f(lo);
  const fhi = f(hi);
  if (flo === null || fhi === null) return null;
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (Math.sign(flo) === Math.sign(fhi)) return null;
  for (let iter = 0; iter < 80; iter++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (fm === null) return null;
    if (Math.abs(fm) < 1e-9 || hi - lo < 1e-9) return mid;
    if (Math.sign(fm) === Math.sign(flo)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function solveInput(
  model: CODModelType,
  base: CODCalculatorInputs,
  key: NumericKey,
  objective: (i: CODCalculatorInputs) => number | null
): number | null {
  return solveForZero((x) => objective({ ...base, [key]: x }), BOUNDS[key]);
}

/**
 * Todos los break-even accionables de golpe (§11-§12).
 * targetMargin en fracción (0.10 = margen objetivo del 10%).
 */
export function computeBreakEven(model: CODModelType, i: CODCalculatorInputs, targetMargin = 0.1): CODBreakEven {
  const profitZero = (x: CODCalculatorInputs) => profitPerOrder(model, x);
  const marginGap = (x: CODCalculatorInputs) => {
    const m = marginOf(model, x);
    return m === null ? null : m - targetMargin;
  };

  return {
    deliveryRateBreakEven: solveInput(model, i, "deliveryRate", profitZero),
    cpaBreakEven: solveInput(model, i, "rawCPA", profitZero),
    minSalePrice: solveInput(model, i, "salePrice", profitZero),
    maxProductCost: solveInput(model, i, "productCost", profitZero),
    deliveryForTargetMargin: solveInput(model, i, "deliveryRate", marginGap),
    cpaForTargetMargin: solveInput(model, i, "rawCPA", marginGap),
    targetMargin,
  };
}

/** Matriz de sensibilidad CPA × tasa de entrega (§14): profit por pedido. */
export function computeSensitivityMatrix(
  model: CODModelType,
  base: CODCalculatorInputs,
  cpaValues: number[],
  deliveryValues: number[]
): SensitivityCell[][] {
  return cpaValues.map((cpa) =>
    deliveryValues.map((deliveryRate) => ({
      cpa,
      deliveryRate,
      profitPerOrder: profitPerOrder(model, { ...base, rawCPA: cpa, deliveryRate }),
    }))
  );
}

/** Curva profit vs un input (para los simuladores de CPA y entrega §15-16). */
export function computeCurve(
  model: CODModelType,
  base: CODCalculatorInputs,
  key: "rawCPA" | "deliveryRate",
  values: number[]
): Array<{ x: number; profit: number | null }> {
  return values.map((x) => ({ x, profit: profitPerOrder(model, { ...base, [key]: x }) }));
}

export interface CODProjection {
  ordersPerDay: number;
  ordersPerMonth: number;
  sentPerMonth: number;
  deliveredPerMonth: number;
  revenue: number;
  ads: number;
  totalCosts: number;
  profitPerMonth: number | null;
  note: string;
}

/** Proyección mensual (§28) — SIEMPRE con la nota de tasas constantes. */
export function projectMonthly(model: CODModelType, i: CODCalculatorInputs, ordersPerDay: number): CODProjection {
  const orders = ordersPerDay * 30;
  const perOrder = profitPerOrder(model, i);
  const sent = orders * i.shippingRate;
  const delivered = sent * i.deliveryRate;
  const revenue = delivered * i.salePrice;
  const ads = orders * i.rawCPA;
  return {
    ordersPerDay,
    ordersPerMonth: orders,
    sentPerMonth: Math.round(sent),
    deliveredPerMonth: Math.round(delivered),
    revenue: Math.round(revenue * 100) / 100,
    ads: Math.round(ads * 100) / 100,
    totalCosts: perOrder === null ? 0 : Math.round((revenue - perOrder * orders) * 100) / 100,
    profitPerMonth: perOrder === null ? null : Math.round(perOrder * orders * 100) / 100,
    note: "Proyección manteniendo constantes las tasas y el CPA actuales.",
  };
}

export type TrafficLight = "green" | "amber" | "red" | "unknown";

/** Semáforo (§13): color + texto, nunca solo color. */
export function trafficLight(model: CODModelType, i: CODCalculatorInputs, targetMargin = 0.1): {
  light: TrafficLight;
  headline: string;
  detail: string;
} {
  const p = profitPerOrder(model, i);
  const m = marginOf(model, i);
  if (p === null) return { light: "unknown", headline: "SIN DATOS", detail: "Faltan inputs para calcular." };
  const euros = `${p >= 0 ? "+" : ""}${p.toFixed(2).replace(".", ",")} € por pedido creado`;
  if (p < 0) return { light: "red", headline: "PÉRDIDAS", detail: euros };
  if (m !== null && m < targetMargin) {
    return { light: "amber", headline: "MARGEN AJUSTADO", detail: `${euros} · margen ${(m * 100).toFixed(1).replace(".", ",")}% por debajo del objetivo` };
  }
  return { light: "green", headline: "RENTABLE", detail: euros };
}
