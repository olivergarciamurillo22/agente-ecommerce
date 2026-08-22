// ============================================================
// Dropea — STUB. NO habla con ninguna API todavía.
//
// Mismo criterio que Dropi: sin handoff no hay implementación real, y las
// operaciones de escritura fallan de forma ruidosa en vez de fingir éxito.
// (Ojo: los pedidos reales de Casamable llegan con tags `dropea_error` y
// "Sync ERROR - Dropi PRO", señal de que ya existe una integración externa
// funcionando por su cuenta. Habrá que aclarar en el handoff cómo convive
// con la nuestra para no duplicar pedidos.)
// ============================================================

import {
  ProviderNotConfiguredError,
  type SupplierCreateResult,
  type SupplierOrderInput,
  type SupplierProvider,
  type SupplierStatusResult,
  type SupplierValidationResult,
} from "../types";

const PLATFORM = "dropea" as const;

export const dropeaProvider: SupplierProvider = {
  platform: PLATFORM,

  isConfigured(): boolean {
    return false; // sin implementación real todavía
  },

  validateOrder(input: SupplierOrderInput): SupplierValidationResult {
    const issues: string[] = [];
    if (!input.items.length) issues.push("el pedido no tiene productos");
    if (!input.phone) issues.push("falta el teléfono del cliente");
    if (!input.finalAddress.postalCode) issues.push("falta el código postal");
    return { ok: issues.length === 0, issues };
  },

  simulateCreateOrder(input: SupplierOrderInput): SupplierCreateResult {
    return {
      externalOrderId: `SIMULATED-DROPEA-${input.shopifyOrderId}`,
      status: "simulated",
      simulated: true,
    };
  },

  async createOrder(): Promise<SupplierCreateResult> {
    throw new ProviderNotConfiguredError(PLATFORM, "falta el handoff de la API de Dropea");
  },
  async getOrder(): Promise<unknown> {
    throw new ProviderNotConfiguredError(PLATFORM);
  },
  async getStatus(): Promise<SupplierStatusResult> {
    throw new ProviderNotConfiguredError(PLATFORM);
  },
  async getTracking(): Promise<SupplierStatusResult> {
    throw new ProviderNotConfiguredError(PLATFORM);
  },
  async cancelOrder(): Promise<void> {
    throw new ProviderNotConfiguredError(PLATFORM);
  },
};
