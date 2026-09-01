// ============================================================
// Tipos del contrato público de Beeping Fulfilment.
// Fuente: docs/BEEPING-API-CONTRACT.md (help.gobeeping.com, categoría
// "Configuring the API"). NO verificado contra la API real todavía: las
// formas de respuesta se parsean a la defensiva en client.ts y aquí solo
// se declara lo DOCUMENTADO. No inventar campos.
// ============================================================

/** Catálogo documentado de `status` del pedido en Beeping. */
export const BEEPING_ORDER_STATUS = {
  0: "cancelled",
  1: "pending",
  2: "pending_stock",
  3: "in_preparation",
  4: "shipped",
  5: "returned",
  6: "to_be_confirmed",
} as const;

export type BeepingOrderStatusCode = keyof typeof BEEPING_ORDER_STATUS;

/** Catálogo documentado de `tracking_stage` (estado logístico). */
export const BEEPING_LOGISTICS_STATUS = {
  1: "no_logistic_status",
  2: "in_transit",
  3: "out_for_delivery",
  4: "pickup_point",
  5: "delivered",
  6: "returned_to_sender",
  7: "cancelled",
  8: "damaged",
} as const;

export type BeepingLogisticsCode = keyof typeof BEEPING_LOGISTICS_STATUS;

/** Transportistas documentados (courier_id). */
export const BEEPING_COURIERS: Record<number, string> = {
  1: "Correos Express",
  3: "Correos",
  5: "GLS",
  9: "GLS-14",
  10: "GLS-19",
  11: "GLS-INTERNACIONAL",
};

export interface BeepingShop {
  id: number;
  name: string;
  /** Resto de campos que devuelva get_shops, sin interpretar. */
  raw: Record<string, unknown>;
}

export interface BeepingOrderLine {
  name: string | null;
  sku: string | null;
  qty: number | null;
  amount: number | null;
  raw: Record<string, unknown>;
}

/** Un pedido tal y como lo devuelve GET /api/get_orders. */
export interface BeepingOrder {
  /** ID del pedido en la tienda (para Shopify, el ID del pedido). Clave. */
  external_id: string;
  ref: string | null;
  shop_id: number | null;
  /** 0-6 según BEEPING_ORDER_STATUS. null si el payload no lo trae legible. */
  status: number | null;
  /** 1-8 según BEEPING_LOGISTICS_STATUS. */
  tracking_stage: number | null;
  tracking_number: string | null;
  courier_id: number | null;
  payment_method: string | null;
  payment_method_id: number | null;
  amount: number | null;
  financial_status: string | null;
  date: string | null;
  /** Base del polling incremental. */
  date_tracking_update: string | null;
  lines: BeepingOrderLine[];
  /** Payload completo sin interpretar (para diagnóstico; nunca al panel). */
  raw: Record<string, unknown>;
}

export interface BeepingListOrdersFilters {
  /** Lista de external_id separados por comas. */
  in?: string[];
  /** dd-mm-yyyy (formato documentado por Beeping). */
  fromDate?: string;
  shopId?: number;
  perPage?: number;
  page?: number;
}
