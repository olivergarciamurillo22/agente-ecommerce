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

export interface ShopifyHmacVerification {
  valid: boolean;
  /** Con cuál de los dos secretos encajó (o "ninguno" si no encajó con ninguno). */
  matchedWith: ShopifyHmacMatch;
}

/**
 * Verifica el HMAC contra los DOS secretos de firma que usa Shopify (BUG2,
 * confirmado en producción el 26-08): Shopify firma un webhook con uno de
 * dos secretos distintos según quién creó la suscripción:
 *   - creada desde el admin (Configuración → Notificaciones) → el secreto
 *     de webhooks de la tienda (SHOPIFY_WEBHOOK_SECRET);
 *   - creada por una app vía API → el CLIENT SECRET de esa app
 *     (SHOPIFY_CLIENT_SECRET). Los 4 webhooks de este proyecto los creó la
 *     app, así que firman con este.
 * Las dos comparaciones se hacen SIEMPRE (nunca se corta en cuanto una
 * encaja) para no depender de en qué orden se prueben los secretos.
 * `verifyShopifyHmac` ya compara en tiempo constante (`timingSafeEqual`)
 * dentro de cada una.
 */
export function verifyShopifyHmacEitherSecret(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined
): ShopifyHmacVerification {
  const matchesWebhookSecret = verifyShopifyHmac(rawBody, hmacHeader, process.env.SHOPIFY_WEBHOOK_SECRET);
  const matchesClientSecret = verifyShopifyHmac(rawBody, hmacHeader, process.env.SHOPIFY_CLIENT_SECRET);
  if (matchesWebhookSecret) return { valid: true, matchedWith: "webhook_secret" };
  if (matchesClientSecret) return { valid: true, matchedWith: "client_secret" };
  return { valid: false, matchedWith: "ninguno" };
}
