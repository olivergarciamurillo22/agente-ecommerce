// ============================================================
// AI Winner Radar — PLANIFICADOR DE BÚSQUEDA EN META.
//
// Traduce lo que Pedro escribe en lenguaje normal a (a) una FRASE que él
// pueda leer y corregir, (b) unos CHIPS editables y (c) la ESTRATEGIA de
// consultas que se lanzará contra la Ad Library.
//
// Por qué la frase importa tanto: la alternativa es enseñarle el JSON de
// filtros, y entonces la interfaz deja de ser un producto y pasa a ser una
// consola. Pedro tiene que poder ver «voy a buscar esto» de un vistazo y
// decir «no, eso no» antes de gastar una sola llamada.
//
// La estrategia de consultas la propone la IA cuando hay clave y la completa
// SIEMPRE la expansión determinista. Sin clave el radar busca igual: peor
// vocabulario, mismo circuito.
// ============================================================

import { ask, extractJson, llmConfigured, stringList } from "../llm";
import type { HunterFilters } from "../types";
import { dedupeQueries, expandQueries } from "./query-expansion";

export interface SearchPlan {
  filters: HunterFilters;
  /** Las consultas que se lanzarán, en el orden en que se lanzarán. */
  queries: string[];
  /** Frase legible: lo que se va a buscar, sin una llave ni un corchete. */
  sentence: string;
  /** Chips editables que resumen los criterios. */
  chips: PlanChip[];
  /** Por qué esas consultas (§31: «Ver estrategia»). */
  strategy: string[];
  aiUsed: boolean;
  notes: string[];
}

export interface PlanChip {
  /** Campo de `HunterFilters` al que corresponde: quitarlo lo pone a null. */
  field: keyof HunterFilters;
  label: string;
  /** Índice cuando el campo es una lista (keywords, categorías…). */
  index?: number;
}

const STRATEGY_PROMPT = `Eres un analista que busca productos ganadores de dropshipping en la Biblioteca de Anuncios de Meta.
Te dan un nicho y unos criterios. Devuelve SOLO un JSON:
{"queries":["8-14 búsquedas cortas"],"strategy":["3-5 frases explicando por qué esas búsquedas"]}

Reglas para "queries":
- Mezcla español e inglés: muchas marcas que venden en España anuncian en inglés.
- Cubre ÁNGULOS distintos: nombre del producto, el problema que resuelve, el beneficio, el mecanismo.
- Términos que un anunciante pondría en su anuncio, no jerga de analista.
- Máximo 100 caracteres cada una. Sin comillas, sin operadores booleanos.
- Nada de marcas registradas concretas.
Responde solo el JSON.`;

/**
 * Construye el plan completo. `interpret` ya dejó los filtros; aquí se
 * decide QUÉ se pregunta y se redacta lo que Pedro va a leer.
 */
