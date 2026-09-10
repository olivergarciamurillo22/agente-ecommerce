// ============================================================
// VERIFICAR UNA CLAVE ANTES DE GUARDARLA (10-09-2026)
//
// El panel deja al cliente cambiar CUALQUIER clave, incluidas las que tumban
// producción si se pegan mal (el secreto del webhook de Shopify, el token de
// WhatsApp). La protección contra eso es esta: antes de guardar, se prueba la
// clave candidata contra el proveedor de verdad, con una llamada de SOLO
// LECTURA, y si no responde no se guarda.
//
// Reglas de la casa que se respetan aquí:
//   · Nunca se escribe nada en el proveedor: solo GET.
//   · El valor candidato no toca `process.env` hasta que la prueba pasa.
//   · Lo que no se puede comprobar se declara «no verificable» y se dice por
//     qué; jamás se devuelve un «ok» que no se ha comprobado.
//   · El token de la biblioteca de anuncios se valida contra `/me`, NO contra
//     `/ads_archive`: esa búsqueda gasta cuota y está bajo EMERGENCY_STOP.
//     La comprobación completa sigue siendo `hunter:discovery:doctor`.
// ============================================================

import { META_ADS_DEFAULT_API_VERSION } from "../meta-ads/config";

export interface VerifyResult {
  status: "ok" | "fallo" | "no_verificable";
  /** Frase en español para el panel. Nunca lleva el valor de la clave. */
  message: string;
}

const TIMEOUT_MS = 12_000;
const UA = "CasamableAgent/verificacion-de-claves";

const graphVersion = (env: Record<string, string | undefined>) =>
  env.META_WHATSAPP_API_VERSION || env.META_GRAPH_API_VERSION || env.META_ADS_API_VERSION || META_ADS_DEFAULT_API_VERSION;

/** Mensaje de error legible sin filtrar nada del valor probado. */
function motivo(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/abort|timeout/i.test(m)) return "el proveedor no respondió a tiempo";
  return m.slice(0, 120);
}

type Fetcher = typeof fetch;

