// ============================================================
// GATE DE PRODUCTO (10-09-2026): ¿es el MISMO producto antes de gastar?
//
// Evidencia real del 09-09 (20 candidatos auditados): con cobertura del 33–50 %
// el producto que «casa» en el catálogo casi siempre es OTRO:
//   «Peine piojos»                  → «PEINE PUA ESPECIAL CARBONO» (50 %, margen −196 %)
//   «Purificador de aire ozono»     → «Detector de calidad del aire 6 en 1» (33 %)
//   «Botella de plástico reutilizable 900ML» → «Botella Soluto Champú» (33 %, margen −57 %)
//   «Ventilador doble»              → cuenta de mini-PCs, sin relación
// y el pipeline gastaba igualmente radiografía (1–5 peticiones), España,
// minería, render_ad y vídeo en un producto que no era el candidato.
//
// Este gate va justo después del match en /products.json y ANTES de todo lo
// caro. Reglas literales (GATE_RULE), calibradas con esos casos y con los
// buenos del mismo día («SOPORTE PARA ABDOMINALES» 100 %, «Tapas de silicona»
// 100 %, «Cojín gel silla» 67 % legítimo):
//   1 · cobertura ≥ 0,6 (2 palabras: las dos; 3: al menos 2; 4: al menos 3);
//   2 · la palabra PRINCIPAL del nombre (la primera: «peine», «purificador»,
//       «botella», «ventilador») tiene que estar (exacta o por raíz);
//   3 · cobertura de las palabras ESPECÍFICAS ≥ 0,6: «aire», «digital»,
//       «plástico»… son genéricas y no cuentan («báscula de cocina digital»
//       no es «báscula digital de baño»: la específica «baño» falta);
//   4 · si el catálogo declara product_type y ese tipo no comparte raíz con
//       ninguna palabra clave, contradice: solo se tolera con cobertura ≥ 0,75.
// Solo aplica cuando SÍ hay catálogo: sin catálogo no hay nada que comparar y
// el veredicto sigue siendo no_verificable, como hasta ahora.
// ============================================================

import type { CatalogProduct } from "../audit/store";
import { tokens } from "../../product-hunter/internal/dropea-catalog";

export const GATE_MIN_COVERAGE = 0.6;
export const GATE_RULE =
  "pasa si cobertura ≥ 0,6 ∧ la palabra principal (primera del nombre) está ∧ cobertura de las palabras específicas (no genéricas) ≥ 0,6 ∧ el product_type del catálogo, si lo hay, no contradice (o cobertura ≥ 0,75)";

/** Palabras que describen cualquier cosa: no prueban que sea el mismo producto. */
export const GENERIC_PRODUCT_WORDS = new Set([
  "aire", "agua", "digital", "electrico", "electrica", "electronico", "electronica", "portatil", "inalambrico", "inalambrica", "automatico", "automatica", "manual",
  "plastico", "silicona", "acero", "inoxidable", "aluminio", "madera", "cristal", "vidrio", "tela", "algodon", "cuero", "metal", "goma",
  "mini", "doble", "triple", "grande", "pequeno", "pequena", "universal", "profesional", "multifuncion", "multifuncional", "recargable", "led", "usb", "smart", "inteligente",
  "reutilizable", "reutilizables", "ajustable", "ajustables", "plegable", "plegables", "portable", "compacto", "compacta", "ergonomico", "ergonomica", "especial", "extra", "super", "ultra", "max", "pro", "plus",
  // OJO: «cocina», «baño», «coche», «bebé»… NO son genéricas: distinguen productos (báscula de cocina ≠ báscula de baño).
  "set", "kit", "pack", "lote", "unidades", "piezas", "juego", "conjunto", "accesorio", "accesorios", "soporte", "base", "funda", "cable", "adaptador",
  "calidad", "premium", "original", "nuevo", "nueva", "moderno", "moderna", "clasico", "clasica", "elegante", "practico", "practica", "facil",
]);

