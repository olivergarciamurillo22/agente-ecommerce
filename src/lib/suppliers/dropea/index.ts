// ============================================================
// Provider de Dropea — implementado contra su contrato oficial.
//
// Separación importante:
//   LECTURA  (getOrder, getStatus, findByExternalReference) → requiere
//            DROPEA_API_ENABLED=1. Es segura: no modifica nada.
//   ESCRITURA (createOrder, cancelOrder) → además de los safety gates
//            generales, exige DROPEA_WRITE_ENABLED=1 aquí mismo.
//
// Así se puede usar la API de verdad (consultar estados, tracking, catálogo)
// SIN posibilidad de crear ni cancelar pedidos.
// ============================================================

import pino from "pino";
import {
  dropeaCredentialsPresent,
  dropeaReadEnabled,
  dropeaRequest,
  DropeaApiError,
} from "./client";
import { normalizeDropeaStatus } from "./status-map";
import { dropeaCreateMode } from "./create-gate";
import type { DropeaCreateOrderRequest, DropeaOrder, DropeaProduct } from "./types";
import {
  ProviderNotConfiguredError,
  type SupplierCreateResult,
  type SupplierOrderInput,
  type SupplierProvider,
  type SupplierStatusResult,
  type SupplierValidationResult,
} from "../types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const PLATFORM = "dropea" as const;

/** ¿Se permite ESCRIBIR en Dropea? (segunda llave, específica del proveedor) */
export function dropeaWriteEnabled(): boolean {
  return process.env.DROPEA_WRITE_ENABLED === "1" && dropeaReadEnabled();
}

// --- Operaciones de LECTURA (seguras) ---

export async function getDropeaOrder(orderId: string | number): Promise<DropeaOrder> {
  return dropeaRequest<DropeaOrder>({ path: `/dropshipper/orders/${orderId}` });
}

/** Comprobación de credenciales: quién soy. No modifica nada. */
export async function getDropeaMe(): Promise<Record<string, unknown>> {
  return dropeaRequest<Record<string, unknown>>({ path: "/dropshipper/me" });
}

/** Tiendas del dropshipper: de aquí sale el `store_id` para crear pedidos. */
export async function listDropeaShops(): Promise<unknown> {
  return dropeaRequest<unknown>({ path: "/dropshipper/shops", query: { limit: 20 } });
}

/** Catálogo: de aquí salen los `variant_id` que hay que emparejar. */
export async function listDropeaProducts(page = 1, limit = 50): Promise<{ items?: DropeaProduct[] }> {
  return dropeaRequest<{ items?: DropeaProduct[] }>({
    path: "/dropshipper/products",
    query: { page, limit },
  });
}

/** Catálogo oficial de estados (para verificar nuestro mapa). */
export async function listDropeaOrderStatuses(): Promise<unknown> {
  return dropeaRequest<unknown>({ path: "/dropshipper/catalogs/order-statuses" });
}

/** Suscripciones de webhook registradas con esta API key. */
export async function listDropeaWebhooks(): Promise<unknown> {
  return dropeaRequest<unknown>({ path: "/dropshipper/webhooks" });
}

/**
 * DEFENSA ANTI-DUPLICADO: busca en Dropea un pedido con nuestra referencia.
 * Si la integración antigua (o un intento previo) ya lo creó, aparece aquí y
 * se adopta su id en vez de crear otro.
 */
