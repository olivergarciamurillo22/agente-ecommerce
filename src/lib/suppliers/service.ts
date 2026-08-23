// ============================================================
// Servicio de proveedores: decide qué se PODRÍA hacer con un pedido y
// construye el DTO interno. HOY NO HACE NINGUNA LLAMADA DE RED.
//
// Cadena completa:
//   pedido confirmado → routing → dirección final → validación → DTO
//                                                        ↓
//                                        gate canSyncSupplier()
//                                                        ↓
//                              (con SUPPLIER_SYNC_ENABLED=0: solo simulación)
// ============================================================

import pino from "pino";
import type { OrderRow } from "../db";
import { emergencyStop, orderActionAllowed } from "../safety";
import { resolveFinalAddress, describeAddressIssue } from "./address";
import { resolveSupplier } from "./router";
import { orderLineItems } from "../orders/line-items";
import { dropiProvider } from "./dropi";
import { dropeaProvider } from "./dropea";
import {
  ProviderNotConfiguredError,
  type SupplierOrderInput,
  type SupplierPlatform,
  type SupplierProvider,
  type SupplierSyncStatus,
} from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

// --- Interruptores (todos cerrados por defecto) ---

/** Interruptor maestro de la sincronización con proveedores. */
export function supplierSyncEnabled(): boolean {
  return process.env.SUPPLIER_SYNC_ENABLED === "1";
}

/** En modo test (default) jamás se hace una llamada real, solo simulación. */
export function supplierTestMode(): boolean {
  return process.env.SUPPLIER_TEST_MODE !== "0";
}

/**
 * Modo piloto: mientras esté activo (por defecto lo está), un pedido solo
 * puede salir a proveedor si Pedro lo ha aprobado EXPLÍCITAMENTE. Se apaga
 * con SUPPLIER_PILOT_MODE=0, ya en producción plena.
 */
export function supplierPilotMode(): boolean {
  return process.env.SUPPLIER_PILOT_MODE !== "0";
}

/**
 * ¿Está confirmado que la integración ANTIGUA de Shopify→proveedor está
 * apagada? Por defecto NO: se asume que sigue viva y se bloquea la creación
 * para no duplicar envíos a clientes reales.
 */
export function legacyIntegrationsDisabled(): boolean {
  return process.env.LEGACY_SUPPLIER_INTEGRATIONS_DISABLED === "1";
}

/** Interruptor por plataforma (segunda llave, como en Shopify). */
export function platformWriteEnabled(platform: SupplierPlatform): boolean {
  if (platform === "dropi") return process.env.DROPIPRO_WRITE_ENABLED === "1";
  if (platform === "dropea") return process.env.DROPEA_WRITE_ENABLED === "1";
  return false;
}

export function getProvider(platform: SupplierPlatform): SupplierProvider | null {
  if (platform === "dropi") return dropiProvider;
  if (platform === "dropea") return dropeaProvider;
  return null;
}

// --- Evaluación de un pedido ---

export interface SupplierEvaluation {
  /** Estado de sincronización que le corresponde AHORA. */
  status: SupplierSyncStatus;
  platform: SupplierPlatform;
  /** Explicación en cristiano (va al panel y a supplier_last_error). */
  reason: string;
  /** DTO listo para el proveedor; null si el pedido no está en condiciones. */
  input: SupplierOrderInput | null;
}

/**
 * Analiza un pedido y decide su estado de proveedor. Función PURA: no toca
 * la base de datos ni la red, solo razona sobre la fila que recibe.
 */
