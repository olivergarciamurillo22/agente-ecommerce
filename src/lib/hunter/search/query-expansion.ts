// ============================================================
// AI Winner Radar — EXPANSIÓN DE CONSULTAS.
//
// Buscar "quitapelos mascotas" y quedarse ahí es dejar fuera la mayor parte
// del mercado: las marcas anuncian en inglés, por el problema ("quitar pelo
// del sofá"), por el beneficio ("adiós a los pelos") o por el mecanismo
// ("rodillo reutilizable"). Cada ángulo encuentra anunciantes distintos.
//
// Determinista a propósito. La IA puede SUGERIR variantes (§14) pero la base
// no depende de ella: sin clave de LLM la expansión sigue funcionando, y dos
// búsquedas iguales dan las mismas consultas — que es lo que permite comparar
// resultados de una semana a otra.
// ============================================================

import { normalizeText } from "../normalize";

/** Traducciones y sinónimos del vocabulario de dropshipping en España. */
const LEXICON: Record<string, string[]> = {
  mascota: ["pet", "mascotas", "perro", "gato", "dog", "cat"],
  mascotas: ["pet", "pets", "perros", "gatos", "dog", "cat"],
  perro: ["dog", "perros", "canino", "pet"],
  gato: ["cat", "gatos", "felino", "pet"],
  pelo: ["hair", "fur", "pelos", "pelusa"],
  pelos: ["hair", "fur", "pelo"],
  quitapelos: ["hair remover", "fur remover", "quita pelos", "lint remover"],
  cepillo: ["brush", "grooming brush", "cepillos"],
  coche: ["car", "auto", "vehiculo", "automovil"],
  hogar: ["home", "casa", "household", "domestico"],
  cocina: ["kitchen", "cocinas"],
  organizador: ["organizer", "organizador", "storage", "almacenaje"],
  limpiador: ["cleaner", "cleaning", "limpieza"],
  lampara: ["lamp", "light", "luz", "led"],
  masajeador: ["massager", "masaje", "massage"],
  cortauñas: ["nail trimmer", "nail clipper", "cortauñas electrico"],
  bebe: ["baby", "bebes", "infantil"],
  jardin: ["garden", "jardineria", "outdoor"],
};

/** Plantillas por ángulo. Cada una encuentra anunciantes que las otras no. */
const ANGLE_TEMPLATES: ReadonlyArray<{ id: string; build: (base: string) => string }> = [
  { id: "base", build: (b) => b },
  { id: "problema", build: (b) => `como quitar ${b}` },
  { id: "beneficio", build: (b) => `${b} facil rapido` },
  { id: "mecanismo", build: (b) => `${b} reutilizable` },
  { id: "compra", build: (b) => `comprar ${b}` },
];

export interface ExpansionOptions {
  /** Tope de consultas. Cada una cuesta créditos: el límite es dinero. */
  maxQueries?: number;
  includeEnglish?: boolean;
  /** Variantes sugeridas por la IA, si las hubo. */
  aiSuggestions?: string[];
}

export const DEFAULT_MAX_QUERIES = 8;

/**
 * Devuelve consultas únicas y ordenadas por utilidad esperada: primero los
 * términos que dio Pedro (los que mejor conoce su nicho), después las
 * traducciones, y al final los ángulos genéricos.
 */
export function expandQueries(keywords: string[], opts: ExpansionOptions = {}): string[] {
  const max = Math.max(1, opts.maxQueries ?? DEFAULT_MAX_QUERIES);
  const includeEnglish = opts.includeEnglish !== false;
  const base = keywords.map((k) => k.trim()).filter(Boolean);
  if (base.length === 0) return [];

  const out = new Set<string>();
  const add = (q: string) => {
    const limpio = q.trim().replace(/\s+/g, " ");
    // La Ad Library corta en 100 caracteres: emitir más es tirar la consulta.
    if (limpio.length >= 3 && limpio.length <= 100) out.add(limpio);
  };

  for (const k of base) add(k);
  for (const s of opts.aiSuggestions ?? []) add(s);

  if (includeEnglish) {
    for (const k of base) {
      for (const t of translateTerm(k)) add(t);
      if (out.size >= max * 3) break;
    }
  }

  const principal = base[0];
  for (const tpl of ANGLE_TEMPLATES) {
    if (tpl.id === "base") continue;
    add(tpl.build(principal));
  }

  return [...out].slice(0, max);
}

/** Traduce/expande cada palabra conocida y recombina la frase. */
export function translateTerm(term: string): string[] {
  const palabras = normalizeText(term).split(" ").filter(Boolean);
  if (palabras.length === 0) return [];
  const opciones = palabras.map((p) => [p, ...(LEXICON[p] ?? [])]);

  const combinaciones: string[] = [];
  // Se cambia UNA palabra cada vez: sustituirlas todas a la vez produce
  // frases que no busca nadie ("pet hair remover" sí, "pet fur cepillo" no).
  for (let i = 0; i < opciones.length; i++) {
    for (const alt of opciones[i].slice(1)) {
      const copia = [...palabras];
      copia[i] = alt;
      combinaciones.push(copia.join(" "));
    }
  }
  return [...new Set(combinaciones)];
}

/** Quita consultas que solo se diferencian en el orden o en ruido. */
export function dedupeQueries(queries: string[]): string[] {
  const vistas = new Map<string, string>();
  for (const q of queries) {
    const clave = normalizeText(q).split(" ").filter(Boolean).sort().join(" ");
    if (!vistas.has(clave)) vistas.set(clave, q);
  }
  return [...vistas.values()];
}
