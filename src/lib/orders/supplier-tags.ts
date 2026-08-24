// ============================================================
// E4 · Enlace con Dropea a partir de los TAGS de Shopify.
//
// Los pedidos que crea la app oficial de Dropea quedan etiquetados en Shopify
// con `dropea_id:NNNNNNN` (verificado en producción: #35010814 →
// `dropea_id:1366919`). Esa etiqueta ES la correspondencia pedido↔proveedor,
// ya escrita por su app: leerla nos ahorra preguntarle a la API de Dropea
// algo que Shopify ya nos está contando en cada payload.
//
// POR QUÉ VIVE EN `orders/` Y NO EN `suppliers/dropea/`:
// lo consumen el backfill (E3) y la reconciliación (E5), que tienen PROHIBIDO
// por test importar `suppliers/*` — arrastraría clientes HTTP y credenciales
// de proveedor a un proceso que solo debe mover datos. Aquí abajo no hay más
// que parseo puro y un UPDATE de `db.ts`: cero red, cero WhatsApp.
//
// REGLAS DURAS:
//  1. NUNCA se pisa un `supplier_external_order_id` existente. El UPDATE de
//     `setOrderSupplierPlatformAndExternalId` ya lleva `WHERE ... IS NULL`;
//     aquí además se comprueba antes para poder avisar de una discrepancia.
//  2. Coincidencia EXACTA: `dropea_id:` + dígitos. Un tag ambiguo (dos ids
//     distintos) o mal formado NO enlaza nada y deja un evento de aviso —
//     si el formato del tag cambiara, E4 dejaría de funcionar EN SILENCIO,
//     y ese es justo el fallo que este repo no se puede permitir.
//  3. Un id que ya pertenece a OTRO pedido local no se reasigna: se avisa.
// ============================================================

import {
  getOrderBySupplierExternalId,
  setOrderSupplierPlatformAndExternalId,
  type OrderRow,
} from "../db";
import { logIntegrationEvent } from "../system/repo";
import { orderTags, type ShopifyOrderPayload } from "./normalize";

/** Prefijo del tag que escribe la app oficial de Dropea. */
export const DROPEA_ID_TAG_PREFIX = "dropea_id";

/** `dropea_id: 1366919` → captura "1366919". Tolerante a espacios, estricta
 *  con el contenido: solo dígitos. `dropea_error` NO casa. */
const DROPEA_ID_TAG_RE = /^dropea_id\s*:\s*(\d+)$/;
/** Cualquier cosa que PRETENDA ser el tag (para detectar formatos rotos). */
const DROPEA_ID_TAG_CANDIDATE_RE = /^dropea_id\s*:/;

export type DropeaTagOutcome =
  /** Un único id, bien formado. */
  | { kind: "found"; dropeaId: string }
  /** El pedido no trae ningún tag `dropea_id:` (lo normal antes de que su app actúe). */
  | { kind: "absent" }
  /** Varios `dropea_id:` con valores distintos: no se elige uno "a ojo". */
  | { kind: "ambiguous"; ids: string[] }
  /** Hay un `dropea_id:` pero su valor no son dígitos: el formato cambió. */
  | { kind: "malformed"; raw: string[] };

/**
 * Extrae el id de Dropea de una lista de tags ya normalizados (minúsculas y
 * sin espacios sobrantes — tal como los devuelve `orderTags()`).
 *
 * Los ceros a la izquierda se recortan para que el id case con el que llega
 * por el webhook de Dropea (`String(resource_id)`, sin relleno).
 */
export function extractDropeaIdFromTags(tags: string[]): DropeaTagOutcome {
  const candidatos = tags.filter((t) => DROPEA_ID_TAG_CANDIDATE_RE.test(t));
  if (candidatos.length === 0) return { kind: "absent" };

  const rotos: string[] = [];
  const ids = new Set<string>();
  for (const tag of candidatos) {
    const m = DROPEA_ID_TAG_RE.exec(tag);
    if (!m) {
      rotos.push(tag);
      continue;
    }
    const normalizado = m[1].replace(/^0+(?=\d)/, "");
    if (normalizado === "0") {
      rotos.push(tag); // "dropea_id:0" no es un pedido real
      continue;
    }
    ids.add(normalizado);
  }

  if (rotos.length > 0) return { kind: "malformed", raw: rotos };
  if (ids.size > 1) return { kind: "ambiguous", ids: [...ids].sort() };
  return { kind: "found", dropeaId: [...ids][0] };
}

/** Igual que la anterior, partiendo del payload crudo de Shopify. */
export function extractDropeaIdFromPayload(payload: ShopifyOrderPayload): DropeaTagOutcome {
  return extractDropeaIdFromTags(orderTags(payload));
}

