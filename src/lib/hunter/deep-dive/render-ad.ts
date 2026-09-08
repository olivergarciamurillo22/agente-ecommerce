// ============================================================
// NIVEL 2 · «render_ad» de la Ad Library (09-09-2026) — docs/HUNTER-DEEP-DIVE.md
//
// La API pública /ads_archive NO devuelve la URL de destino del anuncio ni el
// creativo: solo textos, fechas, page_id y `ad_snapshot_url`. Ese
// `ad_snapshot_url` (…/ads/archive/render_ad/?id=…&access_token=…) es la
// vía OFICIAL de Meta para ver el anuncio renderizado, y exige el token en
// la query. Aquí se reconstruye EN MEMORIA con el token del entorno (nunca
// se persiste: el fix de seguridad del 08-09 lo recorta al normalizar) y se
// parsea el HTML que devuelve para sacar:
//   · enlaces salientes (l.facebook.com/l.php?u=<destino>) → la tienda;
//   · imágenes (scontent…fbcdn.net) y vídeos (video…fbcdn.net / .mp4);
//   · si lo que llegó es un muro de login o un desafío anti-bot.
//
// La ficha pública sin token (facebook.com/ads/library/?id=…) devuelve un
// 403 con desafío JavaScript a cualquier petición automatizada (comprobado
// el 09-09): NO se usa ni se esquiva. Si render_ad tampoco sirve el dato, el
// candidato queda «tienda no localizable automáticamente».
// ============================================================

export const DEEP_DIVE_USER_AGENT = "Casamable-Hunter-DeepDive/1.0 (+https://casamable.com/contacto)";

export function renderAdUrl(adId: string, token: string): string {
  return `https://www.facebook.com/ads/archive/render_ad/?id=${encodeURIComponent(adId)}&access_token=${encodeURIComponent(token)}`;
}

export interface RenderAdParse {
  /** HTML con forma de login o de desafío anti-bot: no hay anuncio dentro. */
  blocked: "login" | "challenge" | null;
  /** Destinos decodificados de los enlaces salientes (l.facebook.com/l.php?u=…), sin repetir. */
  outboundUrls: string[];
  /** Hosts de esos destinos, sin www., sin repetir. */
  outboundHosts: string[];
  imageUrls: string[];
  videoUrls: string[];
  /** Texto visible (sin scripts ni etiquetas), recortado, para el informe. */
  visibleText: string;
  bytes: number;
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\\\//g, "/");

/** Hosts que no son la tienda del anunciante: Meta y trackers de Meta. */
const META_HOSTS = /(^|\.)(facebook\.com|fb\.com|fbcdn\.net|instagram\.com|messenger\.com|whatsapp\.com|fb\.me|meta\.com)$/i;

export function parseRenderAdHtml(html: string): RenderAdParse {
  const h = html ?? "";
  const blocked: RenderAdParse["blocked"] = /executeChallenge|challenge-platform|cf-challenge/i.test(h) && h.length < 20_000
    ? "challenge"
    : /login_form|Log in to Facebook|Iniciar sesión en Facebook|\/login\/\?next=/i.test(h) && !/render_ad|ad_snapshot|adlibrary/i.test(h.slice(0, 5000))
      ? "login"
      : null;

  const outbound = new Set<string>();
  const lRe = /l\.facebook\.com\/l\.php\?[^"'\s<>]*?u=([^&"'\s<>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = lRe.exec(h)) !== null) {
    try {
      const u = decodeURIComponent(decodeEntities(m[1]));
      if (/^https?:\/\//i.test(u)) outbound.add(u.slice(0, 2048));
    } catch { /* URL mal codificada: se ignora */ }
  }
  // Enlaces directos a hosts que no son de Meta (algunos snapshots los traen sin l.php).
  const hrefRe = /href=["']([^"']+)["']/gi;
  while ((m = hrefRe.exec(h)) !== null) {
    const u = decodeEntities(m[1]);
    if (!/^https?:\/\//i.test(u)) continue;
    try { if (!META_HOSTS.test(new URL(u).hostname)) outbound.add(u.slice(0, 2048)); } catch { /* ignorar */ }
  }
  const outboundUrls = [...outbound];
  const outboundHosts = [...new Set(outboundUrls.map((u) => { try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } }).filter(Boolean))];

  const imgs = new Set<string>();
  const imgRe = /https?:\/\/[a-z0-9.-]*fbcdn\.net\/[^"'\s<>\\]+\.(?:jpg|jpeg|png|webp)[^"'\s<>\\]*/gi;
  while ((m = imgRe.exec(h)) !== null) imgs.add(decodeEntities(m[0]).slice(0, 2048));
  const vids = new Set<string>();
  const vidRe = /https?:\/\/[a-z0-9.-]*fbcdn\.net\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/gi;
  while ((m = vidRe.exec(h)) !== null) vids.add(decodeEntities(m[0]).slice(0, 2048));

  const visibleText = h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
  return { blocked, outboundUrls, outboundHosts, imageUrls: [...imgs], videoUrls: [...vids], visibleText, bytes: h.length };
}

/** El token NUNCA sale en logs ni informes: cualquier URL con access_token se recorta. */
export function redactToken(s: string): string {
  return s.replace(/access_token=[^&"'\s]+/gi, "access_token=[oculto]");
}
