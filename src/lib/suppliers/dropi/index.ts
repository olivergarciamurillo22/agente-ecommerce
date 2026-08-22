// ============================================================
// Dropi PRO — STUB. NO habla con ninguna API todavía.
//
// Pendiente del handoff: endpoints, formato de autenticación, esquema del
// pedido, catálogo/SKUs y semántica de estados. Hasta entonces, cualquier
// operación real lanza ProviderNotConfiguredError a propósito: un mock
// silencioso que "pareciera" funcionar sería mucho peor.
// ============================================================

import { dropiCredentialsPresent } from "./client";
import {
  ProviderNotConfiguredError,
  type SupplierCreateResult,
  type SupplierOrderInput,
  type SupplierProvider,
  type SupplierStatusResult,
  type SupplierValidationResult,
} from "../types";

const PLATFORM = "dropi" as const;

export const dropiProvider: SupplierProvider = {
  platform: PLATFORM,

  /**
   * Hay credenciales, pero NO hay cliente HTTP implementado (falta el
   * handoff). Devolver false aquí es lo que impide que el sistema intente
   * una llamada real: el día que exista el cliente, esto pasará a
   * `return dropiCredentialsPresent();`.
   */
  isConfigured(): boolean {
    return false;
  },

  /** ¿Están puestas las credenciales? (informativo para el panel/simulador) */
  hasCredentials(): boolean {
    return dropiCredentialsPresent();
  },

  validateOrder(input: SupplierOrderInput): SupplierValidationResult {
    // Validaciones genéricas mientras no conozcamos las suyas.
    const issues: string[] = [];
    if (!input.items.length) issues.push("el pedido no tiene productos");
    if (!input.phone) issues.push("falta el teléfono del cliente");
    if (!input.finalAddress.city) issues.push("falta la localidad");
    return { ok: issues.length === 0, issues };
  },

  simulateCreateOrder(input: SupplierOrderInput): SupplierCreateResult {
    // Simulación local, sin red: solo confirma qué se enviaría.
    return {
      externalOrderId: `SIMULATED-DROPI-${input.shopifyOrderId}`,
      status: "simulated",
      simulated: true,
    };
  },

  async createOrder(): Promise<SupplierCreateResult> {
    throw new ProviderNotConfiguredError(PLATFORM, "falta el handoff de la API de Dropi PRO");
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
