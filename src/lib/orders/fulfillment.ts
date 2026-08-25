// ============================================================
// FULFILLMENT FÍSICO — cuánta MERCANCÍA ha salido de verdad.
//
// El problema que resuelve: `fulfillment_status` a nivel de PEDIDO en Shopify
// es engañoso en Casamable. Cada pedido lleva una línea `Seguro de Envío`
// que no es mercancía y que ningún proveedor despacha nunca, así que Shopify
// deja el pedido en `partial` PARA SIEMPRE — el producto real salió hace
// semanas y el pedido no llega jamás a `fulfilled`. Decidir con el estado
// global significa decidir con un dato estructuralmente falso.
//
// Aquí se mira LÍNEA A LÍNEA y solo las líneas físicas.
//
// ── ⚠️ DÓNDE SE PUEDE USAR ESTO ────────────────────────────────
// `orders.raw_payload` NO SIRVE para esto. Se escribe una sola vez, en el
// INSERT del webhook `orders/create`, y nunca se refresca: en ese instante
// NINGUNA línea está despachada todavía. Alimentar este inferidor con
// `raw_payload` devolvería `not_started` siempre, para todos los pedidos,
// para siempre — y parecería un dato, no un error.
//
// Fuentes VÁLIDAS (payload fresco de la Admin API):
//   · `npm run shopify:backfill`  (orders.json, incluye line_items completas)
//   · la reconciliación periódica (mismo fetch)
//
// Por eso `inferPhysicalFulfillment` exige declarar de dónde viene el payload
// y devuelve `basis`, para que en el informe se vea con qué calidad de dato
// se decidió cada pedido.
//
// ── QUÉ NO ES ESTO ─────────────────────────────────────────────
// No tiene NADA que ver con `supplier_product_mapping`. Una línea puede ser
// perfectamente física y no tener todavía mapping de proveedor: routing y
// fulfillment son preguntas distintas y se responden por separado.
// ============================================================

import type { ShopifyLineItem, ShopifyOrderPayload } from "./normalize";

/** Con qué calidad de dato se llegó a la conclusión. */
export type FulfillmentBasis =
  /** Se leyeron los campos de fulfillment de cada línea. Es lo bueno. */
  | "line_level"
  /** Sin datos por línea: se usó el `fulfillment_status` global del pedido. */
  | "global_fallback"
  /** Ni línea ni global: no se afirma nada. */
  | "insufficient_data";

export type PhysicalFulfillmentState =
  /** El pedido no lleva mercancía: solo servicios (p. ej. solo el seguro). */
  | "no_physical_items"
  /** Hay mercancía y no ha salido nada. */
  | "not_started"
  /** Parte de la mercancía salió. */
  | "partial"
  /** TODA la mercancía salió. */
  | "fulfilled"
  /** Devuelta al almacén. NO implica entregado NI rehusado. */
  | "restocked"
  /** No se puede saber con lo que hay. */
  | "unknown";

export interface PhysicalFulfillment {
  state: PhysicalFulfillmentState;
  basis: FulfillmentBasis;
  /** Cuántas líneas se consideraron mercancía. */
  physicalLines: number;
  /** De esas, cuántas constan como despachadas del todo. */
  fulfilledLines: number;
  /** Líneas descartadas por no ser mercancía (servicios, tarjetas regalo). */
  serviceLines: number;
  /** Explicación corta para logs y para el desglose del dry-run. */
  reason: string;
}

// --- Señal 4 (último recurso): títulos que delatan una línea de servicio ---
//
// Solo se usa cuando la línea NO trae ninguna señal mejor. Está documentado
// como fallback a propósito: un título es texto libre que Pedro puede cambiar
// en Shopify cualquier día, así que nunca gana a un campo de la API.
const TITULOS_DE_SERVICIO =
  /\b(seguro|insurance|protecci[óo]n|protection|garant[íi]a|warranty|env[íi]o|shipping|handling|tip|propina|donaci[óo]n|donation)\b/i;