export async function buildSearchPlan(
  filters: HunterFilters,
  opts: {
    prompt?: string | null;
    aiSuggestions?: string[];
    maxQueries?: number;
    notes?: string[];
    /**
     * Salta la llamada al modelo capaz. Lo usa la VISTA PREVIA mientras Pedro
     * escribe: la frase y los chips se construyen con código, así que se ven
     * igual, y no se paga una llamada por cada pausa al teclear.
     */
    skipStrategy?: boolean;
  } = {}
): Promise<SearchPlan> {
  let sugeridas = opts.aiSuggestions ?? [];
  let strategy: string[] = [];
  let aiUsed = false;

  if (!opts.skipStrategy && llmConfigured() && filters.keywords.length > 0) {
    const datos = [
      `Nicho: ${filters.keywords.join(", ")}`,
      filters.categories.length ? `Categorías: ${filters.categories.join(", ")}` : null,
      `País: ${filters.country}`,
      filters.priceMin !== null || filters.priceMax !== null
        ? `Precio de venta objetivo: ${filters.priceMin ?? "?"}-${filters.priceMax ?? "?"} €`
        : null,
      opts.prompt ? `Petición original: ${opts.prompt.slice(0, 400)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const json = extractJson(await ask(STRATEGY_PROMPT, datos, { tier: "deep", maxTokens: 700, json: true }));
    if (json) {
      const q = stringList(json.queries, 14, 100);
      if (q.length > 0) {
        sugeridas = [...sugeridas, ...q];
        aiUsed = true;
      }
      strategy = stringList(json.strategy, 5, 200);
    }
  }

  // La expansión determinista SIEMPRE corre: garantiza que haya consultas
  // aunque la IA no conteste, y aporta ángulos que el modelo suele olvidar.
  const queries = dedupeQueries(
    expandQueries(filters.keywords, { maxQueries: opts.maxQueries, aiSuggestions: sugeridas })
  );

  if (strategy.length === 0 && queries.length > 0) {
    strategy = [
      `Se lanzan ${queries.length} búsquedas sobre la Biblioteca de Anuncios de Meta en ${filters.country}.`,
      "Cada una cubre un ángulo distinto (nombre, problema, beneficio, mecanismo) porque cada ángulo encuentra anunciantes que los otros no.",
      "Se incluyen términos en inglés: parte de las marcas que venden en España anuncian en ese idioma.",
    ];
  }

  return {
    filters,
    queries,
    sentence: describeFilters(filters),
    chips: chipsFor(filters),
    strategy,
    aiUsed,
    notes: opts.notes ?? [],
  };
}

const PAIS_NOMBRE: Record<string, string> = {
  ES: "España", PT: "Portugal", FR: "Francia", IT: "Italia", DE: "Alemania",
  NL: "Países Bajos", BE: "Bélgica", IE: "Irlanda", GB: "Reino Unido",
};

const CATEGORIA_NOMBRE: Record<string, string> = {
  hogar: "hogar", mascotas: "mascotas", coche: "coche", cocina: "cocina",
  belleza: "belleza", jardin: "jardín", bebe: "bebé", deporte: "deporte", salud: "salud",
};

/**
 * La frase de §5. Se construye con CÓDIGO, no con IA: es lo que Pedro usa
 * para decidir si la búsqueda es la que quería, y no puede depender de que un
 * modelo redacte bien ni de que esté configurado.
 */
export function describeFilters(f: HunterFilters): string {
  const partes: string[] = [];

  const que = f.categories.length > 0
    ? `productos de ${f.categories.map((c) => CATEGORIA_NOMBRE[c] ?? c).join(" y ")}`
    : f.keywords.length > 0
      ? `productos relacionados con ${f.keywords.slice(0, 3).join(", ")}`
      : "productos";
  partes.push(`Buscaremos ${que}`);
  partes.push(`en ${PAIS_NOMBRE[f.country] ?? f.country}`);

  if (f.priceMin !== null && f.priceMax !== null) partes.push(`entre ${fmt(f.priceMin)} y ${fmt(f.priceMax)} €`);
  else if (f.priceMax !== null) partes.push(`por debajo de ${fmt(f.priceMax)} €`);
  else if (f.priceMin !== null) partes.push(`por encima de ${fmt(f.priceMin)} €`);

  if (f.supplierCostMax !== null) partes.push(`con coste de proveedor bajo ${fmt(f.supplierCostMax)} €`);

  const rasgos: string[] = [];
  if (f.demoability !== null && f.demoability >= 60) rasgos.push("fáciles de demostrar");
  if (f.fragile === false) rasgos.push("no frágiles");
  if (f.requiresSizing === false) rasgos.push("sin tallas");
  if (f.electronics === false) rasgos.push("sin electrónica complicada");
  if (f.evergreen === true) rasgos.push("que se vendan todo el año");
  if (rasgos.length > 0) partes.push(rasgos.join(", "));

  const mercado: string[] = [];
  if (f.momentumMin !== null && f.momentumMin >= 60) mercado.push("con tendencia al alza");
  if (f.saturationMax !== null) mercado.push(f.saturationMax <= 45 ? "con saturación baja" : "con saturación baja o media");
  if (f.minDaysActive !== null) mercado.push(`con anuncios activos desde hace ${f.minDaysActive} días o más`);
  if (mercado.length > 0) partes.push(mercado.join(" y "));

  return `${partes.join(", ")}.`.replace(/,\s*\./, ".");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

/**
 * Chips editables. Cada uno sabe qué campo borra al quitarlo, para que la
 * interfaz no tenga que adivinarlo con un `switch` propio.
 */
export function chipsFor(f: HunterFilters): PlanChip[] {
  const out: PlanChip[] = [];
  out.push({ field: "country", label: PAIS_NOMBRE[f.country] ?? f.country });
  f.categories.forEach((c, i) => out.push({ field: "categories", label: CATEGORIA_NOMBRE[c] ?? c, index: i }));
  f.keywords.forEach((k, i) => out.push({ field: "keywords", label: k, index: i }));

  if (f.priceMin !== null || f.priceMax !== null) {
    out.push({
      field: f.priceMax !== null ? "priceMax" : "priceMin",
      label: f.priceMin !== null && f.priceMax !== null
        ? `${fmt(f.priceMin)}–${fmt(f.priceMax)} €`
        : f.priceMax !== null ? `hasta ${fmt(f.priceMax)} €` : `desde ${fmt(f.priceMin as number)} €`,
    });
  }
  if (f.supplierCostMax !== null) out.push({ field: "supplierCostMax", label: `coste < ${fmt(f.supplierCostMax)} €` });
  if (f.minDaysActive !== null) out.push({ field: "minDaysActive", label: `${f.minDaysActive}+ días activo` });
  if (f.saturationMax !== null) out.push({ field: "saturationMax", label: f.saturationMax <= 45 ? "saturación baja" : "saturación media" });
  if (f.momentumMin !== null) out.push({ field: "momentumMin", label: "en crecimiento" });
  if (f.fragile === false) out.push({ field: "fragile", label: "no frágil" });
  if (f.requiresSizing === false) out.push({ field: "requiresSizing", label: "sin tallas" });
  if (f.electronics === false) out.push({ field: "electronics", label: "sin electrónica" });
  if (f.evergreen === true) out.push({ field: "evergreen", label: "todo el año" });
  if (f.demoability !== null) out.push({ field: "demoability", label: "fácil de demostrar" });
  f.excludeKeywords.forEach((k, i) => out.push({ field: "excludeKeywords", label: `sin ${k}`, index: i }));
  return out;
}
