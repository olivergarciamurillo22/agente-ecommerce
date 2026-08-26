import crypto from "node:crypto";

/**
 * Verifica la firma HMAC de un webhook de Shopify.
 *
 * Shopify manda en el header `X-Shopify-Hmac-Sha256` el HMAC-SHA256 del RAW
 * body, con el secret como clave, codificado en BASE64 (no hex). Comparación
 * en tiempo constante para no filtrar información por timing.
 */
export function verifyShopifyHmac(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined,
  secret: string | undefined
): boolean {
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export type ShopifyHmacMatch = "webhook_secret" | "client_secret" | "ninguno";

/**
 * DIAGNÓSTICO (BUG2, 26-08). Shopify firma un webhook con uno de DOS
 * secretos distintos según quién creó la suscripción:
 *   - creada desde el admin (Configuración → Notificaciones) → el secreto
 *     de webhooks de la tienda (SHOPIFY_WEBHOOK_SECRET, el único que este
 *     código valida hoy);
 *   - creada por una app vía API → el CLIENT SECRET de esa app
 *     (SHOPIFY_CLIENT_SECRET).
 * La migración del 24-08 (admin-created → app-owned) pudo dejar algunas
 * suscripciones firmando con el segundo mientras el código solo comprueba
 * el primero. Esta función SOLO informa cuál coincide — no acepta nada,
 * no cambia ninguna decisión de la ruta. Nunca devuelve ni loguea un
 * secreto: solo la ETIQUETA de cuál encajó.
 */
export function diagnoseShopifyHmacSecret(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined
): ShopifyHmacMatch {
  if (verifyShopifyHmac(rawBody, hmacHeader, process.env.SHOPIFY_WEBHOOK_SECRET)) return "webhook_secret";
  if (verifyShopifyHmac(rawBody, hmacHeader, process.env.SHOPIFY_CLIENT_SECRET)) return "client_secret";
  return "ninguno";
}
