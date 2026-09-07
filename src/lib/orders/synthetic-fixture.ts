import fs from "node:fs";
import path from "node:path";
import { insertOrderIfNew, systemDbHandle, type OrderRow } from "../db";
import { logIntegrationEvent } from "../system/repo";
import { normalizeOrder, normalizePhone, type ShopifyOrderPayload } from "./normalize";
import { phoneAllowlist, testMode } from "../safety";

export function loadAnonymizedShopifyFixture(): ShopifyOrderPayload {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/shopify/order-create-anonymized.json"), "utf8")) as ShopifyOrderPayload;
}

export function nextSyntheticOrderNumber(): string {
  const row = systemDbHandle().prepare("SELECT MAX(CAST(REPLACE(shopify_order_number,'#','') AS INTEGER)) AS n FROM orders WHERE CAST(REPLACE(shopify_order_number,'#','') AS INTEGER) BETWEEN 999000 AND 999998").get() as { n: number | null };
  return String(Math.max(999000, Number(row.n ?? 999000)) + 1);
}

export function createSyntheticOrder(rawPhone: string): OrderRow {
  if (!testMode()) throw new Error("fixture:pedido exige TEST_MODE=1");
  const phone = normalizePhone(rawPhone);
  if (!phone || !phoneAllowlist().includes(phone)) throw new Error("el teléfono debe estar en TEST_PHONE_ALLOWLIST");
  const number = nextSyntheticOrderNumber();
  const payload = loadAnonymizedShopifyFixture();
  payload.id = Number(`900000${number}`);
  payload.order_number = Number(number);
  payload.name = `#${number}`;
  payload.created_at = new Date().toISOString();
  if (payload.shipping_address) payload.shipping_address.phone = rawPhone;
  const normalized = normalizeOrder(payload);
  if (normalized.phone !== phone) throw new Error("el teléfono no coincide con la normalización del webhook");
  const inserted = insertOrderIfNew({
    shopify_order_id: normalized.shopifyOrderId, shopify_order_number: normalized.orderNumber,
    customer_name: normalized.customerName, phone: normalized.phone, email: normalized.email,
    product_summary: normalized.productSummary, total_price: normalized.totalPrice, currency: normalized.currency,
    address_line1: normalized.addressLine1, address_line2: normalized.addressLine2, city: normalized.city,
    province: normalized.province, postal_code: normalized.postalCode, country: normalized.country,
    status: "pending_send", customer_note: normalized.customerNote, last_error: null,
    raw_payload: JSON.stringify(payload), ordered_at: normalized.orderedAt, attribution: normalized.attribution,
  });
  if (!inserted.created) throw new Error(`la fixture #${number} ya existía`);
  logIntegrationEvent("shopify", "synthetic_order_created", "info", "pedido sintético creado por fixture:pedido", normalized.orderNumber);
  return inserted.order;
}