export function evaluateOrderForSupplier(order: OrderRow): SupplierEvaluation {
  // 0. Ya sincronizado: idempotencia por encima de todo.
  if (order.supplier_external_order_id) {
    return {
      status: "synced",
      platform: (order.supplier_platform as SupplierPlatform) ?? "unknown",
      reason: `ya existe en el proveedor (${order.supplier_external_order_id}): no se recrea`,
      input: null,
    };
  }

  // 1. Solo se envían pedidos CONFIRMADOS por el cliente. La verdad es
  //    nuestro `orders.status`, no el tag de Shopify.
  if (order.status !== "confirmed") {
    return {
      status: "not_ready",
      platform: "unknown",
      reason: `el pedido está en "${order.status}": solo se envían los confirmados`,
      input: null,
    };
  }

  // 2. Routing. Sin reglas reales → revisión humana (nunca adivinar).
  const routing = resolveSupplier(order);
  if (routing.platform === "unknown" || routing.platform === "manual") {
    return {
      status: "manual_review",
      platform: routing.platform,
      reason: routing.reason,
      input: null,
    };
  }

  // 3. Dirección final: ¿cuál se usa y sirve para enviar?
  const dir = resolveFinalAddress(order);
  if (dir.needsReview) {
    return {
      status: "manual_review",
      platform: routing.platform,
      reason: dir.needsReview,
      input: null,
    };
  }
  if (!dir.address || !dir.validation.valid) {
    const motivos = dir.validation.issues.map(describeAddressIssue).join("; ");
    return {
      status: "blocked_address",
      platform: routing.platform,
      reason: `dirección no válida para envío: ${motivos || "datos insuficientes"}`,
      input: null,
    };
  }

  // 4. Construir el DTO neutro.
  const input: SupplierOrderInput = {
    shopifyOrderId: order.shopify_order_id,
    orderNumber: order.shopify_order_number,
    customerName: order.customer_name,
    phone: order.phone,
    email: order.email,
    finalAddress: dir.address,
    addressSource: dir.source ?? "original",
    items: buildItems(order),
    total: order.total_price,
    currency: order.currency,
    // COD: el cliente paga el total al repartidor.
    codAmount: order.total_price,
    deliveryNote: order.delivery_note,
  };

  // 5. Validación propia del proveedor.
  const provider = getProvider(routing.platform);
  if (!provider) {
    return {
      status: "manual_review",
      platform: routing.platform,
      reason: `no hay provider para "${routing.platform}"`,
      input,
    };
  }
  const val = provider.validateOrder(input);
  if (!val.ok) {
    return {
      status: "blocked_address",
      platform: routing.platform,
      reason: `el proveedor rechazaría el pedido: ${val.issues.join("; ")}`,
      input,
    };
  }

  return {
    status: "ready",
    platform: routing.platform,
    reason: `listo para enviar a ${routing.platform}`,
    input,
  };
}

/**
 * Artículos del DTO. Primero las líneas REALES del payload de Shopify (con
 * SKU e IDs, sin líneas de servicio); si no hay payload, se reconstruyen
 * desde `product_summary` como respaldo (sin SKU).
 */
function buildItems(order: OrderRow): SupplierOrderInput["items"] {
  const reales = orderLineItems(order).filter((l) => !l.isService);
  if (reales.length > 0) {
    return reales.map((l) => ({ title: l.title, quantity: l.quantity, price: l.price, sku: l.sku }));
  }
  return parseItems(order.product_summary);
}

/**
 * Reconstruye los artículos desde `product_summary` ("2x Producto" por línea).
 * Respaldo para pedidos sin raw_payload.
 */
