// ============================================================
// Traducción de NUESTRO DTO al formato de Dropea.
// Basado en el esquema real CreateOrderInput. Ver DROPEA-API-CONTRACT.md § 5.
//
// Tres cosas que impone su contrato y conviene tener presentes:
//  1. `state` es la PROVINCIA (no el país).
//  2. NO hay campo de importe COD: se deriva de Σ(unit_price × quantity),
//     así que los precios de línea tienen que ser los reales.
//  3. NO existe campo de nota de entrega. La nota que el cliente deja por
//     WhatsApp no se puede transmitir por API (ver `deliveryNoteWarning`).
// ============================================================

import type { SupplierOrderInput } from "../types";
import type {
  DropeaCreateOrderRequest,
  DropeaLineItemInput,
  DropeaShippingAddress,
} from "./types";

/** Parte el nombre completo en nombre y apellidos (Dropea los pide separados). */
export function splitName(fullName: string | null): { first: string; last: string } {
  const limpio = (fullName ?? "").trim().replace(/\s+/g, " ");
  if (!limpio) return { first: "Cliente", last: "-" };
  const partes = limpio.split(" ");
  if (partes.length === 1) return { first: partes[0], last: "-" };
  return { first: partes[0], last: partes.slice(1).join(" ") };
}

/** Teléfono en formato internacional con "+", como espera Dropea. */
export function toInternationalPhone(digits: string): string {
  const soloDigitos = (digits ?? "").replace(/\D/g, "");
  return soloDigitos ? `+${soloDigitos}` : "";
}

/** País a ISO-2. Nuestros pedidos vienen de España. */
function toCountryCode(country: string | null): string {
  const c = (country ?? "").trim();
  if (!c) return "ES";
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  if (/^(espa(ñ|n)a|spain)$/i.test(c)) return "ES";
  return c.toUpperCase().slice(0, 2);
}

export interface DropeaMappingResult {
  request: DropeaCreateOrderRequest | null;
  /** Motivos por los que NO se puede construir el pedido. */
  errors: string[];
  /** Avisos que no impiden crear, pero conviene conocer. */
  warnings: string[];
}

export interface DropeaMappingContext {
  /** Tienda en Dropea (de GET /dropshipper/shops). */
  storeId: number;
  /**
   * Correspondencia de cada artículo con su variante de Dropea.
   * La clave es el título exacto de nuestro `product_summary`.
   */
  variantByTitle: Map<string, { variantId: number; unitPrice: number }>;
}

/**
 * Construye el cuerpo de `POST /dropshipper/orders` a partir de nuestro DTO.
 *
 * No inventa nada: si falta un dato obligatorio del contrato (una variante
 * sin emparejar, una localidad vacía), devuelve el motivo y `request: null`.
 * Es preferible no crear el pedido a crearlo mal.
 */
export function mapToDropeaCreateOrder(
  input: SupplierOrderInput,
  ctx: DropeaMappingContext
): DropeaMappingResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Artículos: cada uno necesita su variant_id de Dropea ---
  const line_items: DropeaLineItemInput[] = [];
  for (const item of input.items) {
    const match = ctx.variantByTitle.get(item.title.trim());
    if (!match) {
      errors.push(`sin correspondencia en Dropea para "${item.title}" (falta su variant_id)`);
      continue;
    }
    line_items.push({
      variant_id: match.variantId,
      quantity: item.quantity,
      // El importe del contra reembolso se deriva de estas líneas, así que
      // el precio tiene que ser el que paga el cliente.
      unit_price: match.unitPrice,
    });
  }
  if (line_items.length === 0 && errors.length === 0) {
    errors.push("el pedido no tiene artículos");
  }

  // --- Dirección: sus campos obligatorios son innegociables ---
  const { first, last } = splitName(input.customerName);
  const dir = input.finalAddress;
  if (!dir.line1?.trim()) errors.push("falta la calle (address_line_1)");
  if (!dir.city?.trim()) errors.push("falta la localidad (city)");
  if (!dir.postalCode?.trim()) errors.push("falta el código postal");
  // `state` es OBLIGATORIO en su contrato. Si no tenemos provincia,
  // usamos la localidad antes que mandar vacío (Dropea lo rechazaría).
  const state = (dir.province ?? "").trim() || (dir.city ?? "").trim();
  if (!state) errors.push("falta la provincia (state)");

  const phone = toInternationalPhone(input.phone);
  if (!phone) errors.push("falta el teléfono");

  // Su contrato exige email. Si el pedido no trae (habitual en Releasit),
  // se avisa: hay que decidir si usar uno de contacto de la tienda.
  const email = (input.email ?? "").trim();
  if (!email) {
    errors.push("Dropea exige email del cliente y este pedido no tiene");
  }

  // --- La nota del repartidor no cabe en su API ---
  if (input.deliveryNote && input.deliveryNote.trim()) {
    warnings.push(
      "la nota del cliente para el repartidor NO se envía: la API de Dropea no tiene " +
        "ningún campo para observaciones. Hay que comunicarla por otra vía."
    );
  }

  if (errors.length > 0) return { request: null, errors, warnings };

  const shipping_address: DropeaShippingAddress = {
    first_name: first,
    last_name: last,
    address_line_1: dir.line1.trim(),
    ...(dir.line2?.trim() ? { address_line_2: dir.line2.trim() } : {}),
    city: dir.city.trim(),
    state,
    postal_code: dir.postalCode.trim(),
    country: toCountryCode(dir.country),
  };

  return {
    request: {
      store_id: ctx.storeId,
      line_items,
      customer_details: {
        name: (input.customerName ?? `${first} ${last}`).trim(),
        email,
        phone,
        shipping_address,
      },
      // Contra reembolso: el importe lo calcula Dropea con las líneas.
      payment_method: "COD",
      // Nuestra referencia, para poder correlacionar en ambos sentidos.
      external_order_id: input.shopifyOrderId.slice(0, 128),
    },
    errors: [],
    warnings,
  };
}

/**
 * Vista previa SANITIZADA del cuerpo, para la simulación y los logs.
 * Recorta los datos personales: nunca se imprime la dirección completa.
 */
export function previewDropeaPayload(req: DropeaCreateOrderRequest): Record<string, unknown> {
  const d = req.customer_details.shipping_address;
  return {
    store_id: req.store_id,
    payment_method: req.payment_method,
    external_order_id: req.external_order_id,
    line_items: req.line_items,
    total_derivado: req.line_items
      .reduce((s, l) => s + l.unit_price * l.quantity, 0)
      .toFixed(2),
    cliente: `${d.first_name} ${d.last_name.slice(0, 1)}.`,
    telefono: `***${req.customer_details.phone.slice(-4)}`,
    destino: `${d.postal_code} ${d.city} (${d.state}), ${d.country}`,
  };
}
