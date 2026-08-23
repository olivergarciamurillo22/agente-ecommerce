// ============================================================
// Normalización de pedidos de Shopify (webhook orders/create).
//
// Campos verificados contra la doc oficial del recurso Order
// (shopify.dev/docs/api/admin-rest/latest/resources/order):
//  - payment_gateway_names: array con el NOMBRE VISIBLE del método de pago
//    (p.ej. "Cash on Delivery (COD)"). Es el campo recomendado; `gateway`
//    está deprecado pero lo miramos también por si acaso.
//  - financial_status: los pedidos COD/manuales (incluidos los de Releasit
//    COD Form) nacen como "pending".
//  - Releasit puede añadir un tag propio al pedido si se activa en sus ajustes,
//    por eso también buscamos las palabras clave en `tags`.
// ============================================================

/** Subconjunto tipado del payload de orders/create que usamos. */
export interface ShopifyAddress {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  country_code?: string | null;
  phone?: string | null;
}

export interface ShopifyLineItem {
  title?: string | null;
  quantity?: number | null;
  price?: string | null;
  sku?: string | null;
  product_id?: number | string | null;
  variant_id?: number | string | null;
}

export interface ShopifyOrderPayload {
  id?: number | string;
  order_number?: number | string;
  name?: string | null; // "#1001"
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  created_at?: string | null; // ISO 8601 (lo manda Shopify en cada pedido)
  currency?: string | null;
  total_price?: string | null;
  financial_status?: string | null;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  tags?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    default_address?: ShopifyAddress | null;
  } | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[] | null;
  note_attributes?: Array<{ name?: string; value?: string }> | null;
}

export interface NormalizedOrder {
  shopifyOrderId: string;
  orderNumber: string; // "1001" (sin '#')
  customerName: string | null;
  phone: string; // dígitos internacionales normalizados; '' si no había teléfono
  rawPhone: string | null; // como venía en el payload (para mostrar)
  email: string | null;
  productSummary: string;
  totalPrice: string;
  currency: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  country: string | null;
  /** Nota del pedido + campos extra del formulario (p.ej. Releasit pregunta
   *  "¿A qué hora estarás en casa?"). Solo informativo para Pedro. */
  customerNote: string | null;
}

// --- Detección COD ---

const DEFAULT_COD_KEYWORDS = [
  "cod",
  "cash on delivery",
  "contra reembolso",
  "contrareembolso",
  "contra-reembolso",
  "releasit",
];

