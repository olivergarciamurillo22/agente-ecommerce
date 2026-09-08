// ============================================================
// PRECIO DETECTADO EN EL TEXTO DE UN ANUNCIO (08-09-2026)
//
// La Ad Library no da el precio de venta. Lo único honesto es leerlo del
// texto del anuncio cuando el anunciante lo escribe («solo 24,99 €», «desde
// 19.99€», «PVP 34,90 EUR»). El resultado se etiqueta SIEMPRE como
// «precio detectado en el anuncio»: nunca es un precio confirmado, y si el
// texto no trae ninguno, se devuelve null (no se estima).
//
// Reglas: importe en euros (€ o EUR, antes o después), entre 1 y 999,99;
// con varios precios se prefiere el que va precedido de «solo/ahora/PVP» y,
// si no, el más BAJO (lo habitual es «antes 49,99 → ahora 29,99»; el bajo es
// el de venta). Un «-30 %» o un «x2» no cuenta.
// ============================================================

export interface DetectedPriceHit {
  amount: number;
  currency: "EUR";
  /** El trozo de texto del que salió, para que se pueda comprobar. */
  quote: string;
  /** Cuántos importes distintos había: con más de uno, la elección es heurística. */
  candidates: number;
}

const NUM = "(\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const BEFORE = new RegExp(`(?:€|eur(?:os?)?)\\s*${NUM}(?![\\d%])`, "gi");
const AFTER = new RegExp(`${NUM}\\s*(?:€|eur(?:os?)?)(?![a-z])`, "gi");

function parseAmount(raw: string): number | null {
  let s = raw.trim();
  // 1.299,99 → 1299.99 · 1,299.99 → 1299.99 · 24,99 → 24.99 · 24.99 → 24.99
  if (/^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/.test(s)) {
    const dec = s.slice(-3).match(/^[.,]\d{2}$/) ? s.slice(-3) : "";
    const int = dec ? s.slice(0, -3) : s;
    s = int.replace(/[.,]/g, "") + (dec ? "." + dec.slice(1) : "");
  } else s = s.replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n >= 1000) return null;
  return Math.round(n * 100) / 100;
}

export function detectPriceInText(text: string | null | undefined): DetectedPriceHit | null {
  if (!text) return null;
  const hits: Array<{ amount: number; quote: string; preferred: boolean }> = [];
  const add = (m: RegExpExecArray, amountRaw: string) => {
    const amount = parseAmount(amountRaw);
    if (amount === null) return;
    const start = Math.max(0, m.index - 24);
    const quote = text.slice(start, m.index + m[0].length + 6).replace(/\s+/g, " ").trim();
    const preferred = /\b(solo|sólo|ahora|precio|pvp|oferta)\s*:?\s*$/i.test(text.slice(start, m.index));
    hits.push({ amount, quote, preferred });
  };
  for (const re of [BEFORE, AFTER]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) add(m, m[1]);
  }
  if (!hits.length) return null;
  const distinct = new Set(hits.map((h) => h.amount));
  const preferidos = hits.filter((h) => h.preferred);
  const pool = preferidos.length ? preferidos : hits;
  const best = pool.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { amount: best.amount, currency: "EUR", quote: best.quote, candidates: distinct.size };
}
