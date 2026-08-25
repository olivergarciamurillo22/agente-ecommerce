// ============================================================
// FIXTURES REALISTAS Y ANONIMIZADAS.
//
// Todo lo de aquí es INVENTADO: nombres, teléfonos, direcciones y correos no
// corresponden a ninguna persona. Los teléfonos usan el rango 600 000 0xx,
// que no está asignado, y los dominios son `example.com` (reservado por RFC
// 2606 justo para esto).
//
// La FORMA sí es real: replica los campos que mandan Shopify, Dropea y Dropi
// según sus contratos documentados. Una fixture con menos campos de los
// reales hace pasar tests que en producción se comportan distinto — ya pasó
// con las líneas de pedido sin `product_id`.
//
// Cero red: estas funciones solo construyen objetos.
// ============================================================

// ---------- Shopify ----------

export interface FixtureLineOpts {
  title?: string;
  sku?: string | null;
  productId?: number | null;
  variantId?: number | null;
  quantity?: number;
  price?: string;
  /** false = línea de servicio (seguro, propina): no es mercancía. */
  physical?: boolean;
  fulfilled?: boolean;
}

let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

export function shopifyLine(o: FixtureLineOpts = {}): Record<string, unknown> {
  const fisica = o.physical !== false;
  const n = nextId();
  const q = o.quantity ?? 1;
  return {
    title: o.title ?? (fisica ? `Producto ${n}` : "Seguro de Envío"),
    quantity: q,
    price: o.price ?? (fisica ? "19.95" : "1.95"),
    sku: o.sku !== undefined ? o.sku : fisica ? `SKU-${n}` : null,
    product_id: o.productId !== undefined ? o.productId : fisica ? 8100000000000 + n : null,
    variant_id: o.variantId !== undefined ? o.variantId : fisica ? 4100000000000 + n : null,
    requires_shipping: fisica,
    gift_card: false,
    fulfillment_service: "manual",
    fulfillment_status: o.fulfilled ? "fulfilled" : null,
    fulfillable_quantity: o.fulfilled ? 0 : q,
  };
}

export interface FixtureOrderOpts {
  id?: number;
  orderNumber?: number;
  tags?: string;
  cancelledAt?: string | null;
  fulfillmentStatus?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lineItems?: Array<Record<string, unknown>>;
  city?: string | null;
  totalPrice?: string;
  cod?: boolean;
}

/** Pedido de Shopify con la forma del webhook `orders/create` / `orders.json`. */
export function shopifyOrder(o: FixtureOrderOpts = {}): Record<string, unknown> {
  const id = o.id ?? 900000000 + nextId();
  const cod = o.cod !== false;
  return {
    id,
    order_number: o.orderNumber ?? 1000 + (id % 1000),
    name: `#${o.orderNumber ?? 1000 + (id % 1000)}`,
    email: "cliente@example.com",
    phone: null,
    note: null,
    created_at: o.createdAt ?? "2026-08-20T09:00:00Z",
    updated_at: o.updatedAt ?? "2026-08-24T12:00:00Z",
    cancelled_at: o.cancelledAt ?? null,
    currency: "EUR",
    total_price: o.totalPrice ?? "39.90",
    financial_status: cod ? "pending" : "paid",
    fulfillment_status: o.fulfillmentStatus ?? null,
    gateway: cod ? "Cash on Delivery (COD)" : "Tarjeta",
    payment_gateway_names: [cod ? "Cash on Delivery (COD)" : "Tarjeta"],
    tags: o.tags ?? (cod ? "releasit_cod_form" : ""),
    customer: {
      first_name: "Nombre",
      last_name: "Apellido",
      email: "cliente@example.com",
      phone: null,
    },
    shipping_address: {
      name: "Nombre Apellido",
      address1: "Calle Ejemplo 1",
      address2: null,
      city: o.city !== undefined ? o.city : "Madrid",
      province: "Madrid",
      zip: "28001",
      country: "Spain",
      country_code: "ES",
      phone: "+34 600 000 001",
    },
    billing_address: null,
    line_items: o.lineItems ?? [shopifyLine(), shopifyLine({ physical: false })],
    note_attributes: [],
  };
}

