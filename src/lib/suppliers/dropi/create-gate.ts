// ⛔ DROPI NO DISPONE DE API PÚBLICA (confirmado con su soporte, 25-08-2026).
// NO implementar writes/API sin evidencia nueva. La vía real es su app de
// Shopify (campo *vendor* del producto). Ver docs/DROPI-API-CONTRACT.md.
// ============================================================
// Puerta de CREACIÓN de pedidos en Dropi PRO.
//
// Contexto real: la app "Dropify PRO" de Shopify está ROTA y Pedro mete
// los pedidos a mano. DROPI NO TIENE API PÚBLICA (confirmado 25-08): esta
// puerta existe como capa de seguridad fail-closed, NO como preparación de
// una integración futura — cada llave tiene que estar explícitamente
// abierta Y el cliente HTTP tiene que existir (y no existe a propósito).
//
// Mismo patrón que Dropea (`dropea/create-gate.ts`): el orden de los frenos
// va del más peligroso al más específico, para que el motivo mostrado sea
// el que de verdad importa.
// ============================================================

import type { OrderRow } from "../../db";
import { emergencyStop, orderActionAllowed, testMode } from "../../safety";
import { supplierSyncEnabled, supplierPilotMode, legacyIntegrationsDisabled } from "../service";
import { dropiProvider } from "./index";

export interface DropiCreateGateResult {
  allowed: boolean;
  reason: string | null;
  blocker: string | null;
}

const no = (blocker: string, reason: string): DropiCreateGateResult => ({
  allowed: false,
  reason,
  blocker,
});

/** Interruptor propio de creación en Dropi (además de DROPIPRO_WRITE_ENABLED). */
export function dropiCreateEnabled(): boolean {
  return process.env.DROPIPRO_CREATE_ENABLED === "1";
}

/**
 * ¿Se puede crear ESTE pedido en Dropi PRO, de verdad?
 * Exige TODAS las condiciones a la vez.
 */
export function canCreateDropiOrder(order: OrderRow): DropiCreateGateResult {
  // 1. Freno general.
  if (emergencyStop()) return no("emergency_stop", "EMERGENCY_STOP activo");

  // 2. Sin cliente HTTP real no hay nada que hacer (falta la API de Dropi).
  if (!dropiProvider.isConfigured()) {
    return no(
      "client_not_implemented",
      "el cliente de Dropi PRO no está implementado: falta la documentación de su API (soporte Dropi)"
    );
  }

  // 3. Candado contra integraciones antiguas (la app Dropify PRO, aunque
  //    rota, sigue instalada: si la arreglan sin avisar, duplicaríamos).
  if (!legacyIntegrationsDisabled()) {
    return no(
      "legacy_integrations",
      "LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0: la app Dropify PRO sigue instalada en Shopify"
    );
  }

  // 4. Llaves del subsistema y de la plataforma.
  if (!supplierSyncEnabled()) return no("supplier_sync", "SUPPLIER_SYNC_ENABLED=0");
  if (process.env.DROPIPRO_WRITE_ENABLED !== "1") return no("write_disabled", "DROPIPRO_WRITE_ENABLED=0");
  if (!dropiCreateEnabled()) return no("create_disabled", "DROPIPRO_CREATE_ENABLED=0");

  // 5. Estado del pedido e idempotencia.
  if (order.supplier_external_order_id) {
    return no("already_exists", "el pedido ya existe en el proveedor (idempotencia)");
  }
  if (order.status !== "confirmed") {
    return no("not_confirmed", `el pedido está en "${order.status}", no confirmado por el cliente`);
  }
  if (order.supplier_platform !== "dropi") {
    return no("not_routed_to_dropi", `el routing dice "${order.supplier_platform ?? "sin resolver"}", no dropi`);
  }
  if (order.supplier_create_phase === "creating" || order.supplier_create_phase === "confirming") {
    return no("in_flight", `ya hay una operación en curso (${order.supplier_create_phase})`);
  }

  // 6. Piloto: uno a uno y con TEST_MODE.
  if (!orderActionAllowed(order)) return no("not_allowlisted", "pedido fuera de allowlist y sin autorizar");
  if (supplierPilotMode() && order.supplier_pilot_approved !== 1) {
    return no("pilot_not_approved", "el pedido no está aprobado para el piloto de proveedores");
  }
  if (supplierPilotMode() && !testMode()) return no("pilot_without_test_mode", "el piloto exige TEST_MODE=1");

  return { allowed: true, reason: null, blocker: null };
}
