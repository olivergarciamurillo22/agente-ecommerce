// ============================================================
// AI Winner Radar — ENLACES PÚBLICOS Y NORMALIZACIÓN DE DOMINIO.
//
// Este fichero existe por una razón concreta: NO IMPORTA NADA. Ni la base de
// datos, ni el cliente HTTP, ni un SDK.
//
// El veredicto y las tarjetas necesitan construir enlaces a la Biblioteca de
// Anuncios, y esas dos cosas se ejecutan en el NAVEGADOR. Si estas funciones
// vivieran en el proveedor de Meta —que importa `http.ts`, que importa
// `db.ts`— el paquete del cliente acabaría arrastrando better-sqlite3.
//
// Ninguna de estas URLs lleva token: son las públicas de Meta, las mismas que
// se abren desde el navegador sin haber iniciado sesión.
// ============================================================

/**
 * Enlace de búsqueda en la Biblioteca de Anuncios, para ver los anuncios de
 * verdad en Meta con un clic.
 */
export function adLibrarySearchUrl(term: string, country = "ES"): string {
  const p = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: country.toUpperCase(),
    q: term.slice(0, 100),
    search_type: "keyword_unordered",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

/** Todos los anuncios de una página concreta. */
export function adLibraryPageUrl(pageId: string, country = "ES"): string {
  const p = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: country.toUpperCase(),
    view_all_page_id: pageId,
  });
  return `https://www.facebook.com/ads/library/?${p.toString()}`;
}

export function normalizeDomain(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  try {
    const url = new URL(t.includes("://") ? t : `https://${t}`);
    const host = url.hostname.replace(/^www\./, "");
    // Un caption puede ser texto suelto («Compra ya»): sin punto no es dominio.
    return host.includes(".") && !host.includes(" ") ? host : null;
  } catch {
    return null;
  }
}

/**
 * `ad_creative_link_captions` trae lo que el anuncio ENSEÑA como destino:
 * normalmente el dominio («casamable.es»). Se normaliza a host limpio.
 */
export function captionDomain(value: unknown): string | null {
  const lista = Array.isArray(value) ? value : [];
  for (const v of lista) {
    if (typeof v !== "string") continue;
    const dominio = normalizeDomain(v);
    if (dominio) return dominio;
  }
  return null;
}
