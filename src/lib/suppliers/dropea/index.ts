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

import { dropeaCredentialsPresent } from "./client";
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

  /**
   * Hay credenciales, pero NO hay cliente HTTP implementado (falta el
   * handoff). Devolver false aquí es lo que impide que el sistema intente
   * una llamada real: el día que exista el cliente, esto pasará a
   * `return dropeaCredentialsPresent();`.
   */
  isConfigured(): boolean {
    return false;
  },

  /** ¿Están puestas las credenciales? (informativo para el panel/simulador) */
  hasCredentials(): boolean {
    return dropeaCredentialsPresent();
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
