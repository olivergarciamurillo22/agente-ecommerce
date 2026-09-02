// ============================================================
// Tipos del contrato oficial de Dropea (OpenAPI 3.0.3 verificado).
// Ver docs/DROPEA-API-CONTRACT.md
//
// Estos tipos describen la API de Dropea, NO nuestro modelo. La traducción
// entre ambos vive en mapper.ts: así el resto del sistema no queda acoplado.
// ============================================================

import type { DropeaStatus, DropeaSubStatus } from "./status-map";

export type DropeaPaymentMethod =
  | "COD"
  | "PAYPAL"
  | "STRIPE"
  | "SHOPIFY_PAYMENTS"
  | "PAID"
  | "MANUAL"
  | "OTHER";

/** Topics de webhook, tal cual los define el spec (minúsculas con puntos). */
export type DropeaWebhookTopic =
  | "order.created"
  | "order.status.changed"
  | "order.cancelled"
  | "issue.created"
  | "issue.status.changed"
  | "issue.resolved";

export const DROPEA_WEBHOOK_TOPICS: DropeaWebhookTopic[] = [
  "order.created",
  "order.status.changed",
  "order.cancelled",
  "issue.created",
  "issue.status.changed",
  "issue.resolved",
];

export function isDropeaTopic(v: string): v is DropeaWebhookTopic {
  return (DROPEA_WEBHOOK_TOPICS as string[]).includes(v);
}

// --- Creación de pedido (POST /dropshipper/orders) ---

export interface DropeaShippingAddress {
  first_name: string;
  last_name: string;
  address_line_1: string;
  address_line_2?: string;
  city: string;
  /** OJO: `state` es la PROVINCIA, no el país. */
  state: string;
  postal_code: string;
  /** ISO-2, p. ej. "ES". */
  country: string;
}

export interface DropeaCustomerDetails {
  name: string;
  email: string;
  /** Número completo con prefijo, p. ej. "+34600111222". */
  phone: string;
  phone_country?: string;
  area_code?: string;
  phone_number?: string;
  shipping_address: DropeaShippingAddress;
}

export interface DropeaLineItemInput {
  /** Identificador de variante en el catálogo de Dropea (NO es el SKU). */
  variant_id: number;
  quantity: number;
  unit_price: number;
}

export interface DropeaCreateOrderRequest {
  store_id: number;
  line_items: DropeaLineItemInput[];
  customer_details: DropeaCustomerDetails;
  /** "COD" para contra reembolso: el importe se deriva de las líneas. */
  payment_method: DropeaPaymentMethod;
  carrier?: string;
  service_type?: string;
  /** Nuestra referencia (máx. 128). Se devuelve en cada lectura. */
  external_order_id?: string;
}

// --- Lectura de pedido ---

export interface DropeaOrder {
  id: number;
  status: DropeaStatus | string;
  sub_status?: DropeaSubStatus | string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  carrier?: string | null;
  service_type?: string | null;
  external_order_id?: string | null;
  total_amount?: number;
  currency?: string;
  store_id?: number;
  created_at?: string;
  updated_at?: string;
}

// --- Envoltorio de respuesta y errores ---

export interface DropeaFailure {
  type: string;
  message: string;
  /** Código de negocio (p. ej. ORDER_TOTAL_BELOW_COST) o null. */
  code?: string | null;
  httpStatusCode: number;
}

export interface DropeaEnvelope<T> {
  success: boolean;
  message?: string;
  data: T | null;
  failure?: DropeaFailure | null;
}

// --- Webhooks (envoltorio v2) ---

export interface DropeaWebhookEnvelope {
  topic: string;
  /** Mercado emisor: "ES", "PT", "IT". */
  market: string;
  /** UUID por entrega: sirve para deduplicar. */
  event_id: string;
  /** ISO 8601 UTC. */
  event_at: string;
  resource_id: number;
  resource: Record<string, unknown>;
}

/** Catálogo de productos (GET /dropshipper/products). */
export interface DropeaProductVariant {
  variant_id: number;
  sku: string;
  name: string;
  price: number;
  recommended_sale_price?: number;
  currency?: string;
  stock?: number;
}

export interface DropeaProduct {
  id: number;
  name?: string;
  status?: string;
  variants?: DropeaProductVariant[];
}
