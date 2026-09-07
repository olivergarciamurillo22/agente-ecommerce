// ============================================================
// EXPANSIÓN DE UNA PALABRA A UNA BATERÍA DE BÚSQUEDAS (07-09-2026)
// docs/HUNTER-BUSCADOR.md
//
// El usuario escribe "organizador cocina" y el motor tiene que buscar de
// verdad: variantes morfológicas, modificadores de intención de compra,
// sinónimos y el inglés. Quince minutos de presupuesto se gastan en amplitud,
// no en repetir la misma consulta.
//
// DETERMINISTA A PROPÓSITO. Nada de sinónimos inventados por un modelo: la
// misma palabra produce siempre la misma batería, y cada término dice DE DÓNDE
// sale. Los sinónimos y las traducciones viven en
// `config/hunter-expansion.json`, que Pedro puede ampliar sin desplegar; lo que
// no esté ahí, no se inventa.
// ============================================================

import fs from "node:fs";
import path from "node:path";

export type TermOrigin = "semilla" | "variante" | "sinonimo" | "modificador" | "ingles";

export interface ExpandedTerm {
  term: string;
  origin: TermOrigin;
  /** Qué regla o entrada de configuración lo produjo. */
  why: string;
}

export interface ExpansionLexicon {
  /** palabra → sinónimos en español. */
  sinonimos: Record<string, string[]>;
  /** palabra → equivalentes en inglés. */
  traducciones: Record<string, string[]>;
  /** Sufijos/prefijos de intención de compra. `{}` marca el hueco del término. */
  modificadores: string[];
}

export const DEFAULT_MODIFIERS = ["comprar {}", "{} barato", "{} oferta", "{} original", "{} envio gratis"];

const EMPTY: ExpansionLexicon = { sinonimos: {}, traducciones: {}, modificadores: DEFAULT_MODIFIERS };

let cache: { file: string; mtimeMs: number; lexicon: ExpansionLexicon } | null = null;

export function expansionLexiconPath(): string {
  return path.resolve(process.cwd(), "config", "hunter-expansion.json");
}

/** Carga el diccionario curado. Sin fichero → solo variantes y modificadores. */
export function loadExpansionLexicon(file = expansionLexiconPath()): ExpansionLexicon {
  try {
    const stat = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.lexicon;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ExpansionLexicon>;
    const lexicon: ExpansionLexicon = {
      sinonimos: raw.sinonimos && typeof raw.sinonimos === "object" ? raw.sinonimos : {},
      traducciones: raw.traducciones && typeof raw.traducciones === "object" ? raw.traducciones : {},
      modificadores: Array.isArray(raw.modificadores) && raw.modificadores.length ? raw.modificadores : DEFAULT_MODIFIERS,
    };
    cache = { file, mtimeMs: stat.mtimeMs, lexicon };
    return lexicon;
  } catch {
    return EMPTY;
  }
}

const sinAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const limpio = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Plural español razonable: casa→casas, papel→papeles, luz→luces. */
export function pluralEs(word: string): string | null {
  if (!word || word.length < 3) return null;
  if (/[aeiouáéíóú]$/.test(word)) return `${word}s`;
  if (/z$/.test(word)) return `${word.slice(0, -1)}ces`;
  if (/[lrndjsxy]$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Singular aproximado: el inverso prudente del anterior. */
export function singularEs(word: string): string | null {
  if (word.length < 4) return null;
  if (/ces$/.test(word)) return `${word.slice(0, -3)}z`;
  if (/es$/.test(word) && /[lrndjsxy]es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return null;
}

/**
 * Expande una palabra o frase corta. El orden importa: lo más probable
 * primero, porque el presupuesto puede cortar por la mitad.
 */
export function expandSearchTerm(
  seed: string,
  opts: { max?: number; lexicon?: ExpansionLexicon } = {}
): ExpandedTerm[] {
  const lexicon = opts.lexicon ?? loadExpansionLexicon();
  const max = opts.max ?? 24;
  const base = limpio(seed);
  if (!base) return [];
  const palabras = base.split(" ");
  const ultima = palabras[palabras.length - 1];
  const salida: ExpandedTerm[] = [];
  const vistos = new Set<string>();
  const add = (term: string, origin: TermOrigin, why: string) => {
    const t = limpio(term);
    if (!t || vistos.has(t)) return;
    vistos.add(t);
    salida.push({ term: t, origin, why });
  };

  add(base, "semilla", "lo que escribió el usuario");

  // 1 · Sinónimos curados (de la palabra completa o de su última palabra).
  for (const clave of [base, ultima]) {
    for (const sin of lexicon.sinonimos[clave] ?? []) {
      const term = clave === base ? sin : [...palabras.slice(0, -1), sin].join(" ");
      add(term, "sinonimo", `sinónimo curado de "${clave}" (config/hunter-expansion.json)`);
    }
  }

  // 2 · Variantes morfológicas de la última palabra.
  const plural = pluralEs(ultima);
  if (plural && plural !== ultima) add([...palabras.slice(0, -1), plural].join(" "), "variante", "plural");
  const singular = singularEs(ultima);
  if (singular && singular !== ultima) add([...palabras.slice(0, -1), singular].join(" "), "variante", "singular");
  if (sinAcentos(base) !== base) add(sinAcentos(base), "variante", "sin acentos");

  // 3 · Traducciones curadas al inglés (mucha competencia anuncia en inglés).
  for (const clave of [base, ultima]) {
    for (const en of lexicon.traducciones[clave] ?? []) {
      const term = clave === base ? en : [...palabras.slice(0, -1), en].join(" ");
      add(term, "ingles", `traducción curada de "${clave}" (config/hunter-expansion.json)`);
    }
  }

  // 4 · Modificadores de intención de compra sobre la semilla.
  for (const patron of lexicon.modificadores) {
    add(patron.replace("{}", base), "modificador", `patrón "${patron}"`);
  }

  return salida.slice(0, max);
}
