// ============================================================
// Puerta de CREACIÓN de pedidos en Dropea.
//
// Contexto real: la app oficial de Dropea en Shopify SIGUE ACTIVA y crea los
// pedidos por su cuenta. Si nosotros también los creáramos, cada compra se
// enviaría dos veces al cliente. Por eso el modo por defecto es
// `external_app`: leemos, seguimos el envío y avisamos al cliente, pero NO
// creamos nada.
//
// Esto no es una convención documental: `canCreateDropeaOrder()` lo impone, y
// `createOrder()` del provider pasa por aquí antes de tocar la red.
// ============================================================

import type { OrderRow } from "../../db";
import { emergencyStop, orderActionAllowed, testMode } from "../../safety";
import {
  supplierSyncEnabled,
  supplierPilotMode,
  legacyIntegrationsDisabled,
} from "../service";
import { dropeaReadEnabled } from "./client";

/**
 * Quién crea los pedidos en Dropea:
 *   external_app → los crea su app oficial de Shopify (POR DEFECTO)
 *   our_api      → los crearíamos nosotros por API
 */
export type DropeaCreateMode = "external_app" | "our_api";

/** Modo actual. Cualquier valor que no sea "our_api" se trata como external_app. */
export function dropeaCreateMode(): DropeaCreateMode {
  return process.env.DROPEA_CREATE_MODE === "our_api" ? "our_api" : "external_app";
}

/**
 * ¿Sigue activa la app oficial de Dropea creando pedidos?
 * Por defecto SÍ (se asume lo peor): mientras lo esté, nosotros no creamos.
 */
export function dropeaLegacyCreateActive(): boolean {
  return process.env.DROPEA_LEGACY_CREATE_ACTIVE !== "0";
}

export interface CreateGateResult {
  allowed: boolean;
  /** Motivo del bloqueo, en cristiano, para el panel y los logs. */
  reason: string | null;
  /** Identificador corto del freno que saltó (para tests y métricas). */
  blocker: string | null;
}

const no = (blocker: string, reason: string): CreateGateResult => ({
  allowed: false,
  reason,
  blocker,
});

/**
 * ¿Se puede crear ESTE pedido en Dropea, de verdad?
 *
 * Exige que TODAS las condiciones se cumplan a la vez. El orden va de lo más
 * peligroso a lo más específico, para que el motivo que se muestra sea el que
 * de verdad importa.
 */
export function canCreateDropeaOrder(order: OrderRow): CreateGateResult {
  // 1. Interruptores generales.
  if (emergencyStop()) return no("emergency_stop", "EMERGENCY_STOP activo");

  // 2. ¿Quién crea los pedidos? Este es el freno que importa hoy.
  if (dropeaCreateMode() !== "our_api") {
    return no(
      "create_mode_external_app",
      "DROPEA_CREATE_MODE=external_app: los pedidos los crea la app oficial de Dropea en Shopify. " +
        "Crearlos también nosotros los duplicaría"
    );
  }

  // 3. Aunque el modo sea our_api, si la app oficial sigue viva NO se crea.
  //    Son dos llaves distintas a propósito: cambiar el modo no basta.
  if (dropeaLegacyCreateActive()) {
    return no(
      "legacy_app_active",
      "DROPEA_LEGACY_CREATE_ACTIVE=1: la app oficial de Dropea sigue creando pedidos. " +
        "Hay que desactivarla antes de que creemos nosotros"
    );
  }

  // 4. Candado general contra integraciones antiguas (cubre también Dropi).
  if (!legacyIntegrationsDisabled()) {
    return no(
      "legacy_integrations",
      "LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0: hay otra integración Shopify→proveedor activa"
    );
  }

  // 5. Llaves del subsistema de proveedores.
  if (!supplierSyncEnabled()) return no("supplier_sync", "SUPPLIER_SYNC_ENABLED=0");
  if (!dropeaReadEnabled()) return no("api_disabled", "DROPEA_API_ENABLED=0 o falta la API key");
  if (process.env.DROPEA_WRITE_ENABLED !== "1") {
    return no("write_disabled", "DROPEA_WRITE_ENABLED=0");
  }

  // 6. Estado del pedido e idempotencia.
  if (order.supplier_external_order_id) {
    return no("already_exists", "el pedido ya existe en Dropea (idempotencia)");
  }
  if (order.status !== "confirmed") {
    return no("not_confirmed", `el pedido está en "${order.status}", no confirmado por el cliente`);
  }
  if (order.supplier_create_phase === "creating" || order.supplier_create_phase === "confirming") {
    return no("in_flight", `ya hay una operación en curso (${order.supplier_create_phase})`);
  }

  // 7. Piloto: durante las pruebas, uno a uno.
  if (!orderActionAllowed(order)) {
    return no("not_allowlisted", "pedido fuera de allowlist y sin autorizar");
  }
  if (supplierPilotMode() && order.supplier_pilot_approved !== 1) {
    return no("pilot_not_approved", "el pedido no está aprobado para el piloto de proveedores");
  }
  // Durante el piloto exigimos TEST_MODE: es la red que impide que un fallo
  // de routing alcance a toda la clientela.
  if (supplierPilotMode() && !testMode()) {
    return no("pilot_without_test_mode", "el piloto exige TEST_MODE=1");
  }

  return { allowed: true, reason: null, blocker: null };
}

/** Resumen del modo, para el panel y el diagnóstico. */
export function dropeaCreateModeSummary(): {
  mode: DropeaCreateMode;
  legacyAppActive: boolean;
  writeEnabled: boolean;
  apiEnabled: boolean;
} {
  return {
    mode: dropeaCreateMode(),
    legacyAppActive: dropeaLegacyCreateActive(),
    writeEnabled: process.env.DROPEA_WRITE_ENABLED === "1",
    apiEnabled: dropeaReadEnabled(),
  };
}
