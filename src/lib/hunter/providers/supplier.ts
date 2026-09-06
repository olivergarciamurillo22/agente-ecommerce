// ============================================================
// AI Winner Radar — PROVEEDORES DE SUMINISTRO, SOLO LECTURA.
//
// GARANTÍA ESTRUCTURAL, no un flag: este fichero NO importa ni una función de
// escritura de proveedor. Nada de `createDropeaOrderForOrder`,
// `confirmDropeaOrder`, `adoptDropeaOrder` ni release de Beeping. Un
// `if (readOnly) return` se borra en un refactor; un import que no existe, no.
// Hay un test que lee este fichero y falla si aparece uno de esos imports —
// misma idea que la salvaguarda de WhatsApp en los scripts de datos.
//
// Realidad de hoy, sin adornos:
//   · Dropea es read-only por contrato (external_app) y su API responde por
//     PEDIDO, no por catálogo: no hay "buscar producto por nombre".
//   · Dropi NO tiene API pública. No se implementa ningún cliente.
//   · Beeping está detrás de gates fail-closed.
// Por eso este proveedor responde PARTIAL: existe y es honesto sobre lo poco
// que puede afirmar. Inventar un catálogo aquí sería el peor engaño del
// módulo, porque el coste de proveedor es el número que decide si un producto
// entra o no.
// ============================================================

import { systemDbHandle } from "../../db";
import { measured, unknownMetric, type Measured } from "../provenance";
import type { CapabilityStatus, ProviderCapability, ProviderHealth } from "../types";
import type { IntelligenceProvider } from "./types";
import { noCapabilities } from "./types";

const PROVIDER = "supplier" as const;

export interface SupplierLookup {
  /** `null` = NO COMPROBADO. Distinto de `false` = comprobado y sin stock. */
  available: boolean | null;
  cost: Measured<number>;
  leadTimeDays: number | null;
  supplierName: string | null;
  detail: string;
}

/**
 * Lo único que se puede afirmar hoy con datos propios: si YA hemos vendido
 * algo parecido, sabemos lo que nos costó de verdad. Es poco, pero es cierto.
 */
export function lookupSupplierCost(productName: string): SupplierLookup {
  const nombre = productName.trim();
  if (!nombre) {
    return notChecked("sin nombre de producto que buscar");
  }
  try {
    const db = systemDbHandle();
    // Coste real de productos que ya vendemos, si están en la tabla de costes.
    const row = db
      .prepare(
        `SELECT sku, title, product_cost
           FROM product_costs
          WHERE product_cost IS NOT NULL
            AND title IS NOT NULL
            AND lower(title) LIKE lower(?)
          ORDER BY updated_at DESC
          LIMIT 1`
      )
      .get(`%${nombre.slice(0, 40)}%`) as { sku: string; title: string | null; product_cost: number } | undefined;

    if (row && Number.isFinite(row.product_cost)) {
      return {
        available: true,
        cost: measured(row.product_cost, "INTERNAL_REAL", { source: `coste real de "${row.title ?? row.sku}"`, confidence: 0.9 }),
        leadTimeDays: null,
        supplierName: null,
        detail: "Coste tomado de un producto que ya vendemos.",
      };
    }
  } catch {
    /* la tabla puede no existir todavía: no es un error del radar */
  }
  return notChecked("no tenemos coste real de un producto parecido");
}

function notChecked(motivo: string): SupplierLookup {
  return {
    // `null`, no `false`: no haberlo mirado no es lo mismo que no haberlo.
    // Poner `false` aquí penalizaría el score de todo producto nuevo, que es
    // justo el que interesa descubrir.
    available: null,
    cost: unknownMetric<number>("INTERNAL_REAL", motivo),
    leadTimeDays: null,
    supplierName: null,
    detail: motivo,
  };
}

export class SupplierProvider implements IntelligenceProvider {
  readonly id = PROVIDER;

  capabilities(): Record<ProviderCapability, CapabilityStatus> {
    // UNVERIFIED y no AVAILABLE: solo responde cuando el producto coincide
    // con algo que ya vendemos. Para un producto nuevo no sabe nada.
    return { ...noCapabilities(), SUPPLIER_COST: "UNVERIFIED" };
  }

  async health(): Promise<ProviderHealth> {
    let conocidos = 0;
    try {
      const r = systemDbHandle().prepare("SELECT COUNT(*) AS n FROM product_costs").get() as { n: number } | undefined;
      conocidos = r?.n ?? 0;
    } catch {
      conocidos = 0;
    }
    return {
      id: PROVIDER,
      status: "PARTIAL",
      detail:
        `Solo lectura. Sabe el coste de ${conocidos} producto(s) que ya vendemos. ` +
        "Dropi no tiene API pública y Dropea responde por pedido, no por catálogo: " +
        "para un producto nuevo el coste hay que meterlo a mano.",
      capabilities: this.capabilities(),
      creditsRemaining: null,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }
}