function parseItems(summary: string | null): SupplierOrderInput["items"] {
  const lineas = (summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lineas.map((linea) => {
    const m = /^(\d+)x\s+(.*)$/i.exec(linea);
    return {
      title: m ? m[2].trim() : linea,
      quantity: m ? parseInt(m[1], 10) : 1,
      price: null,
      sku: null,
    };
  });
}

// --- GATE CENTRAL ---

export interface SupplierGateResult {
  allowed: boolean;
  /** Motivo del bloqueo (null si está permitido). */
  reason: string | null;
}

/**
 * ¿Se puede sincronizar ESTE pedido con ESTA plataforma, de verdad?
 *
 * Igual que en WhatsApp y Shopify: todo cerrado por defecto y hacen falta
 * varias decisiones explícitas a la vez. Además exige que el pedido esté en
 * condiciones (confirmado, con routing y dirección válidos) y que no exista ya.
 */
export function canSyncSupplier(order: OrderRow, platform: SupplierPlatform): SupplierGateResult {
  const no = (reason: string): SupplierGateResult => ({ allowed: false, reason });

  if (emergencyStop()) return no("EMERGENCY_STOP activo");

  // CANDADO CONTRA LA DOBLE INTEGRACIÓN.
  // Los pedidos de Shopify llegan con tags `dropea_error` y "Sync ERROR -
  // Dropi PRO": ya hay OTRA integración creando pedidos en los proveedores.
  // Si la nuestra también los crea, cada compra se envía DOS VECES al
  // cliente. Este candado bloquea la creación aunque el resto de llaves
  // estén abiertas, y solo se abre cuando se confirme que la integración
  // antigua está desactivada.
  if (!legacyIntegrationsDisabled()) {
    return no(
      "LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0: hay otra integración Shopify→proveedor activa " +
        "(tags dropea_error / Sync ERROR - Dropi PRO). Crear el pedido ahora lo duplicaría"
    );
  }

  if (!supplierSyncEnabled()) return no("SUPPLIER_SYNC_ENABLED=0");
  if (supplierTestMode()) return no("SUPPLIER_TEST_MODE=1: solo simulación");
  if (!platformWriteEnabled(platform)) return no(`escritura no habilitada para ${platform}`);

  // IDEMPOTENCIA PRIMERO: un pedido que ya existe en el proveedor no se
  // recrea jamás, lo apruebe quien lo apruebe y estén como estén las llaves.
  if (order.supplier_external_order_id) return no("ya existe en el proveedor (idempotencia)");
  if (order.status !== "confirmed") return no(`el pedido está en "${order.status}"`);

  // Respeta el TEST_MODE de WhatsApp: si el pedido no es elegible para
  // actuar sobre él, tampoco se manda a ningún proveedor.
  if (!orderActionAllowed(order)) return no("pedido fuera de allowlist y sin autorizar");

  // Durante el piloto, la autorización es POR PEDIDO (no por teléfono):
  // Pedro aprueba uno a uno los que salen a proveedor.
  if (supplierPilotMode() && order.supplier_pilot_approved !== 1) {
    return no("piloto de proveedores: este pedido no está aprobado (supplier_pilot_approved=0)");
  }

  const provider = getProvider(platform);
  if (!provider) return no(`no hay provider para "${platform}"`);
  if (!provider.isConfigured()) {
    return no(`el proveedor ${platform} no está configurado (pendiente del handoff)`);
  }

  const evaluation = evaluateOrderForSupplier(order);
  if (evaluation.status !== "ready") return no(evaluation.reason);

  return { allowed: true, reason: null };
}

/**
 * Simula el envío de un pedido: NO toca la red ni el proveedor real.
 * Devuelve lo que se habría hecho, para poder verlo antes de activar nada.
 */
export function simulateSupplierSync(order: OrderRow): {
  evaluation: SupplierEvaluation;
  gate: SupplierGateResult;
  simulated: { externalOrderId: string; simulated: boolean } | null;
} {
  const evaluation = evaluateOrderForSupplier(order);
  const gate = canSyncSupplier(order, evaluation.platform);

  let simulated: { externalOrderId: string; simulated: boolean } | null = null;
  if (evaluation.status === "ready" && evaluation.input) {
    const provider = getProvider(evaluation.platform);
    if (provider) {
      const r = provider.simulateCreateOrder(evaluation.input);
      simulated = { externalOrderId: r.externalOrderId, simulated: r.simulated };
    }
  }

  logger.info(
    `[SUPPLIER] #${order.shopify_order_number} routing → ${evaluation.platform} | ` +
      `${evaluation.status}${evaluation.status === "ready" ? " (simulado)" : `: ${evaluation.reason}`}`
  );

  return { evaluation, gate, simulated };
}

export { ProviderNotConfiguredError };