/**
 * ¿Esta línea es MERCANCÍA que alguien tiene que meter en una caja?
 *
 * Orden de señales, de más fiable a menos (la primera que resuelve, manda):
 *
 *  1. `gift_card = true`      → NO. Es virtual por definición.
 *  2. `requires_shipping`     → la señal buena: es EL campo con el que Shopify
 *                               dice si algo se envía. `false` → no es
 *                               mercancía; `true` → lo es, y se acabó.
 *  3. `fulfillment_service`   → un servicio de fulfillment "gift_card" nunca
 *                               despacha mercancía.
 *  4. product/variant/SKU     → si la línea tiene identidad de catálogo, es un
 *                               producto. El `Seguro de Envío` de Releasit no
 *                               tiene ninguno de los tres.
 *  5. Título (documentado)    → solo si no hubo NADA de lo anterior.
 *
 * Sin ninguna señal: **falla cerrado** → no es mercancía. Contar de más una
 * línea física haría que un pedido pareciera "a medias" eternamente; contar
 * de menos, como mucho, lo deja en `no_physical_items`, que es visible y va a
 * revisión en vez de mentir.
 */
export function isPhysicalFulfillmentLine(line: ShopifyLineItem): boolean {
  if (line.gift_card === true) return false;

  if (typeof line.requires_shipping === "boolean") return line.requires_shipping;

  if ((line.fulfillment_service ?? "").trim().toLowerCase() === "gift_card") return false;

  const tieneIdentidad =
    Boolean((line.sku ?? "").trim()) ||
    (line.product_id !== null && line.product_id !== undefined && String(line.product_id).trim() !== "") ||
    (line.variant_id !== null && line.variant_id !== undefined && String(line.variant_id).trim() !== "");
  if (tieneIdentidad) return true;

  const titulo = (line.title ?? "").trim();
  if (titulo && TITULOS_DE_SERVICIO.test(titulo)) return false;

  return false; // fail closed: sin señales, no se afirma que sea mercancía
}

/** ¿Trae esta línea información de fulfillment utilizable? */
function tieneDatoDeLinea(line: ShopifyLineItem): boolean {
  return line.fulfillment_status !== undefined || line.fulfillable_quantity !== undefined;
}

/** ¿Está esta línea física completamente despachada? */
function lineaDespachada(line: ShopifyLineItem): boolean {
  if (line.fulfillment_status === "fulfilled") return true;
  // `fulfillable_quantity = 0` significa que no queda nada por despachar.
  if (typeof line.fulfillable_quantity === "number" && line.fulfillable_quantity === 0) {
    // Salvo que la línea nunca tuviera unidades (defensivo).
    return Number(line.quantity ?? 0) > 0;
  }
  return false;
}

/** ¿Está a medias esta línea concreta? */
function lineaParcial(line: ShopifyLineItem): boolean {
  if (line.fulfillment_status === "partial") return true;
  const q = Number(line.quantity ?? 0);
  const pend = line.fulfillable_quantity;
  return typeof pend === "number" && q > 0 && pend > 0 && pend < q;
}

/**
 * Infiere el estado de la MERCANCÍA de un pedido.
 *
 * `payloadIsFresh` es obligatorio y no tiene default a propósito: quien llama
 * tiene que pararse a pensar si el payload que trae refleja el estado de HOY
 * (fetch de la Admin API) o está congelado en el momento de creación
 * (`raw_payload`). Con `false` no se lee nada por línea: se va directo al
 * fallback global o a `insufficient_data`.
 */
