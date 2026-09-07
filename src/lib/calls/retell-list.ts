// ============================================================
// LISTADOS DE RETELL — rutas nuevas y respuesta paginada (07-09-2026)
//
// Retell mandó dos avisos de deprecación distintos y este repo llamaba a los
// dos endpoints viejos (solo desde `npm run retell:doctor`, nunca en runtime):
//
//   1) 15-06-2026 · "Legacy list endpoints removed for v2/v3"
//      GET /list-phone-numbers  →  GET /v2/list-phone-numbers
//      https://docs.retellai.com/deprecation-notice/2026/06-15_legacy_list_endpoints
//      Esa fecha YA VENCIÓ: el endpoint viejo puede estar fuera de servicio.
//
//   2) 15-09-2026 · "Legacy get-agent-versions endpoints removed"
//      GET /get-agent-versions/{id}  →  GET /list-agent-versions/{id}
//      https://docs.retellai.com/deprecation-notice/2026/09-15_get_agent_versions
//
// TRAMPA que separa los dos avisos: el sustituto del primero GANA prefijo
// (`/v2/`) y el del segundo NO lo lleva. Aplicar la regla del primero por
// analogía da un 404.
//
// LO QUE ROMPE DE VERDAD no es la URL, es el PARSEO: los endpoints viejos
// devolvían un array JSON en la raíz y los nuevos devuelven un objeto
// `{ items, pagination_key, has_more }`. Un `Array.isArray(json)` sobre la
// respuesta nueva da false y el diagnóstico se quedaría mudo sin fallar, que
// es la peor forma de romperse. Por eso `listItems` acepta las dos formas: así
// el doctor sigue funcionando contra una cuenta que aún sirva el formato viejo
// y contra la nueva, sin adivinar cuál toca.
// ============================================================

/** Rutas vigentes, con su fecha de verificación contra la documentación. */
export const RETELL_LIST_PHONE_NUMBERS_PATH = "/v2/list-phone-numbers";
export const RETELL_LIST_AGENT_VERSIONS_PATH = (agentId: string) => `/list-agent-versions/${encodeURIComponent(agentId)}`;

export interface PaginatedRead<T> {
  items: T[];
  /** Cursor de la página siguiente (null si no hay más o si la respuesta es antigua). */
  paginationKey: string | null;
  hasMore: boolean;
  /** true si la respuesta venía en el formato viejo (array en la raíz). */
  legacyShape: boolean;
}

/**
 * Lee una respuesta de listado sin dar por hecho su forma. Devuelve siempre
 * una lista, aunque esté vacía: quien lo llama no tiene que distinguir formatos.
 */
export function listItems<T = Record<string, unknown>>(json: unknown): PaginatedRead<T> {
  if (Array.isArray(json)) {
    // Formato legacy: array en la raíz, sin paginación.
    return { items: json as T[], paginationKey: null, hasMore: false, legacyShape: true };
  }
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.items)) {
      return {
        items: o.items as T[],
        paginationKey: typeof o.pagination_key === "string" ? o.pagination_key : null,
        hasMore: o.has_more === true,
        legacyShape: false,
      };
    }
  }
  // Ni array ni objeto paginado: no se inventa una lista con contenido.
  return { items: [], paginationKey: null, hasMore: false, legacyShape: false };
}

/** ¿La respuesta es un listado legible? Distingue "vacío" de "no lo entiendo". */
export function isReadableList(json: unknown): boolean {
  if (Array.isArray(json)) return true;
  return Boolean(json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).items));
}
