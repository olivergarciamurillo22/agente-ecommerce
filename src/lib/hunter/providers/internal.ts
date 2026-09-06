// ============================================================
// AI Winner Radar — DATOS PROPIOS DE CASAMABLE.
//
// Esta es la ventaja que no tiene ningún competidor: WinningHunter sabe qué
// se anuncia, pero no sabe cuánto ENTREGA Casamable en España ni cuánto se
// rehúsa. Un producto con 90 de mercado y 55 % de entrega en su categoría
// puede ser peor negocio que otro con 60 de mercado y 78 % de entrega.
//
// PRIVACIDAD (§8, §15): de aquí solo salen AGREGADOS a nivel de producto o
// categoría. Ni un teléfono, ni un correo, ni una dirección, ni un pedido
// individual. Y nada de esto se manda nunca a un modelo de lenguaje.
// ============================================================

import { systemDbHandle } from "../../db";
import { getCodAutoInputs } from "../../cod-calculator/auto-inputs";
import { measured, unknownMetric, type Measured } from "../provenance";
import type { CapabilityStatus, ProviderCapability, ProviderHealth } from "../types";
import type { IntelligenceProvider } from "./types";
import { noCapabilities } from "./types";

const PROVIDER = "casamable_internal" as const;

/** Por debajo de esto, la media es anécdota y no dato. */
export const MIN_SAMPLE = 8;

export interface CategoryPerformance {
  category: string | null;
  orders: number;
  deliveryRate: Measured<number>;
  refusalRate: Measured<number>;
  cancellationRate: Measured<number>;
  /** Muestra usada. Si es pequeña, la confianza baja sola. */
  sample: number;
}

export interface InternalRates {
  deliveryRate: Measured<number>;
  shippingRate: Measured<number>;
  rawCPA: Measured<number>;
  outboundShippingCost: number;
  codFee: number;
  returnCost: number;
  vatRate: number;
  otherCostPerOrder: number;
}

/**
 * Tasas globales del negocio, reutilizando el mismo origen que la Calculadora
 * COD para que radar y calculadora nunca se contradigan.
 */
export function getInternalRates(): InternalRates {
  const auto = getCodAutoInputs();
  const conf = (sample: number | null | undefined): number => {
    const n = sample ?? 0;
    if (n <= 0) return 0;
    // La confianza crece con la muestra y se satura: 40 pedidos ya es sólido.
    return Math.min(0.95, 0.3 + (Math.min(n, 40) / 40) * 0.65);
  };
  return {
    deliveryRate:
      auto.deliveryRate.value === null
        ? unknownMetric<number>("INTERNAL_REAL", "sin cierres conocidos")
        : measured(auto.deliveryRate.value, "INTERNAL_REAL", {
            source: auto.deliveryRate.detail,
            confidence: conf(auto.deliveryRate.sample),
          }),
    shippingRate:
      auto.shippingRate.value === null
        ? unknownMetric<number>("INTERNAL_REAL", "sin datos de envío")
        : measured(auto.shippingRate.value, "INTERNAL_REAL", {
            source: auto.shippingRate.detail,
            confidence: conf(auto.shippingRate.sample),
          }),
    rawCPA:
      auto.cpa.value === null
        ? unknownMetric<number>("INTERNAL_REAL", "sin gasto publicitario registrado")
        : measured(auto.cpa.value, "INTERNAL_REAL", {
            source: auto.cpa.detail,
            confidence: conf(auto.cpa.sample),
          }),
    outboundShippingCost: auto.defaults.outboundShippingCost,
    codFee: auto.defaults.codFee,
    returnCost: auto.defaults.returnCost,
    vatRate: auto.defaults.vatRate,
    otherCostPerOrder: auto.defaults.otherCostPerOrder,
  };
}

/**
 * Rendimiento histórico agregado. Sin categorías en el modelo de pedidos, se
 * agrega por producto — y se dice claramente que es global cuando lo es, en
 * vez de presentar la media de todo como si fuera "de esta categoría".
 */
export function getCategoryPerformance(_category: string | null): CategoryPerformance {
  try {
    const db = systemDbHandle();
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN closure_status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN closure_status = 'refused'   THEN 1 ELSE 0 END) AS refused,
           SUM(CASE WHEN closure_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN closure_status IN ('delivered','refused','cancelled') THEN 1 ELSE 0 END) AS closed
         FROM orders
         WHERE status NOT IN ('ignored_old')`
      )
      .get() as { total: number; delivered: number; refused: number; cancelled: number; closed: number };

    const closed = row?.closed ?? 0;
    if (!row || closed < MIN_SAMPLE) {
      // Muestra insuficiente: se devuelve la ausencia, no una media frágil.
      return {
        category: null,
        orders: row?.total ?? 0,
        deliveryRate: unknownMetric<number>("INTERNAL_REAL", `muestra insuficiente (${closed} cierres)`),
        refusalRate: unknownMetric<number>("INTERNAL_REAL", `muestra insuficiente (${closed} cierres)`),
        cancellationRate: unknownMetric<number>("INTERNAL_REAL", `muestra insuficiente (${closed} cierres)`),
        sample: closed,
      };
    }
    const detail = `${closed} cierres conocidos`;
    const confidence = Math.min(0.9, 0.35 + (Math.min(closed, 60) / 60) * 0.55);
    return {
      category: null,
      orders: row.total,
      deliveryRate: measured(row.delivered / closed, "INTERNAL_REAL", { source: detail, confidence }),
      refusalRate: measured(row.refused / closed, "INTERNAL_REAL", { source: detail, confidence }),
      cancellationRate: measured(row.cancelled / closed, "INTERNAL_REAL", { source: detail, confidence }),
      sample: closed,
    };
  } catch {
    return {
      category: null,
      orders: 0,
      deliveryRate: unknownMetric<number>("INTERNAL_REAL", "no se pudo consultar"),
      refusalRate: unknownMetric<number>("INTERNAL_REAL", "no se pudo consultar"),
      cancellationRate: unknownMetric<number>("INTERNAL_REAL", "no se pudo consultar"),
      sample: 0,
    };
  }
}

export class CasamableInternalProvider implements IntelligenceProvider {
  readonly id = PROVIDER;

  capabilities(): Record<ProviderCapability, CapabilityStatus> {
    return { ...noCapabilities(), INTERNAL_METRICS: "AVAILABLE" };
  }

  async health(): Promise<ProviderHealth> {
    const perf = getCategoryPerformance(null);
    return {
      id: PROVIDER,
      status: "READY",
      detail:
        perf.sample >= MIN_SAMPLE
          ? `Listo · ${perf.orders} pedidos, ${perf.sample} cierres conocidos.`
          : `Listo, pero con poco histórico (${perf.sample} cierres): las tasas propias aún no se usan.`,
      capabilities: this.capabilities(),
      creditsRemaining: null,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }
}