export function inferPhysicalFulfillment(
  payload: ShopifyOrderPayload & { fulfillment_status?: string | null },
  payloadIsFresh: boolean
): PhysicalFulfillment {
  const todas = (payload.line_items ?? []).filter((li) => li && (li.title ?? "").trim());
  const fisicas = todas.filter((li) => isPhysicalFulfillmentLine(li));
  const servicios = todas.length - fisicas.length;
  const global = payload.fulfillment_status ?? null;

  const base = { physicalLines: fisicas.length, fulfilledLines: 0, serviceLines: servicios };

  // `restocked` es del pedido entero y no se puede deducir por línea: la
  // mercancía volvió al almacén. NO implica entregado ni rehusado — solo que
  // el stock se repuso. Quién decidió eso y por qué lo dice otra fuente.
  if (global === "restocked") {
    return {
      ...base,
      state: "restocked",
      basis: "global_fallback",
      reason: "Shopify marca el pedido como restocked: la mercancía volvió, sin desenlace implícito",
    };
  }

  if (todas.length === 0) {
    return { ...base, state: "unknown", basis: "insufficient_data", reason: "el pedido no trae líneas legibles" };
  }

  if (fisicas.length === 0) {
    return {
      ...base,
      state: "no_physical_items",
      basis: todas.some(tieneDatoDeLinea) ? "line_level" : "insufficient_data",
      reason: `las ${todas.length} línea(s) son de servicio (p. ej. Seguro de Envío): no hay mercancía que despachar`,
    };
  }

  const conDato = payloadIsFresh ? fisicas.filter(tieneDatoDeLinea) : [];

  if (conDato.length === fisicas.length && fisicas.length > 0) {
    const despachadas = fisicas.filter(lineaDespachada).length;
    const parciales = fisicas.filter(lineaParcial).length;
    const state: PhysicalFulfillmentState =
      despachadas === fisicas.length
        ? "fulfilled"
        : despachadas > 0 || parciales > 0
          ? "partial"
          : "not_started";
    return {
      ...base,
      fulfilledLines: despachadas,
      state,
      basis: "line_level",
      reason: `${despachadas}/${fisicas.length} línea(s) de mercancía despachadas (${servicios} de servicio ignorada(s))`,
    };
  }

  // --- Fallback global ---
  //
  // Sin datos por línea no queda más que el estado del pedido, y ahí está
  // justo el sesgo del `Seguro de Envío`: con servicios presentes, un
  // `partial` global NO significa que falte mercancía por salir. Se informa
  // como fallback para que se vea con qué calidad se decidió.
  if (global === "fulfilled" || global === "partial") {
    const sesgado = servicios > 0 && global === "partial";
    return {
      ...base,
      state: sesgado ? "unknown" : global === "fulfilled" ? "fulfilled" : "partial",
      basis: "global_fallback",
      reason: sesgado
        ? `Shopify dice "partial" pero el pedido lleva ${servicios} línea(s) de servicio que nadie despacha nunca: el global no distingue, y sin datos por línea no se puede afirmar nada`
        : `sin datos por línea: se usa el fulfillment_status global ("${global}")`,
    };
  }

  if (global === null || global === undefined) {
    return {
      ...base,
      state: payloadIsFresh ? "not_started" : "unknown",
      basis: payloadIsFresh ? "global_fallback" : "insufficient_data",
      reason: payloadIsFresh
        ? "Shopify no reporta ningún fulfillment: no ha salido nada"
        : "payload congelado (raw_payload de orders/create): no dice nada del progreso real",
    };
  }

  return {
    ...base,
    state: "unknown",
    basis: "insufficient_data",
    reason: `fulfillment_status global desconocido ("${global}")`,
  };
}

/**
 * ¿Este estado de mercancía autoriza a marcar el cierre como `in_progress`?
 *
 * Solo si SALIÓ MERCANCÍA de verdad. Y nada más: Shopify no puede producir
 * `delivered` ni `refused` — *fulfilled* significa despachado, no entregado,
 * y en COD la entrega y el rehúse solo los conoce el proveedor.
 *
 *   fulfilled / partial → sí, algo salió
 *   not_started        → no: nada ha salido
 *   no_physical_items  → no: no hay nada que salga (revisión)
 *   restocked          → no: volvió, y el motivo lo dice otra fuente
 *   unknown            → no
 */
export function physicalStateAllowsInProgress(state: PhysicalFulfillmentState): boolean {
  return state === "fulfilled" || state === "partial";
}