async function get(f: Fetcher, url: string, headers: Record<string, string>): Promise<Response> {
  return f(url, { method: "GET", headers: { ...headers, "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Prueba la clave `value` contra su proveedor. `env` aporta el contexto que
 * hace falta (dominio de la tienda, id del número), y puede llevar ya los
 * valores nuevos si el cliente está cambiando varias cosas a la vez.
 */
export async function verifySecret(
  name: string,
  value: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<VerifyResult> {
  try {
    return await comprobar(name, value.trim(), env, fetcher);
  } catch (e) {
    return { status: "fallo", message: `no se pudo comprobar: ${motivo(e)}` };
  }
}

async function comprobar(name: string, value: string, env: Record<string, string | undefined>, f: Fetcher): Promise<VerifyResult> {
  switch (name) {
    case "SHOPIFY_ADMIN_ACCESS_TOKEN": {
      const dominio = (env.SHOPIFY_STORE_DOMAIN ?? "").trim();
      if (!dominio) return { status: "no_verificable", message: "falta SHOPIFY_STORE_DOMAIN: sin el dominio de la tienda no hay contra qué probar" };
      const v = env.SHOPIFY_API_VERSION?.trim() || "2025-01";
      const r = await get(f, `https://${dominio}/admin/api/${v}/shop.json`, { "x-shopify-access-token": value });
      if (r.ok) return { status: "ok", message: `la tienda ${dominio} responde y acepta el token` };
      if (r.status === 401 || r.status === 403) return { status: "fallo", message: `Shopify rechaza el token (HTTP ${r.status}): revisa que sea el de acceso de la Admin API, el que empieza por shpat_` };
      return { status: "fallo", message: `Shopify respondió HTTP ${r.status}` };
    }

    case "META_WHATSAPP_ACCESS_TOKEN": {
      const id = (env.META_WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
      if (!id) return { status: "no_verificable", message: "falta META_WHATSAPP_PHONE_NUMBER_ID: sin el id del número no hay contra qué probar" };
      const r = await get(f, `https://graph.facebook.com/${graphVersion(env)}/${id}?fields=display_phone_number,verified_name`, { authorization: `Bearer ${value}` });
      const j = await r.json().catch(() => null) as { display_phone_number?: string; error?: { message?: string; code?: number } } | null;
      if (r.ok) return { status: "ok", message: `Meta acepta el token para el número ${j?.display_phone_number ?? id}` };
      if (j?.error?.code === 190) return { status: "fallo", message: "Meta dice que el token no vale o ha caducado: si es el de la pantalla de pruebas, caduca en 24 h y hace falta el permanente del usuario del sistema" };
      return { status: "fallo", message: `Meta respondió HTTP ${r.status}${j?.error?.message ? `: ${j.error.message.slice(0, 90)}` : ""}` };
    }

    case "META_AD_LIBRARY_ACCESS_TOKEN":
    case "META_ADS_ACCESS_TOKEN": {
      // A propósito contra /me: /ads_archive gasta cuota y está bajo EMERGENCY_STOP.
      const r = await get(f, `https://graph.facebook.com/${graphVersion(env)}/me?fields=id,name`, { authorization: `Bearer ${value}` });
      const j = await r.json().catch(() => null) as { name?: string; error?: { message?: string; code?: number } } | null;
      if (r.ok) {
        return name === "META_AD_LIBRARY_ACCESS_TOKEN"
          ? { status: "ok", message: `el token está vivo (${j?.name ?? "cuenta verificada"}). Recuerda: para la biblioteca de anuncios solo vale un token de PERSONA FÍSICA y caduca a los 60 días. La comprobación completa es «hunter:discovery:doctor»` }
          : { status: "ok", message: `el token está vivo (${j?.name ?? "cuenta verificada"})` };
      }
      if (j?.error?.code === 190) return { status: "fallo", message: "Meta dice que el token no vale o ha caducado" };
      return { status: "fallo", message: `Meta respondió HTTP ${r.status}${j?.error?.message ? `: ${j.error.message.slice(0, 90)}` : ""}` };
    }

    case "OPENROUTER_API_KEY": {
      // /api/v1/key es el único que valida de verdad: /models es público y responde 200 con cualquier cosa.
      const r = await get(f, "https://openrouter.ai/api/v1/key", { authorization: `Bearer ${value}` });
      if (r.ok) return { status: "ok", message: "OpenRouter acepta la clave" };
      if (r.status === 401) return { status: "fallo", message: "OpenRouter rechaza la clave (HTTP 401)" };
      return { status: "fallo", message: `OpenRouter respondió HTTP ${r.status}` };
    }

    case "OPENAI_API_KEY": {
      const r = await get(f, "https://api.openai.com/v1/models", { authorization: `Bearer ${value}` });
      if (r.ok) return { status: "ok", message: "OpenAI acepta la clave" };
      if (r.status === 401) return { status: "fallo", message: "OpenAI rechaza la clave (HTTP 401)" };
      return { status: "fallo", message: `OpenAI respondió HTTP ${r.status}` };
    }

    case "RETELL_API_KEY": {
      const r = await get(f, "https://api.retellai.com/list-agents", { authorization: `Bearer ${value}` });
      if (r.ok) return { status: "ok", message: "Retell acepta la clave" };
      if (r.status === 401 || r.status === 403) return { status: "fallo", message: `Retell rechaza la clave (HTTP ${r.status})` };
      return { status: "fallo", message: `Retell respondió HTTP ${r.status}` };
    }

    case "DROPEA_API_KEY": {
      const explicita = (env.DROPEA_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
      const mercado = (env.DROPEA_MARKET ?? "es").trim().toLowerCase();
      const base = explicita || `https://${mercado}.public-api.dropea.com`;
      const r = await get(f, `${base}/products?limit=1`, { authorization: `Bearer ${value}` });
      if (r.ok) return { status: "ok", message: "el proveedor responde y acepta la clave" };
      if (r.status === 401 || r.status === 403) return { status: "fallo", message: `Dropea rechaza la clave (HTTP ${r.status})` };
      return { status: "fallo", message: `Dropea respondió HTTP ${r.status}` };
    }

    // Secretos de FIRMA: no hay a quién preguntarle. El proveedor los usa para
    // firmar lo que nos manda, así que la única prueba real es que llegue un
    // webhook y valide. Decirlo es más honesto que inventar un «ok».
    case "SHOPIFY_WEBHOOK_SECRET":
      return { status: "no_verificable", message: "no se puede comprobar sola: firma los webhooks. Se confirma cuando entre un pedido de prueba y NO sea rechazado" };
    case "META_WHATSAPP_APP_SECRET":
      return { status: "no_verificable", message: "no se puede comprobar sola: valida la firma de Meta. Se confirma cuando un cliente responda y el mensaje se procese" };
    case "META_WHATSAPP_VERIFY_TOKEN":
      return { status: "no_verificable", message: "no se puede comprobar sola: solo se usa al dar de alta el webhook en Meta. Si la cambias, hay que volver a verificar el webhook allí" };
    case "DROPEA_WEBHOOK_SECRET":
    case "DROPIPRO_WEBHOOK_SECRET":
      return { status: "no_verificable", message: "no se puede comprobar sola: firma los avisos del proveedor" };

    default:
      return { status: "no_verificable", message: "no hay prueba automática para esta clave" };
  }
}
