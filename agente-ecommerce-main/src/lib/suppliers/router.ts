// ============================================================
// Enrutado de pedidos al proveedor que toca (Dropi PRO / Dropea).
//
// ESTADO ACTUAL: no sabemos qué producto va a cada proveedor. Hasta que
// llegue el handoff de Pedro, TODO sale como "unknown" → revisión humana.
// Adivinar aquí significaría mandar un pedido al proveedor equivocado.
//
// Cuando existan las reglas reales (por SKU, por producto o por tags de
// Shopify), se implementan en `reglasConfiguradas()` sin tocar nada más.
// ============================================================

import type { OrderRow } from "../db";
import type { SupplierPlatform } from "./types";

export interface RoutingResult {
  platform: SupplierPlatform;
  /** Por qué se decidió eso (para el panel y los logs). */
  reason: string;
}

/**
 * Reglas de enrutado desde variables de entorno, pensadas para PRUEBAS
 * mientras no hay handoff. Formato:
 *
 *   SUPPLIER_ROUTING_RULES=dropi:cortauñas|pulidor,dropea:limpiador
 *
 * Cada regla es `plataforma:palabra|palabra`; se busca en el resumen de
 * productos del pedido. Sin esta variable no hay routing automático.
 */
function reglasConfiguradas(): Array<{ platform: SupplierPlatform; keywords: string[] }> {
  const raw = (process.env.SUPPLIER_ROUTING_RULES ?? "").trim();
  if (!raw) return [];
  const reglas: Array<{ platform: SupplierPlatform; keywords: string[] }> = [];
  for (const parte of raw.split(",")) {
    const [plataforma, kw] = parte.split(":");
    const p = (plataforma ?? "").trim().toLowerCase();
    if (p !== "dropi" && p !== "dropea" && p !== "manual") continue;
    const keywords = (kw ?? "")
      .split("|")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.length) reglas.push({ platform: p as SupplierPlatform, keywords });
  }
  return reglas;
}

/** minúsculas y sin tildes, para comparar títulos de producto. */
function normaliza(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * ¿A qué proveedor va este pedido?
 *
 * Sin reglas configuradas → "unknown" SIEMPRE. Es deliberado: es preferible
 * que Pedro enrute a mano diez pedidos a que el sistema mande uno al
 * proveedor equivocado.
 */
export function resolveSupplier(order: OrderRow): RoutingResult {
  const reglas = reglasConfiguradas();
  if (reglas.length === 0) {
    return {
      platform: "unknown",
      reason: "sin reglas de enrutado configuradas (pendiente del handoff de Dropi/Dropea)",
    };
  }

  const productos = normaliza(order.product_summary ?? "");
  const coincidencias = reglas.filter((r) => r.keywords.some((k) => productos.includes(normaliza(k))));

  if (coincidencias.length === 0) {
    return { platform: "unknown", reason: "ningún producto del pedido casa con las reglas" };
  }
  // Si el pedido casa con DOS proveedores distintos, no elegimos por él.
  const plataformas = new Set(coincidencias.map((c) => c.platform));
  if (plataformas.size > 1) {
    return {
      platform: "unknown",
      reason: `el pedido casa con varios proveedores (${[...plataformas].join(", ")}): decisión humana`,
    };
  }
  const platform = coincidencias[0].platform;
  return { platform, reason: `regla de enrutado por producto → ${platform}` };
}
