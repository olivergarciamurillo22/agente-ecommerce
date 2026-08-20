// ============================================================
// Cliente mínimo de la Admin API de Shopify (GraphQL).
//
// Solo lo usamos para AÑADIR el tag WA_CONFIRMED al pedido cuando el cliente
// confirma. Usamos la mutación `tagsAdd` porque añade sin borrar los tags
// existentes (orderUpdate los machacaría). No tocamos fulfillment ni estados
// financieros. Todo es best-effort: si falla, el pedido queda confirmado
// igualmente en nuestro sistema y se reintenta en el siguiente tick.
// ============================================================

import pino from "pino";
import { canWriteToShopify, logOnce } from "../safety";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const API_VERSION = () => process.env.SHOPIFY_API_VERSION || "2026-07";
export const CONFIRMED_TAG = "WA_CONFIRMED";

function storeDomain(): string {
  return (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

/**
 * ¿Hay alguna credencial de Admin API? Dos vías:
 *  A) SHOPIFY_ADMIN_ACCESS_TOKEN estático (shpat_…), o
 *  B) SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard, token ~24h).
 * Sin ninguna, todo funciona igual pero sin tag en Shopify.
 */
export function shopifyAdminConfigured(): boolean {
  if (!storeDomain()) return false;
  if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) return true;
  return Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

function endpoint(): string {
  return `https://${storeDomain()}/admin/api/${API_VERSION()}/graphql.json`;
}

// Token obtenido por client-credentials: caduca (~24h), así que se cachea en
// memoria y se renueva solo. Se pierde al reiniciar, y no pasa nada: se vuelve
// a pedir. NUNCA se escribe en disco ni se registra en los logs.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

/** Solo para tests: olvida el token cacheado. */
export function _resetTokenCache(): void {
  cachedToken = null;
}

/**
 * Devuelve el token de acceso a usar, o null si no hay credenciales válidas.
 * Prioriza el token estático; si no, lo pide con client-credentials.
 */
export async function getAdminAccessToken(): Promise<string | null> {
  const staticToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (staticToken) return staticToken;

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret || !storeDomain()) return null;

  // Reutiliza el token mientras le quede más de 5 min de vida.
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 5 * 60_000) {
    return cachedToken.token;
  }

  try {
    const res = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Nunca registrar el cuerpo: podría contener datos de la credencial.
      logger.warn(`[SHOPIFY] no se pudo obtener token (client_credentials): HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      logger.warn("[SHOPIFY] respuesta de token sin access_token");
      return null;
    }
    const ttl = typeof json.expires_in === "number" ? json.expires_in : 86_400;
    cachedToken = { token: json.access_token, expiresAtMs: Date.now() + ttl * 1000 };
    logger.info(`[SHOPIFY] token de Admin API renovado (válido ~${Math.round(ttl / 3600)}h)`);
    return cachedToken.token;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[SHOPIFY] error pidiendo token de Admin API"
    );
    return null;
  }
}

interface GraphQLResponse {
  data?: {
    tagsAdd?: {
      node?: { id?: string } | null;
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
}

/**
 * Añade el tag WA_CONFIRMED al pedido en Shopify.
 * Devuelve true si quedó aplicado. Nunca lanza: registra y devuelve false.
 */
export async function tagOrderConfirmed(shopifyOrderId: string): Promise<boolean> {
  // SAFETY GATE: única puerta de escritura a Shopify. En safe/test-sin-flag,
  // NO se toca la tienda; el scheduler lo reintentará cuando se habilite.
  if (!canWriteToShopify()) {
    logOnce(
      `shopify-blocked-${shopifyOrderId}`,
      `[SAFE MODE] Shopify mutation bloqueada | Se habría añadido WA_CONFIRMED al pedido ${shopifyOrderId}`
    );
    return false;
  }
  if (!shopifyAdminConfigured()) {
    logger.info("[SHOPIFY] Admin API no configurada — tag WA_CONFIRMED omitido");
    return false;
  }
  const accessToken = await getAdminAccessToken();
  if (!accessToken) {
    logger.warn(`[SHOPIFY] sin token válido — tag de ${shopifyOrderId} pendiente de reintento`);
    return false;
  }
  try {
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `mutation AddTag($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
        variables: {
          id: `gid://shopify/Order/${shopifyOrderId}`,
          tags: [CONFIRMED_TAG],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      // 401 con token de client-credentials: probablemente caducó → forzar
      // renovación en el siguiente intento del scheduler.
      if (res.status === 401) {
        _resetTokenCache();
        logger.warn(
          `[SHOPIFY] tagsAdd 401 (credencial inválida o caducada) para ${shopifyOrderId} — se reintentará`
        );
        return false;
      }
      logger.warn(`[SHOPIFY] tagsAdd HTTP ${res.status} para pedido ${shopifyOrderId}`);
      return false;
    }
    const json = (await res.json()) as GraphQLResponse;
    const userErrors = json.data?.tagsAdd?.userErrors ?? [];
    if (json.errors?.length || userErrors.length) {
      const msg = [...(json.errors ?? []), ...userErrors].map((e) => e.message).join("; ");
      logger.warn(`[SHOPIFY] tagsAdd rechazado para pedido ${shopifyOrderId}: ${msg}`);
      return false;
    }
    logger.info(`[SHOPIFY] Tag ${CONFIRMED_TAG} añadido al pedido ${shopifyOrderId}`);
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `[SHOPIFY] error añadiendo tag al pedido ${shopifyOrderId}`
    );
    return false;
  }
}