function codKeywords(): string[] {
  const raw = process.env.COD_GATEWAY_KEYWORDS;
  if (!raw || !raw.trim()) return DEFAULT_COD_KEYWORDS;
  return raw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** tags del payload como string plano — Shopify manda string, pero toleramos
 *  array por si algún intermediario lo transforma (payload no confiable). */
function tagsAsString(order: ShopifyOrderPayload): string {
  const t = order.tags as unknown;
  if (Array.isArray(t)) return t.map((x) => String(x)).join(",");
  return typeof t === "string" ? t : "";
}

/** Los textos del pedido donde puede aparecer la señal de COD. */
export function gatewayHaystack(order: ShopifyOrderPayload): string {
  const parts = [...(order.payment_gateway_names ?? []), order.gateway ?? "", tagsAsString(order)];
  return parts.join(" | ").toLowerCase();
}

// Señal PRIMARIA en Casamable: Releasit COD Form etiqueta cada pedido del
// formulario con este tag (confirmado en 49/49 pedidos COD reales).
// Los pedidos traen más tags (p.ej. "error Dropi"): se ignoran, nunca bloquean.
const RELEASIT_COD_TAG = "releasit_cod_form";

/** Tags del pedido como lista limpia (Shopify los da en un string con comas). */
export function orderTags(order: ShopifyOrderPayload): string[] {
  return tagsAsString(order)
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * ¿Es un pedido contra reembolso?
 *
 * Reglas, en orden:
 *  1. Tag exacto `releasit_cod_form` → COD (señal primaria de Casamable).
 *  2. Fallback: alguna palabra de COD_GATEWAY_KEYWORDS aparece en
 *     payment_gateway_names / gateway / tags.
 *  3. financial_status=pending NO basta por sí solo, salvo COD_PENDING_IS_COD=1
 *     (red amplia: atraparía también transferencias manuales).
 *  0. TREAT_ALL_ORDERS_AS_COD=1 → todos cuentan (SOLO desarrollo/pruebas).
 */
export function isCodOrder(order: ShopifyOrderPayload): boolean {
  if (process.env.TREAT_ALL_ORDERS_AS_COD === "1") return true;

  if (orderTags(order).includes(RELEASIT_COD_TAG)) return true;

  const haystack = gatewayHaystack(order);
  if (codKeywords().some((k) => haystack.includes(k))) return true;

  if (process.env.COD_PENDING_IS_COD === "1" && order.financial_status === "pending") {
    return true;
  }
  return false;
}

// --- Teléfono ---

/**
 * Normaliza un teléfono a dígitos internacionales SIN '+' (el formato con el
 * que Baileys identifica los chats: p.ej. "+34 612 34 56 78" → "34612345678").
 * Si el número parece nacional (9 dígitos en España), se le antepone
 * DEFAULT_COUNTRY_CODE (por defecto 34).
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const cc = (process.env.DEFAULT_COUNTRY_CODE ?? "34").replace(/\D/g, "") || "34";
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2); // prefijo internacional 00
  if (digits.startsWith(cc) && digits.length >= cc.length + 8) return digits;
  // Número nacional: quitar el 0 inicial si lo hay (formatos tipo 06...) y añadir CC.
  digits = digits.replace(/^0+/, "");
  if (digits.length >= 8 && digits.length <= 10) return cc + digits;
  return digits; // formato raro: lo devolvemos tal cual (mejor que perderlo)
}

/**
 * Extrae el teléfono del pedido con este orden de prioridad (en formularios COD
 * el teléfono se pide como dato de ENTREGA, por eso shipping va primero):
 * shipping_address.phone → customer.phone → billing_address.phone →
 * customer.default_address.phone → order.phone
 */
export function extractRawPhone(order: ShopifyOrderPayload): string | null {
  return (
    order.shipping_address?.phone ||
    order.customer?.phone ||
    order.billing_address?.phone ||
    order.customer?.default_address?.phone ||
    order.phone ||
    null
  );
}

// --- Normalización completa ---

function pickAddress(order: ShopifyOrderPayload): ShopifyAddress | null {
  return order.shipping_address ?? order.billing_address ?? order.customer?.default_address ?? null;
}

function customerName(order: ShopifyOrderPayload): string | null {
  const c = order.customer;
  const fromCustomer = [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim();
  if (fromCustomer) return fromCustomer;
  const addr = pickAddress(order);
  if (addr?.name) return addr.name;
  const fromAddr = [addr?.first_name, addr?.last_name].filter(Boolean).join(" ").trim();
  return fromAddr || null;
}

/**
 * Formatea los line_items reales del pedido (NUNCA hardcodear catálogo):
 *  - un solo producto, cantidad 1 → "Limpiador Ultrasónico Multiusos"
 *  - cantidad > 1                → "2x Limpiador Ultrasónico Multiusos"
 *  - varios productos            → una línea por producto, con "Nx" siempre:
 *      "1x Cortaúñas y Pulidor Eléctrico 3 en 1
 *       1x Seguro de Envío"
 */
export function formatOrderItems(order: ShopifyOrderPayload): string {
  const items = (order.line_items ?? []).filter((li) => li?.title);
  if (items.length === 0) return "Tu pedido";
  const lines = items.map((li) => {
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    const showQty = qty > 1 || items.length > 1;
    return `${showQty ? `${qty}x ` : ""}${String(li.title).trim()}`;
  });
  let summary = lines.join("\n");
  if (summary.length > 300) summary = summary.slice(0, 297) + "…";
  return summary;
}

/** Nota del pedido + note_attributes ("nombre: valor"), todo lo que rellenó el
 *  cliente en el formulario. Vacío → null. Capado a 500 chars. */
function customerNote(order: ShopifyOrderPayload): string | null {
  const parts: string[] = [];
  if (order.note && order.note.trim()) parts.push(order.note.trim());
  for (const attr of order.note_attributes ?? []) {
    const name = (attr?.name ?? "").trim();
    const value = (attr?.value ?? "").trim();
    if (value) parts.push(name ? `${name}: ${value}` : value);
  }
  if (parts.length === 0) return null;
  return parts.join("\n").slice(0, 500);
}

export function normalizeOrder(order: ShopifyOrderPayload): NormalizedOrder {
  const addr = pickAddress(order);
  const rawPhone = extractRawPhone(order);
  return {
    shopifyOrderId: String(order.id ?? ""),
    orderNumber: String(order.order_number ?? order.name?.replace(/^#/, "") ?? ""),
    customerName: customerName(order),
    phone: normalizePhone(rawPhone),
    rawPhone,
    email: order.email ?? order.customer?.email ?? null,
    productSummary: formatOrderItems(order),
    totalPrice: order.total_price ?? "",
    currency: order.currency ?? "EUR",
    addressLine1: addr?.address1 ?? null,
    addressLine2: addr?.address2 ?? null,
    city: addr?.city ?? null,
    province: addr?.province ?? null,
    postalCode: addr?.zip ?? null,
    country: addr?.country ?? addr?.country_code ?? null,
    customerNote: customerNote(order),
  };
}

/**
 * Limpia un campo de dirección: los formularios COD traen a menudo relleno
 * inútil ("-", ".", "n/a") que no debe aparecer en el mensaje al cliente.
 */
function addrField(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (/^[-—.·,\s]+$/.test(v)) return null; // solo signos: basura de formulario
  if (/^(n\/?a|na|sin|ninguno|none)$/i.test(v)) return null;
  return v;
}

/** El país solo se muestra si NO es España (para un cliente español sobra). */
function foreignCountry(country: string | null | undefined): string | null {
  const c = addrField(country);
  if (!c) return null;
  if (/^(espa(ñ|n)a|spain|es|esp)$/i.test(c)) return null;
  return c;
}

/** Dirección en una línea para logs/tabla. */
export function formatAddressOneLine(o: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
}): string {
  return [
    addrField(o.address_line1),
    addrField(o.address_line2),
    [addrField(o.postal_code), addrField(o.city)].filter(Boolean).join(" "),
    addrField(o.province),
  ]
    .filter((p) => p && p.trim())
    .join(", ");
}

/** Dirección multilínea para el mensaje de WhatsApp. */
export function formatAddressForMessage(o: {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
}): string {
  const lines = [
    addrField(o.address_line1),
    addrField(o.address_line2),
    [addrField(o.postal_code), addrField(o.city)].filter(Boolean).join(" "),
    [addrField(o.province), foreignCountry(o.country)].filter(Boolean).join(", "),
  ].filter((l): l is string => Boolean(l && l.trim()));
  return lines.length ? lines.join("\n") : "(sin dirección — repásala con el cliente)";
}
