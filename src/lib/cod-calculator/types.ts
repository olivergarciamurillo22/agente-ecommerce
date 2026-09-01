// ============================================================
// Calculadora COD — tipos del dominio.
//
// DOS modelos SEPARADOS a propósito (no un cálculo con condicionales):
//   MODELO PEDRO (pedro-model.ts) — réplica EXACTA del Excel original.
//   MODELO REAL  (real-model.ts)  — unit economics por evento real.
// Los cálculos son funciones puras, fuera de React, testeables solas.
// ============================================================

export interface CODCalculatorInputs {
  /** Precio de venta al cliente (P. VENTA). */
  salePrice: number;
  /** Coste del producto (COSTE PRODUCTO). */
  productCost: number;
  /** IVA como fracción (0.21 = 21%). El Excel lo aplica AL COSTE. */
  vatRate: number;
  /** CPA/R del Excel: coste publicitario por pedido RECIBIDO. */
  rawCPA: number;
  /** % ENVÍO: pedidos enviados / pedidos totales (0..1). */
  shippingRate: number;
  /** % ENTREGA: pedidos entregados / enviados (0..1). */
  deliveryRate: number;
  /** ENVÍO: coste de envío de ida por pedido enviado. */
  outboundShippingCost: number;
  /** COD: comisión contrareembolso por pedido ENTREGADO. */
  codFee: number;
  /** DEVOLUCIÓN: coste cuando un pedido enviado no se entrega. */
  returnCost: number;
  /** Otros costes variables por pedido CREADO (solo Modelo Real). */
  otherCostPerOrder?: number;
  /**
   * Fracción del coste de producto que se RECUPERA cuando el pedido vuelve
   * (solo Modelo Real). 0 = se pierde entero (default conservador y
   * EXPLÍCITO: no se asume recuperación sin configurarla).
   */
  returnedProductRecoveryRate?: number;
}

/** Resultado del Excel de Pedro. null = el Excel daría #DIV/0! (la web pinta "—"). */
export interface PedroCODResult {
  model: "pedro";
  vat: number;
  realCPA: number | null;
  expectedShippingCost: number;
  /** PROFIT del Excel (su semántica exacta, sin "corregir"). */
  profit: number | null;
  /** MARGEN = profit / precio. */
  margin: number | null;
  /** ROI = profit / coste producto. */
  roi: number | null;
  /** SIN IRPF = profit × 0,8 — réplica del Excel, NO es cálculo fiscal. */
  afterIrpf: number | null;
}

/** Escenario base de 100 pedidos creados, evento a evento. */
export interface RealCODResult {
  model: "real";
  created: number;
  sent: number;
  delivered: number;
  notDelivered: number;
  revenue: number;
  ads: number;
  productCost: number;
  productRecovered: number;
  outboundShipping: number;
  codFees: number;
  returnCosts: number;
  otherCosts: number;
  profit100: number;
  profitPerOrder: number | null;
  profitPerSent: number | null;
  profitPerDelivered: number | null;
  /** profit / revenue (sobre lo COBRADO). null sin revenue. */
  marginOnRevenue: number | null;
  /** Sin modelo fiscal configurado, el Real no aplica IVA: se declara. */
  fiscalNote: string;
}

export type CODModelType = "pedro" | "real";

export interface CODBreakEven {
  /** Tasa de entrega con profit 0 (fracción). null si no existe en (0,1]. */
  deliveryRateBreakEven: number | null;
  /** CPA máximo con profit 0. */
  cpaBreakEven: number | null;
  /** Precio mínimo con profit 0. */
  minSalePrice: number | null;
  /** Coste de producto máximo con profit 0. */
  maxProductCost: number | null;
  /** Entrega necesaria para el margen objetivo. */
  deliveryForTargetMargin: number | null;
  /** CPA máximo para el margen objetivo. */
  cpaForTargetMargin: number | null;
  /** El objetivo usado (fracción, p.ej. 0.10). */
  targetMargin: number;
}

/** De dónde sale cada input precargado (§19): el badge de la UI. */
export type CODDataSource = "meta_ads" | "real" | "configured" | "manual" | "simulation" | "default";

export interface CODInputWithSource<T = number> {
  value: T | null;
  source: CODDataSource;
  /** Detalle humano: "71 entregados / 102 cierres conocidos". */
  detail: string | null;
  /** Tamaño de muestra cuando aplica (para avisar de muestras pequeñas). */
  sample?: number | null;
}

export interface CODScenario {
  id: number;
  name: string;
  product_sku: string | null;
  model_type: CODModelType;
  assumptions_json: string;
  created_at: number;
  updated_at: number;
}

export interface SensitivityCell {
  cpa: number;
  deliveryRate: number;
  profitPerOrder: number | null;
}
