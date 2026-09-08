// ============================================================
// PRECIO DETECTADO EN EL TEXTO DE UN ANUNCIO (08-09-2026)
//
// La Ad Library no da el precio de venta. Lo único honesto es leerlo del
// texto del anuncio cuando el anunciante lo escribe («solo 24,99 €», «desde
// 19.99€», «PVP 34,90 EUR»). El resultado se etiqueta SIEMPRE como
// «precio detectado en el anuncio»: nunca es un precio confirmado, y si el
// texto no trae ninguno, se devuelve null (no se estima).
//
// QUÉ RECONOCE (probado en tests con frases de anuncios españoles):
//   · importe con € o EUR/euros, antes o después: «29,99 €», «€29.99»,
//     «29€», «29'99€», «29€99», «29,99 euros», «19.99 EUR»;
//   · miles con punto o coma: «1.299,00 €» (y se descarta: ≥ 1.000 no es
//     un producto COD de este negocio);
//   · rangos y «desde»: «desde 19,99 €» → 19,99 (el mínimo, y se marca);
//   · rebajas «antes 49,99 → ahora 29,99»: se prefiere el precedido de
//     solo/ahora/PVP/precio/oferta; si no, el más BAJO;
//   · «sin IVA» / «+ IVA» junto al importe: se detecta y se marca
//     vat="excl"; el importe NO se ajusta (no se inventa el 21 %).
// QUÉ IGNORA A PROPÓSITO (no son el precio del producto):
//   · «envío 4,99 €», «gastos de envío», «ahorra 20 €», «descuento de 10 €»,
//     «cupón de 5 €», «valorado en 40 €», «-30 %», «x2», «2x1».
// DÓNDE FALLA, Y SE DICE (limitaciones documentadas, no se adivina):
//   · «3 unidades por 24,99 €» → 24,99 es el precio del PACK, no de la
//     unidad; se devuelve tal cual con unitAmbiguous=true;
//   · «2x1», «3x2»: no llevan importe, no se detecta nada;
//   · otras monedas ($, £) no se reconocen (esto es COD en España);
//   · «desde 19,99 €» puede ser el precio de la variante más barata.
// ============================================================

export interface DetectedPriceHit {
  amount: number;
  currency: "EUR";
  /** El trozo de texto del que salió, para que se pueda comprobar. */
  quote: string;
  /** Cuántos importes distintos había: con más de uno, la elección es heurística. */
  candidates: number;
  /** «sin IVA» / «+ IVA» junto al importe: el precio final al cliente es mayor. No se ajusta. */
  vat: "incl" | "excl" | "unknown";
  /** «desde X €»: puede ser la variante más barata. */
  isFrom: boolean;
  /** «N unidades por X €» / «pack de N a X €»: X es el precio del lote, no de la unidad. */
  unitAmbiguous: boolean;
}

const NUM = "(\\d{1,3}(?:[.,]\\d{3})+(?:[.,']\\d{1,2})?|\\d+(?:[.,']\\d{1,2})?)";
const CUR = "(?:€|eur(?:os?)?)";
const BEFORE = new RegExp(`${CUR}\\s*${NUM}(?![\\d%])`, "gi");
const AFTER = new RegExp(`${NUM}\\s*${CUR}(?![a-z])`, "gi");
/** «29€99»: el símbolo hace de coma decimal (formato francés, se ve en anuncios). */
const MIDDLE = /(\d{1,3})€(\d{2})(?!\d)/g;