/** Pedido local mínimo que necesita el enlace (facilita tests y llamadas). */
export type LinkableOrder = Pick<
  OrderRow,
  "id" | "shopify_order_number" | "supplier_platform" | "supplier_external_order_id"
>;

export type DropeaLinkReason =
  | "linked"
  | "already_linked"
  | "no_tag"
  | "ambiguous_tag"
  | "malformed_tag"
  | "id_taken_by_other_order"
  | "race_lost";

export interface DropeaLinkResult {
  linked: boolean;
  dropeaId: string | null;
  reason: DropeaLinkReason;
}

/**
 * Lee el tag y, si procede, engancha el pedido local al pedido de Dropea.
 * Idempotente y de un solo sentido: si ya había id externo, no toca nada.
 *
 * `channel` es solo trazabilidad (por dónde entró: webhook, reconcile,
 * backfill) — no cambia el comportamiento.
 */
export function linkDropeaFromShopifyTags(
  order: LinkableOrder,
  payload: ShopifyOrderPayload,
  channel: string
): DropeaLinkResult {
  const outcome = extractDropeaIdFromPayload(payload);
  const ref = order.shopify_order_number;

  if (order.supplier_external_order_id) {
    // Ya enlazado: no se pisa NUNCA. Pero si el tag dice otra cosa, eso es
    // una discrepancia real entre Shopify y nuestra base: que la vea un humano.
    if (outcome.kind === "found" && outcome.dropeaId !== order.supplier_external_order_id) {
      logIntegrationEvent(
        "dropea",
        "dropea_link_mismatch",
        "warning",
        `el tag de Shopify dice dropea_id:${outcome.dropeaId} pero el pedido ya está enlazado a ${order.supplier_external_order_id} (${channel}): NO se pisa, revisar a mano`,
        ref
      );
    }
    return { linked: false, dropeaId: order.supplier_external_order_id, reason: "already_linked" };
  }

  if (outcome.kind === "absent") return { linked: false, dropeaId: null, reason: "no_tag" };

  if (outcome.kind === "malformed") {
    logIntegrationEvent(
      "dropea",
      "dropea_tag_malformed",
      "warning",
      `tag dropea_id con formato inesperado (${outcome.raw.join(" | ")}) en ${channel}: no se enlaza nada. Si su app cambió el formato, E4 deja de enlazar`,
      ref
    );
    return { linked: false, dropeaId: null, reason: "malformed_tag" };
  }

  if (outcome.kind === "ambiguous") {
    logIntegrationEvent(
      "dropea",
      "dropea_tag_ambiguous",
      "warning",
      `el pedido lleva varios dropea_id distintos (${outcome.ids.join(", ")}) en ${channel}: no se elige ninguno, revisar a mano`,
      ref
    );
    return { linked: false, dropeaId: null, reason: "ambiguous_tag" };
  }

  const dropeaId = outcome.dropeaId;

  // Ese id ya es de otro pedido nuestro: reasignarlo mezclaría dos envíos.
  const duenno = getOrderBySupplierExternalId(dropeaId);
  if (duenno && duenno.id !== order.id) {
    logIntegrationEvent(
      "dropea",
      "dropea_link_duplicate",
      "warning",
      `dropea_id:${dropeaId} ya está enlazado al pedido #${duenno.shopify_order_number} (${channel}): no se reasigna, revisar a mano`,
      ref
    );
    return { linked: false, dropeaId, reason: "id_taken_by_other_order" };
  }

  // El router pudo haber planeado otro proveedor: el tag es un HECHO (su app
  // ya creó el pedido), el routing era solo un plan. Gana el hecho, y queda
  // constancia de que el plan no coincidía.
  if (order.supplier_platform && order.supplier_platform !== "dropea") {
    logIntegrationEvent(
      "dropea",
      "dropea_link_platform_override",
      "warning",
      `el routing decía "${order.supplier_platform}" pero Shopify trae dropea_id:${dropeaId} (${channel}): manda el tag, el pedido existe ya en Dropea`,
      ref
    );
  }

  const aplicado = setOrderSupplierPlatformAndExternalId(order.id, "dropea", dropeaId);
  if (!aplicado) {
    // Otro proceso enlazó entre la lectura y el UPDATE (el WHERE ... IS NULL
    // lo impidió). Es el comportamiento correcto: no se reintenta.
    return { linked: false, dropeaId, reason: "race_lost" };
  }

  logIntegrationEvent(
    "dropea",
    "order_linked_by_tag",
    "info",
    `enlazado con el pedido ${dropeaId} de Dropea leyendo el tag de Shopify (${channel}): sin llamar a su API`,
    ref
  );
  return { linked: true, dropeaId, reason: "linked" };
}
