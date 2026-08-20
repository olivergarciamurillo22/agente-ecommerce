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
