// ============================================================
// Suscripciones de webhooks de Shopify — auditable y reproducible.
// Nada de "se creó una vez desde el dashboard": este módulo sabe qué
// suscripciones DEBEN existir, lista las reales y calcula el plan de
// creación sin duplicar. La ejecución vive en scripts/shopify-webhooks.ts.
// ============================================================

import { getAdminAccessToken } from "./admin";

function apiVersion(): string {
  return process.env.SHOPIFY_API_VERSION || "2026-07";
}
function storeDomain(): string {
  return (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "https://agente.casamable.es").replace(/\/+$/, "");
}

/** Las suscripciones que este sistema NECESITA. Única fuente de verdad. */
export function desiredSubscriptions(): Array<{ topic: string; address: string }> {
  const base = publicBaseUrl();
  return [
    { topic: "orders/create", address: `${base}/api/webhooks/shopify/orders-create` },
    { topic: "orders/cancelled", address: `${base}/api/webhooks/shopify/orders-events` },
    { topic: "orders/fulfilled", address: `${base}/api/webhooks/shopify/orders-events` },
    { topic: "orders/updated", address: `${base}/api/webhooks/shopify/orders-events` },
  ];
}

export interface ShopifyWebhookSub {
  id: number;
  topic: string;
  address: string;
  api_version?: string;
}

export interface WebhookPlan {
  ok: Array<{ topic: string; address: string }>;
  toCreate: Array<{ topic: string; address: string }>;
  /** Mismo topic pero apuntando a otra URL: se avisa, NO se borra solo. */
  mismatched: Array<{ topic: string; expected: string; actual: string }>;
  /** Suscripciones existentes que no pedimos (informativo). */
  extra: ShopifyWebhookSub[];
}

/** PURA: qué falta y qué sobra. Testeable sin red. */
export function planWebhookEnsure(
  existing: ShopifyWebhookSub[],
  desired: Array<{ topic: string; address: string }> = desiredSubscriptions()
): WebhookPlan {
  const plan: WebhookPlan = { ok: [], toCreate: [], mismatched: [], extra: [] };
  for (const want of desired) {
    const match = existing.find((e) => e.topic === want.topic);
    if (!match) plan.toCreate.push(want);
    else if (match.address.replace(/\/+$/, "") !== want.address.replace(/\/+$/, "")) {
      plan.mismatched.push({ topic: want.topic, expected: want.address, actual: match.address });
    } else plan.ok.push(want);
  }
  plan.extra = existing.filter((e) => !desired.some((w) => w.topic === e.topic));
  return plan;
}

export async function listShopifyWebhooks(): Promise<ShopifyWebhookSub[]> {
  const token = await getAdminAccessToken();
  if (!token) throw new Error("sin token de acceso de Shopify");
  const res = await fetch(`https://${storeDomain()}/admin/api/${apiVersion()}/webhooks.json?limit=250`, {
    headers: { "X-Shopify-Access-Token": token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhooks.json HTTP ${res.status}`);
  const json = (await res.json()) as { webhooks?: ShopifyWebhookSub[] };
  return json.webhooks ?? [];
}

export async function createShopifyWebhook(topic: string, address: string): Promise<ShopifyWebhookSub> {
  const token = await getAdminAccessToken();
  if (!token) throw new Error("sin token de acceso de Shopify");
  const res = await fetch(`https://${storeDomain()}/admin/api/${apiVersion()}/webhooks.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(`crear webhook ${topic}: HTTP ${res.status} ${detalle.slice(0, 200)}`);
  }
  const json = (await res.json()) as { webhook: ShopifyWebhookSub };
  return json.webhook;
}