export interface ProductGate {
  passed: boolean;
  applicable: boolean;
  coverage: number;
  head: string | null;
  headPresent: boolean;
  present: string[];
  missing: string[];
  specificPresent: string[];
  typeCheck: "casa" | "contradice" | "sin_tipo";
  /** Qué se buscaba y qué se encontró, para el motivo del corte. */
  searched: string;
  found: string | null;
  reason: string;
  rule: string;
}

const stem = (t: string) => (t.length > 5 ? t.slice(0, 5) : t);

/** Evalúa el gate. `match` null con catálogo = producto no encontrado → no pasa. */
export function productGate(keywords: string[], product: CatalogProduct | null, coverage: number, catalogProducts: number): ProductGate {
  const searched = keywords.join(" ");
  const base = { applicable: true, coverage, head: keywords[0] ?? null, searched, found: product?.title ?? null, rule: GATE_RULE };
  if (!catalogProducts) return { ...base, applicable: false, passed: true, headPresent: false, present: [], missing: keywords, specificPresent: [], typeCheck: "sin_tipo", reason: "sin catálogo accesible no hay nada que comparar: el gate no aplica" };
  if (!keywords.length) return { ...base, applicable: false, passed: true, headPresent: false, present: [], missing: [], specificPresent: [], typeCheck: "sin_tipo", reason: "sin palabras clave: el gate no aplica" };
  if (!product) return { ...base, passed: false, headPresent: false, present: [], missing: keywords, specificPresent: [], typeCheck: "sin_tipo", reason: `ninguno de los ${catalogProducts} productos del catálogo contiene «${searched}»: el anunciante no vende ese producto en su catálogo público` };
  const words = new Set(tokens(`${product.title} ${product.handle.replace(/-/g, " ")} ${product.productType ?? ""}`));
  const stems = new Set([...words].map(stem));
  const has = (k: string) => words.has(k) || stems.has(stem(k));
  const present = keywords.filter(has);
  const missing = keywords.filter((k) => !has(k));
  const head = keywords[0];
  const headPresent = has(head);
  const specificPresent = present.filter((k) => !GENERIC_PRODUCT_WORDS.has(k));
  // Cobertura del gate: por raíz («cojines» cuenta como «cojin»), nunca menor que la del match exacto.
  const cov = Math.max(coverage, Math.round((present.length / keywords.length) * 100) / 100);
  let typeCheck: ProductGate["typeCheck"] = "sin_tipo";
  if (product.productType && product.productType.trim()) {
    const typeStems = new Set(tokens(product.productType).map(stem));
    typeCheck = keywords.some((k) => typeStems.has(stem(k))) ? "casa" : "contradice";
  }
  const fallos: string[] = [];
  if (cov < GATE_MIN_COVERAGE) fallos.push(`cobertura ${Math.round(cov * 100)} % < 60 %`);
  if (!headPresent) fallos.push(`falta la palabra principal «${head}»`);
  const specificKeywords = keywords.filter((k) => !GENERIC_PRODUCT_WORDS.has(k));
  const specificCov = specificKeywords.length ? specificPresent.length / specificKeywords.length : 0;
  if (!specificPresent.length) fallos.push(`solo coinciden palabras genéricas (${present.join(", ") || "ninguna"})`);
  else if (specificCov < GATE_MIN_COVERAGE) fallos.push(`faltan palabras específicas: ${specificKeywords.filter((k) => !specificPresent.includes(k)).map((k) => `«${k}»`).join(", ")} (${Math.round(specificCov * 100)} % de las específicas)`);
  if (typeCheck === "contradice" && cov < 0.75) fallos.push(`el tipo del catálogo «${product.productType}» no casa con «${searched}»`);
  const passed = fallos.length === 0;
  const reason = passed
    ? `«${product.title}» casa con «${searched}»: cobertura ${Math.round(cov * 100)} %, principal «${head}» presente${typeCheck === "casa" ? `, tipo «${product.productType}» coherente` : ""}`
    : `buscaba «${searched}» y el catálogo solo ofrece «${product.title}»: ${fallos.join("; ")} → otro producto, no el candidato`;
  return { ...base, coverage: cov, passed, headPresent, present, missing, specificPresent, typeCheck, reason };
}
