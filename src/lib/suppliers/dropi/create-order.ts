// ⛔⛔ HECHO CONFIRMADO (videollamada con soporte, 25-08-2026):
// DROPI **NO DISPONE DE API PÚBLICA**. Este fichero es andamiaje construido
// cuando se creía que la documentación llegaría — NO llegará salvo nueva
// evidencia. NO "terminar" esta integración: la vía real de Dropi es su app
// de Shopify (el vínculo se hace con el campo *vendor* del producto, ver
// docs/DROPI-API-CONTRACT.md y CONTEXTO-2026-08-25 §2). Se conserva porque
// el router y los gates lo importan y porque falla cerrado — no porque
// exista un plan de implementarlo.
// ============================================================
// Creación de un pedido en Dropi PRO — andamiaje listo, red BLOQUEADA.
//
// Lo que YA está resuelto aquí y no depende de Dropi:
//   1. El gate (`canCreateDropiOrder`) falla cerrado mientras no haya cliente.
//   2. Los artículos se traducen con `supplier_product_mapping` (platform
//      "dropi"): una línea sin mapping impide crear, nunca se adivina.
//   3. La clave de idempotencia es ESTABLE (derivada del pedido) y se
//      persiste antes de tocar la red; un reintento reutiliza la misma.
//   4. La fase se reclama atómicamente en SQLite (`claimSupplierCreate`).
//
// Lo que falta y lo pone el handoff de Dropi: endpoint, auth, esquema JSON
// y cómo identifica los productos. Ver docs/DROPI-API-CONTRACT.md § 4.
// ============================================================

import pino from "pino";
import {
  claimSupplierCreate,
  listSupplierProductMappings,
  markSupplierCreated,
  markSupplierCreateFailed,
  type OrderRow,
  type SupplierProductMapping,
} from "../../db";
import { logIntegrationEvent } from "../../system/repo";
import { orderLineItems } from "../../orders/line-items";
import { matchLineToMapping } from "../router";
import { ProviderNotConfiguredError, type SupplierOrderInput } from "../types";
import { dropiRequest } from "./client";
import { canCreateDropiOrder } from "./create-gate";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/** Clave estable: un reintento usa EXACTAMENTE la misma. */
export function buildDropiIdempotencyKey(shopifyOrderId: string): string {
  const limpio = shopifyOrderId.replace(/[^A-Za-z0-9_-]/g, "");
  return `casamable-shopify-${limpio}-dropi-create`.slice(0, 255);
}

/** Línea ya traducida a identificadores de Dropi (según el mapping). */
export interface DropiDraftLine {
  title: string;
  sku: string | null;
  quantity: number;
  /** Identificador del producto en Dropi, tal cual está en el mapping. */
  dropiProductId: string | null;
  dropiVariantId: string;
  unitPrice: number | null;
}

export interface DropiOrderDraft {
  reference: string;
  lines: DropiDraftLine[];
  /** Motivos por los que NO se puede construir (vacío si ok). */
  errors: string[];
}

/**
 * Construye el borrador NEUTRO del pedido para Dropi a partir del mapping.
 * No es el payload de su API (desconocido): es lo que el mapper real
 * traducirá cuando exista el contrato.
 */
export function buildDropiOrderDraft(
  order: Pick<OrderRow, "raw_payload" | "shopify_order_id">,
  mappings: SupplierProductMapping[] = listSupplierProductMappings("dropi")
): DropiOrderDraft {
  const errors: string[] = [];
  const lines: DropiDraftLine[] = [];
  const items = orderLineItems(order).filter((l) => !l.isService);
  if (items.length === 0) errors.push("el pedido no tiene líneas de producto legibles");
  for (const item of items) {
    const m = matchLineToMapping(item, mappings.filter((x) => x.supplier_platform === "dropi"));
    if (!m) {
      errors.push(`sin correspondencia en Dropi para "${item.sku ?? item.title}"`);
      continue;
    }
    lines.push({
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      dropiProductId: m.supplier_product_id,
      dropiVariantId: m.supplier_variant_id,
      unitPrice: m.supplier_unit_price,
    });
  }
  return { reference: order.shopify_order_id, lines, errors };
}

export interface DropiCreateOutcome {
  ok: boolean;
  externalOrderId: string | null;
  detail: string;
  blocker?: string | null;
}

/**
 * Crea el pedido en Dropi PRO. HOY nunca llega a la red: el gate lo frena en
 * `client_not_implemented`. Cuando exista el cliente, el flujo ya es
 * idempotente y seguro ante reinicios.
 */
export async function createDropiOrderForOrder(
  order: OrderRow,
  _input: SupplierOrderInput
): Promise<DropiCreateOutcome> {
  const gate = canCreateDropiOrder(order);
  if (!gate.allowed) {
    return { ok: false, externalOrderId: null, detail: gate.reason ?? "bloqueado", blocker: gate.blocker };
  }

  const draft = buildDropiOrderDraft(order);
  if (draft.errors.length) {
    markSupplierCreateFailed(order.id, draft.errors.join("; "));
    return { ok: false, externalOrderId: null, detail: draft.errors.join("; "), blocker: "mapping" };
  }

  const key = buildDropiIdempotencyKey(order.shopify_order_id);
  if (!claimSupplierCreate(order.id, key)) {
    return { ok: false, externalOrderId: null, detail: "otra operación ya está en curso", blocker: "claim_failed" };
  }

  try {
    // ⛔ Pendiente del contrato: `dropiRequest` lanza ProviderNotConfiguredError.
    const creado = (await dropiRequest()) as { id: string | number };
    const externalId = String(creado.id);
    markSupplierCreated(order.id, "dropi", externalId);
    logIntegrationEvent("dropi", "order_created", "info", "pedido creado en Dropi PRO", order.shopify_order_number);
    return { ok: true, externalOrderId: externalId, detail: "pedido creado en Dropi PRO" };
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : "error";
    markSupplierCreateFailed(order.id, mensaje);
    logIntegrationEvent("dropi", "order_create_failed", "warning", "fallo creando en Dropi PRO", order.shopify_order_number);
    if (err instanceof ProviderNotConfiguredError) {
      logger.warn(`[SUPPLIER] #${order.shopify_order_number} Dropi: ${mensaje}`);
      return { ok: false, externalOrderId: null, detail: mensaje, blocker: "client_not_implemented" };
    }
    return { ok: false, externalOrderId: null, detail: mensaje, blocker: "api_error" };
  }
}