/** Lo que va justo ANTES del importe y lo descalifica como precio del producto. */
const NEGATIVE_BEFORE = /\b(env[ií]o|envios?|gastos(?:\s+de\s+env[ií]o)?|ahorra[sr]?|ahorro|descuento(?:\s+de)?|cup[oó]n(?:\s+de)?|vale(?:\s+de)?|regalo(?:\s+de)?|valorad[oa]s?\s+en|de\s+regalo|te\s+regalamos)\s*(?:de\s*|:\s*)?$/i;
const PREFERRED_BEFORE = /\b(solo|sólo|ahora|precio|pvp|oferta|por\s+solo|por\s+sólo)\s*:?\s*$/i;
const FROM_BEFORE = /\b(desde|a\s+partir\s+de)\s*$/i;
const PACK_BEFORE = /\b(\d+)\s*(?:uds?|unidades|piezas|pcs|packs?|botes|cajas)?\s*(?:por|a|x)\s*(?:solo\s+|sólo\s+)?$/i;
const VAT_EXCL_AFTER = /^\s*(?:\+\s*iva|sin\s+iva|iva\s+no\s+incluido|\(?\s*iva\s+aparte)/i;
const VAT_INCL_AFTER = /^\s*(?:iva\s+incl(?:uido|\.)?|con\s+iva|\(?\s*iva\s+incluido)/i;

function parseAmount(raw: string): number | null {
  let s = raw.trim().replace("'", ",");
  // 1.299,99 → 1299.99 · 1,299.99 → 1299.99 · 24,99 → 24.99 · 24.99 → 24.99
  if (/^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/.test(s)) {
    const dec = /[.,]\d{2}$/.test(s) && !/[.,]\d{3}$/.test(s) ? s.slice(-3) : "";
    const int = dec ? s.slice(0, -3) : s;
    s = int.replace(/[.,]/g, "") + (dec ? "." + dec.slice(1) : "");
  } else s = s.replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n >= 1000) return null;
  return Math.round(n * 100) / 100;
}

export function detectPriceInText(text: string | null | undefined): DetectedPriceHit | null {
  if (!text) return null;
  const hits: Array<{ amount: number; quote: string; preferred: boolean; vat: DetectedPriceHit["vat"]; isFrom: boolean; unitAmbiguous: boolean }> = [];
  const seen = new Set<number>();
  const add = (m: RegExpExecArray, amountRaw: string) => {
    const amount = parseAmount(amountRaw);
    if (amount === null) return;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (NEGATIVE_BEFORE.test(before)) return; // envío, ahorro, descuento…: no es el precio
    if (seen.has(m.index)) return;
    seen.add(m.index);
    const start = Math.max(0, m.index - 24);
    const quote = text.slice(start, m.index + m[0].length + 8).replace(/\s+/g, " ").trim();
    const vat: DetectedPriceHit["vat"] = VAT_EXCL_AFTER.test(after) ? "excl" : VAT_INCL_AFTER.test(after) ? "incl" : "unknown";
    hits.push({ amount, quote, preferred: PREFERRED_BEFORE.test(before), vat, isFrom: FROM_BEFORE.test(before), unitAmbiguous: PACK_BEFORE.test(before) });
  };
  // «29€99»: el símbolo hace de coma decimal. Se toma entero y se marca la
  // zona para que BEFORE/AFTER no cuenten además «29€» y «€99».
  const middleZones: Array<[number, number]> = [];
  MIDDLE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = MIDDLE.exec(text)) !== null) { middleZones.push([mm.index, mm.index + mm[0].length]); add(mm, `${mm[1]},${mm[2]}`); }
  const inMiddle = (i: number) => middleZones.some(([a, b]) => i >= a && i < b);
  for (const re of [BEFORE, AFTER]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) { if (!inMiddle(m.index)) add(m, m[1]); }
  }
  if (!hits.length) return null;
  const distinct = new Set(hits.map((h) => h.amount));
  const preferidos = hits.filter((h) => h.preferred);
  const pool = preferidos.length ? preferidos : hits;
  const best = pool.reduce((a, b) => (b.amount < a.amount ? b : a));
  return { amount: best.amount, currency: "EUR", quote: best.quote, candidates: distinct.size, vat: best.vat, isFrom: best.isFrom, unitAmbiguous: best.unitAmbiguous };
}
