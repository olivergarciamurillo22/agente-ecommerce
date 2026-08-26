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
  /**
   * Mismo topic con MÁS DE UNA suscripción activa. Esto es lo que antes se
   * quedaba invisible: con `existing.find()` (un solo match) una duplicada
   * nunca aparecía como "extra" (su topic SÍ está en `desired`) ni como
   * "mismatched" (la primera coincidencia podía apuntar bien). El síntoma
   * real: Shopify entrega el mismo topic dos veces, una de ellas firmada
   * con un secreto que el código no conoce (p.ej. una suscripción vieja
   * creada desde el admin, con el secreto compartido de la tienda, en vez
   * del secreto de la app) — y esa copia falla HMAC en bucle.
   * NUNCA se borra sola: hace falta mirar `id`/`address` de cada una y
   * decidir a mano cuál sobra.
   */
  duplicates: Array<{ topic: string; subscriptions: ShopifyWebhookSub[] }>;
}

/** PURA: qué falta, qué sobra y qué está duplicado. Testeable sin red. */
export function planWebhookEnsure(
  existing: ShopifyWebhookSub[],
  desired: Array<{ topic: string; address: string }> = desiredSubscriptions()
): WebhookPlan {
  const plan: WebhookPlan = { ok: [], toCreate: [], mismatched: [], extra: [], duplicates: [] };

  const porTopic = new Map<string, ShopifyWebhookSub[]>();
  for (const e of existing) {
    const arr = porTopic.get(e.topic) ?? [];
    arr.push(e);
    porTopic.set(e.topic, arr);
  }
  for (const [topic, subs] of porTopic) {
    if (subs.length > 1) plan.duplicates.push({ topic, subscriptions: subs });
  }

  for (const want of desired) {
    const matches = existing.filter((e) => e.topic === want.topic);
    if (matches.length === 0) {
      plan.toCreate.push(want);
      continue;
    }
    // Con duplicados, basta con que UNA apunte a la URL correcta para
    // considerar el topic cubierto — el duplicado en sí ya quedó reportado
    // arriba, independientemente de esto.
    const coincide = matches.find((m) => m.address.replace(/\/+$/, "") === want.address.replace(/\/+$/, ""));
    if (coincide) plan.ok.push(want);
    else plan.mismatched.push({ topic: want.topic, expected: want.address, actual: matches[0].address });
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
