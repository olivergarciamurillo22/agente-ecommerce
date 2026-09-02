// ============================================================
// ATRIBUCIÓN DE MARKETING (02-09): lo que Shopify cuenta del ORIGEN del
// pedido, capturado en el momento de crearlo — el dato que se pierde hoy
// no se recupera mañana.
//
// Reglas:
//  - NO se inventa atribución: si un campo no viene, queda NULL.
//  - El parser de UTM es a prueba de URLs rotas: relativa, mal formada,
//    doblemente codificada o con parámetros duplicados (gana el PRIMERO).
//  - El crudo completo ya se conserva en orders.raw_payload (política
//    existente): estas columnas son la INTERPRETACIÓN, reinterpretable.
//  - fbclid se conserva porque Shopify ya lo trae dentro de landing_site
//    y es la única llave futura hacia Meta (§2.1). Nada se envía a nadie.
// ============================================================

/** Los campos de origen que puede traer un pedido de Shopify. */
export interface AttributionPayloadFields {
  landing_site?: string | null;
  landing_site_ref?: string | null;
  referring_site?: string | null;
  source_name?: string | null;
  source_identifier?: string | null;
}

export interface OrderAttribution {
  /** UTM parseadas de landing_site (URL-decoded). */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  /** Click id de Meta si venía en la URL de aterrizaje. */
  fbclid: string | null;
  /** La URL de aterrizaje tal cual (truncada). */
  landingSite: string | null;
  /** De dónde venía el visitante. */
  referringSite: string | null;
  /** Canal según Shopify ("web", "pos", …). */
  sourceName: string | null;
}

export const EMPTY_ATTRIBUTION: OrderAttribution = {
  source: null,
  medium: null,
  campaign: null,
  content: null,
  term: null,
  fbclid: null,
  landingSite: null,
  referringSite: null,
  sourceName: null,
};

const MAX_LEN = 250;

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, MAX_LEN) : null;
};

/**
 * Extrae los query params de una URL que puede ser relativa, absoluta o
 * estar rota. JAMÁS lanza. Con parámetros duplicados gana el PRIMERO
 * (URLSearchParams.get ya devuelve el primero).
 */
export function queryParamsOf(url: string | null | undefined): URLSearchParams {
  const u = (url ?? "").trim();
  const idx = u.indexOf("?");
  if (idx < 0) return new URLSearchParams();
  try {
    return new URLSearchParams(u.slice(idx + 1));
  } catch {
    return new URLSearchParams();
  }
}

/** Parsea la atribución disponible de un payload de Shopify. Puro. */
export function parseAttribution(payload: AttributionPayloadFields | null | undefined): OrderAttribution {
  if (!payload) return { ...EMPTY_ATTRIBUTION };
  const landing = clean(payload.landing_site);
  const params = queryParamsOf(landing);
  const p = (k: string) => clean(params.get(k));
  return {
    source: p("utm_source"),
    medium: p("utm_medium"),
    campaign: p("utm_campaign"),
    content: p("utm_content"),
    term: p("utm_term"),
    fbclid: p("fbclid"),
    landingSite: landing,
    // landing_site_ref es la variante corta del referrer que Shopify añade
    // a veces; referring_site manda cuando ambos existen.
    referringSite: clean(payload.referring_site) ?? clean(payload.landing_site_ref),
    sourceName: clean(payload.source_name),
  };
}

/** ¿Trae ALGO de atribución? (para medir cobertura sin contar vacíos). */
export function hasAnyAttribution(a: OrderAttribution): boolean {
  return Boolean(a.source || a.medium || a.campaign || a.content || a.term || a.fbclid || a.landingSite || a.referringSite);
}