/** Los cinco escenarios de Shopify que importan. */
export const shopifyScenarios = {
  /** COD normal: un producto físico y el seguro. */
  codNormal: () => shopifyOrder(),
  /** Producto despachado, seguro no: Shopify dice `partial` para siempre. */
  partialPorSeguro: () =>
    shopifyOrder({
      fulfillmentStatus: "partial",
      lineItems: [shopifyLine({ fulfilled: true }), shopifyLine({ physical: false })],
    }),
  /** Cancelado en Shopify. */
  cancelado: () => shopifyOrder({ cancelledAt: "2026-08-23T10:00:00Z" }),
  /** Dos productos de proveedores distintos: va a revisión humana. */
  mixto: () =>
    shopifyOrder({
      lineItems: [
        shopifyLine({ sku: "10428", title: "Cortaúñas Eléctrico 3 en 1" }),
        shopifyLine({ sku: "SIN-MAPPING", title: "Otro producto" }),
        shopifyLine({ physical: false }),
      ],
    }),
  /** El bug de Releasit: ciudad "-" bloquea el envío al proveedor. */
  ciudadInvalida: () => shopifyOrder({ city: "-" }),
  /** Ya enlazado con Dropea por tag. */
  conDropeaId: (dropeaId = "1366919") =>
    shopifyOrder({ tags: `releasit_cod_form, dropea_id:${dropeaId}` }),
};

// ---------- Dropea ----------

export interface DropeaFixtureOpts {
  id?: number;
  externalOrderId?: string | null;
  status?: string;
  subStatus?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  updatedAt?: string;
}

export function dropeaOrder(o: DropeaFixtureOpts = {}): Record<string, unknown> {
  return {
    id: o.id ?? 1360000 + nextId(),
    external_order_id: o.externalOrderId !== undefined ? o.externalOrderId : "900000001",
    status: o.status ?? "SHIPPING",
    sub_status: o.subStatus !== undefined ? o.subStatus : "SHIPPED",
    tracking_number: o.trackingNumber ?? "TRK000000001",
    tracking_url: "https://track.example.com/TRK000000001",
    carrier: o.carrier ?? "GLS",
    created_at: "2026-08-20T10:00:00Z",
    updated_at: o.updatedAt ?? "2026-08-24T10:00:00Z",
  };
}

/** Sobre de webhook de Dropea, con la forma de su contrato. */
export function dropeaWebhookEnvelope(
  topic: string,
  resource: Record<string, unknown>,
  eventId = `evt-${nextId()}`
): string {
  return JSON.stringify({
    event_id: eventId,
    topic,
    occurred_at: "2026-08-24T10:00:00Z",
    resource_id: resource.id,
    resource,
  });
}

export const dropeaScenarios = {
  entregado: () => dropeaOrder({ status: "FINISH", subStatus: "DELIVERED" }),
  /** Cobrado en COD: entrega efectiva. */
  cobrado: () => dropeaOrder({ status: "FINISH", subStatus: "PAID" }),
  /** El cliente rechaza el contrareembolso: cuesta ~9,37 €. */
  rehusado: () => dropeaOrder({ status: "FINISH", subStatus: "REFUSED" }),
  /** Volvió el paquete, pero por pérdida o daño: NO es rehúse del cliente. */
  perdidoODanado: () => dropeaOrder({ status: "FINISH", subStatus: "REFUSED_LOST_DAMAGED" }),
  incidencia: () => dropeaOrder({ status: "ERROR", subStatus: "DELIVERY_EXCEPTION" }),
  intentoFallido: () => dropeaOrder({ status: "SHIPPING", subStatus: "DELIVERY_ATTEMPTED" }),
  cancelado: () => dropeaOrder({ status: "FINISH", subStatus: "CANCELLED" }),
  /** Estado que no está en el catálogo: nunca debe inferirse nada. */
  desconocido: () => dropeaOrder({ status: "FINISH", subStatus: "ALGO_QUE_NO_EXISTE" }),
  /** Sin referencia nuestra: no se puede correlacionar. */
  sinReferencia: () => dropeaOrder({ externalOrderId: null }),
};

// ---------- Dropi ----------
//
// Dropi PRO no tiene contrato documentado (su soporte no ha respondido). Las
// fixtures son deliberadamente MÍNIMAS y con estados que NO significan nada
// para nosotros: sirven para probar que el sistema falla cerrado, no para
// simular una API que no conocemos. En cuanto llegue el catálogo real, esto
// se sustituye por la forma verdadera.

export const dropiScenarios = {
  eventoTracking: () => ({
    order_id: "DROPI-000001",
    status_id: 7,
    status_name: "ESTADO_SIN_CATALOGAR",
    guide_number: "DROPI-TRK-1",
  }),
  estadoDesconocido: () => ({
    order_id: "DROPI-000002",
    status_id: 999,
    status_name: "?",
  }),
  duplicado: (eventId = "dropi-evt-1") => ({ event_id: eventId, order_id: "DROPI-000001", status_id: 7 }),
};
