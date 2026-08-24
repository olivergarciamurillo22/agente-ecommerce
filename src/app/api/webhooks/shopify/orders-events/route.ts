import { NextResponse, type NextRequest } from "next/server";
import { processOrdersEventWebhook } from "@/lib/shopify/orders-events-webhook";

// Endpoint COMPARTIDO para orders/cancelled, orders/fulfilled y
// orders/updated: en Shopify, suscribe los tres topics a esta misma URL
// (el procesador despacha internamente por X-Shopify-Topic).
//
// El HMAC se calcula sobre el RAW body: hay que leer el texto tal cual
// llega, sin que nadie lo parsee antes. Y nada de evaluar esto en build time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const result = processOrdersEventWebhook(rawBody, {
    hmac: req.headers.get("x-shopify-hmac-sha256"),
    topic: req.headers.get("x-shopify-topic"),
    webhookId: req.headers.get("x-shopify-webhook-id"),
    shopDomain: req.headers.get("x-shopify-shop-domain"),
  });
  return NextResponse.json(result.body, { status: result.status });
}