export async function findDropeaOrderByExternalId(
  externalOrderId: string
): Promise<DropeaOrder | null> {
  const res = await dropeaRequest<{ items?: DropeaOrder[] }>({
    path: "/dropshipper/orders",
    query: { external_order_id: externalOrderId, limit: 5 },
  });
  const items = res?.items ?? [];
  // Coincidencia exacta: el filtro es bidireccional ("#3305" y "3305"), así
  // que comparamos sin el "#" para no adoptar un pedido ajeno por error.
  const limpia = (v: string | null | undefined) => (v ?? "").replace(/^#/, "").trim();
  return items.find((o) => limpia(o.external_order_id) === limpia(externalOrderId)) ?? null;
}

export const dropeaProvider: SupplierProvider = {
  platform: PLATFORM,

  /** Listo para operar de verdad: credenciales + lectura habilitada. */
  isConfigured(): boolean {
    return dropeaReadEnabled();
  },

  hasCredentials(): boolean {
    return dropeaCredentialsPresent();
  },

  validateOrder(input: SupplierOrderInput): SupplierValidationResult {
    // Requisitos que impone el contrato de Dropea (§5 del contrato).
    const issues: string[] = [];
    if (!input.items.length) issues.push("el pedido no tiene productos");
    if (!input.phone) issues.push("falta el teléfono del cliente");
    if (!input.email) issues.push("Dropea exige email del cliente");
    if (!input.finalAddress.city) issues.push("falta la localidad");
    if (!input.finalAddress.postalCode) issues.push("falta el código postal");
    if (!input.finalAddress.line1) issues.push("falta la calle");
    return { ok: issues.length === 0, issues };
  },

  simulateCreateOrder(input: SupplierOrderInput): SupplierCreateResult {
    return {
      externalOrderId: `SIMULATED-DROPEA-${input.shopifyOrderId}`,
      status: "simulated",
      simulated: true,
    };
  },

  /**
   * Crear pedido. Además de los safety gates generales, exige
   * DROPEA_WRITE_ENABLED=1: con la API en solo-lectura esto falla siempre.
   *
   * NOTA: crear deja el pedido en PENDING. Para que llegue al proveedor hace
   * falta `confirmDropeaOrder()`, que es una decisión aparte y consciente.
   */
  /**
   * Crear pedido. HOY BLOQUEADO por `canCreateDropeaOrder()`: con
   * DROPEA_CREATE_MODE=external_app los pedidos los crea su app de Shopify.
   *
   * La ruta técnica está preparada (mapper, idempotencia, máquina de estados
   * create→confirm) pero no se ejecuta hasta que todas las llaves se abran.
   */
  async createOrder(input: SupplierOrderInput): Promise<SupplierCreateResult> {
    // Sin un pedido concreto no se puede evaluar el gate: se falla cerrado.
    throw new ProviderNotConfiguredError(
      PLATFORM,
      `creación bloqueada (modo ${dropeaCreateMode()}). Usa createDropeaOrderForOrder(), ` +
        `que evalúa el gate sobre el pedido ${input.shopifyOrderId}`
    );
  },

  async getOrder(externalOrderId: string): Promise<unknown> {
    if (!dropeaReadEnabled()) throw new ProviderNotConfiguredError(PLATFORM, "lectura no habilitada");
    return getDropeaOrder(externalOrderId);
  },

  async getStatus(externalOrderId: string): Promise<SupplierStatusResult> {
    if (!dropeaReadEnabled()) throw new ProviderNotConfiguredError(PLATFORM, "lectura no habilitada");
    const order = await getDropeaOrder(externalOrderId);
    // El tracking vive en el propio pedido: no hay endpoint aparte.
    return {
      status: order.sub_status ? `${order.status}.${order.sub_status}` : String(order.status),
      trackingNumber: order.tracking_number ?? null,
      trackingUrl: order.tracking_url ?? null,
      carrier: order.carrier ?? null,
    };
  },

  /** Mismo dato que getStatus: en Dropea el tracking es parte del pedido. */
  async getTracking(externalOrderId: string): Promise<SupplierStatusResult> {
    return this.getStatus(externalOrderId);
  },

  async cancelOrder(): Promise<void> {
    throw new ProviderNotConfiguredError(
      PLATFORM,
      "la cancelación no está habilitada: es una acción irreversible sobre un pedido real"
    );
  },
};

/** Traduce la respuesta de la API al estado normalizado nuestro. */
export function dropeaOrderToTrackingStatus(order: DropeaOrder) {
  return normalizeDropeaStatus(order.status, order.sub_status ?? null);
}

export { DropeaApiError };
export type { DropeaCreateOrderRequest };
