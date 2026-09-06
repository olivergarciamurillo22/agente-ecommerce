// ============================================================
// AI Winner Radar — LA CAPA DE IA.
//
// El cliente de modelo vive en `llm.ts` (dos velocidades, dos proveedores y
// UN cortafuegos de privacidad). Aquí solo están los trabajos concretos:
// interpretar lo que Pedro escribe, clasificar un producto y redactar por qué
// destaca.
//
// TRES REGLAS QUE NO SE NEGOCIAN:
//
// 1. LA IA NO CALCULA DINERO. Ni margen, ni CPA, ni beneficio, ni break-even.
//    Eso es determinista y vive en el motor financiero. Un modelo que "casi"
//    multiplica bien es la peor herramienta posible para decidir compras.
//
// 2. A LA IA NO LE LLEGA NI UN DATO PERSONAL. Solo texto público (copy de
//    anuncios, nombres de producto) y agregados. `assertNoPII` lo comprueba
//    antes de cada envío y lanza si algo se cuela.
//
// 3. SIN CLAVE, EL RADAR SIGUE FUNCIONANDO. Todo lo de aquí tiene camino
//    determinista de respaldo. La IA mejora la lectura; no la sostiene.
// ============================================================

import { clampScore } from "./provenance";
import { ask, assertNoPII, extractJson, llmBackend, llmConfigured, PIILeakError, stringList } from "./llm";
import {
  PRODUCT_FEATURE_KEYS,
  type HunterFilters,
  type OpportunitySummary,
  type ProductFeature,
  type ProductFeatureKey,
  type ProductOpportunity,
} from "./types";
import { defaultFilters } from "./search/filters";

// Se re-exportan para no obligar a cada llamador a saber que el cliente se
// mudó de fichero. `llm.ts` es la implementación; esto, la puerta de siempre.
export { assertNoPII, extractJson, llmBackend, llmConfigured, PIILeakError };

// ------------------------------------------------------------
// 1 · Interpretar lo que Pedro escribe en lenguaje natural
// ------------------------------------------------------------

export interface IntentResult {
  filters: HunterFilters;
  /** Consultas sugeridas por la IA, si las hubo. */
  suggestedQueries: string[];
  /** true si lo interpretó el modelo; false si fue el analizador determinista. */
  aiUsed: boolean;
  notes: string[];
}

const INTENT_PROMPT = `Eres un analista de producto para una tienda española de contrareembolso.
Convierte la descripción en JSON con EXACTAMENTE estas claves (usa null si no se menciona):
{"country":"ES","keywords":[],"excludeKeywords":[],"categories":[],"priceMin":null,"priceMax":null,
"supplierCostMax":null,"minDaysActive":null,"minAdvertisers":null,"saturationMax":null,
"fragile":null,"requiresSizing":null,"electronics":null,"evergreen":null,"suggestedQueries":[]}
Reglas: precios en euros como número; "sin tallas" => requiresSizing:false;
"no frágil" => fragile:false; saturación baja => saturationMax:40, media => 70.
suggestedQueries: hasta 6 búsquedas cortas en español o inglés.
Responde SOLO el JSON.

Descripción: `;

export async function interpretSearchIntent(prompt: string): Promise<IntentResult> {
  const deterministic = parseIntentDeterministic(prompt);
  const raw = await ask(INTENT_PROMPT, prompt, { tier: "fast", maxTokens: 600, json: true });
  const json = extractJson(raw);
  if (!json) return { ...deterministic, aiUsed: false };

  // Se PARTE del análisis determinista y la IA solo rellena huecos. Si el
  // modelo alucina un país o un precio, no puede pisar lo que Pedro escribió
  // de forma inequívoca.
  const f = { ...deterministic.filters };
  const num = (k: string): number | null => {
    const v = json[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const bool = (k: string): boolean | null => (typeof json[k] === "boolean" ? (json[k] as boolean) : null);
  const arr = (k: string): string[] =>
    Array.isArray(json[k]) ? (json[k] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

  if (typeof json.country === "string" && /^[A-Za-z]{2}$/.test(json.country)) f.country = json.country.toUpperCase();
  if (f.keywords.length === 0) f.keywords = arr("keywords");
  if (f.excludeKeywords.length === 0) f.excludeKeywords = arr("excludeKeywords");
  if (f.categories.length === 0) f.categories = arr("categories");
  f.priceMin ??= num("priceMin");
  f.priceMax ??= num("priceMax");
  f.supplierCostMax ??= num("supplierCostMax");
  f.minDaysActive ??= num("minDaysActive");
  f.minAdvertisers ??= num("minAdvertisers");
  f.saturationMax ??= num("saturationMax");
  f.fragile ??= bool("fragile");
  f.requiresSizing ??= bool("requiresSizing");
  f.electronics ??= bool("electronics");
  f.evergreen ??= bool("evergreen");

  return {
    filters: f,
    suggestedQueries: stringList(json.suggestedQueries, 8, 80),
    aiUsed: true,
    notes: deterministic.notes,
  };
}

/**
 * Analizador SIN IA. Cubre lo que Pedro escribe de verdad ("España, COD,
 * 25-55 €, coste <12 €, sin tallas, no frágil"). Existe para que el módulo
 * funcione sin clave de modelo y para que la IA nunca pueda contradecir algo
 * que estaba escrito con todas las letras.
 */
export function parseIntentDeterministic(prompt: string): IntentResult {
  const f = defaultFilters();
  const notes: string[] = [];
  const t = prompt.toLowerCase();

  const paises: Array<[RegExp, string]> = [
    [/\bespañ/i, "ES"], [/\bportug/i, "PT"], [/\bfranc/i, "FR"],
    [/\bitali/i, "IT"], [/\baleman/i, "DE"],
  ];
  for (const [re, code] of paises) if (re.test(t)) { f.country = code; break; }

  // Rango "25-55 €" o "entre 30 y 50".
  const rango = t.match(/(\d+(?:[.,]\d+)?)\s*(?:-|–|a|y|hasta)\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros)/);
  if (rango) {
    f.priceMin = parseFloat(rango[1].replace(",", "."));
    f.priceMax = parseFloat(rango[2].replace(",", "."));
  }
  // Coste de proveedor "coste < 12 €" / "coste menor de 10".
  const coste = t.match(/cost[eo][^.]{0,24}?(?:<|menor(?:\s+(?:de|a|que))?|maximo|max|por debajo de)\s*(\d+(?:[.,]\d+)?)/);
  if (coste) f.supplierCostMax = parseFloat(coste[1].replace(",", "."));

  const dias = t.match(/(\d+)\s*d[ií]as?\s+(?:con\s+)?(?:anuncios?\s+)?activos?/);
  if (dias) f.minDaysActive = parseInt(dias[1], 10);

  if (/sin tallas?|no.{0,8}tallas?/.test(t)) f.requiresSizing = false;
  if (/no fr[áa]gil|nada fr[áa]gil|que no se rompa/.test(t)) f.fragile = false;
  if (/sin electr[óo]nica|no electr[óo]nic/.test(t)) f.electronics = false;
  if (/todo el año|evergreen|no estacional/.test(t)) f.evergreen = true;
  if (/saturaci[óo]n\s+(?:media|moderada)/.test(t)) f.saturationMax = 70;
  else if (/saturaci[óo]n\s+baja|poca competencia|early|temprano/.test(t)) f.saturationMax = 40;

  const CATS = ["hogar", "mascotas", "coche", "cocina", "belleza", "jardin", "bebe", "deporte", "salud"];
  f.categories = CATS.filter((c) => t.includes(c));

  // Se BORRAN del texto los trozos que ya se han interpretado como
  // restricciones antes de sacar palabras clave. Si no, "coste proveedor
  // menor de 12 €" deja sueltas "proveedor" y "menor", que acaban lanzadas
  // como consultas a un proveedor de pago: ruido que cuesta dinero.
  const sinRestricciones = t
    .replace(/\d+(?:[.,]\d+)?\s*(?:-|–|a|y|hasta)\s*\d+(?:[.,]\d+)?\s*(?:€|eur|euros)/g, " ")
    .replace(/cost[eo][^.,;]{0,40}/g, " ")
    .replace(/(?:que\s+)?(?:no\s+)?(?:sean?|es)\s+[a-záéíóúñü]+/g, " ")
    .replace(/precio[^.,;]{0,30}/g, " ")
    .replace(/(?:sin|no|nada)\s+[a-záéíóúñü]+/g, " ")
    .replace(/\d+\s*d[ií]as?[^.,;]{0,24}/g, " ")
    .replace(/saturaci[óo]n\s+\w+/g, " ")
    .replace(/(?:m[íi]nimo|m[áa]ximo|menor|mayor|menos|m[áa]s)\s+(?:de\s+|que\s+|a\s+)?\d*/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:€|eur|euros)?\b/g, " ");

  // Palabras clave: se descartan las de relleno para no lanzar consultas
  // inútiles que igualmente cuestan créditos.
  const RELLENO = new Set([
    "quiero", "busco", "producto", "productos", "para", "que", "con", "sin", "los", "las",
    "una", "unos", "unas", "del", "por", "más", "mas", "muy", "sean", "ser", "españa",
    "cod", "contrareembolso", "ticket", "coste", "euros", "eur", "entre", "hasta", "tipo",
    "algo", "cosas", "vender", "encontrar", "saturacion", "media", "baja", "alta", "dias",
    "activos", "anuncios", "minimo", "mínimo", "segundos", "entiendan", "entienda",
    // Vistas colarse en pruebas reales: describen la RESTRICCIÓN, no el producto.
    "proveedor", "proveedores", "menor", "mayor", "menos", "frágil", "frágiles",
    "fragil", "fragiles", "tallas", "talla", "electronica", "electrónica",
    "estacional", "evergreen", "competencia", "mercado", "margen", "beneficio",
  ]);
  f.keywords = [
    ...new Set(
      sinRestricciones
        .replace(/[^a-záéíóúñ\s]/gi, " ")
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 4 && !RELLENO.has(w))
    ),
  ].slice(0, 5);

  if (f.keywords.length === 0) notes.push("No se han detectado palabras clave: escribe qué producto buscas.");
  return { filters: f, suggestedQueries: [], aiUsed: false, notes };
}

// ------------------------------------------------------------
// 2 · Clasificar el producto (features)
// ------------------------------------------------------------

const FEATURES_PROMPT = `Analiza este producto de dropshipping para venta por vídeo con pago contrareembolso en España.
Devuelve SOLO un JSON con estas claves, cada una un entero 0-100:
problemClarity, demoability, impulseBuy, wowFactor, evergreen, fragilityRisk, sizingRisk,
regulatoryRisk, complexity, returnRisk, differentiationPotential.
Añade "rationale": objeto con una frase corta (máx 12 palabras) por clave.
Los *Risk son RIESGOS: 100 = riesgo máximo.

Producto: `;

export async function classifyProduct(input: {
  name: string;
  adCopySamples: string[];
  category: string | null;
}): Promise<ProductFeature[]> {
  const texto = [
    `Nombre: ${input.name}`,
    input.category ? `Categoría: ${input.category}` : null,
    ...input.adCopySamples.slice(0, 5).map((c, i) => `Anuncio ${i + 1}: ${c.slice(0, 300)}`),
  ]
    .filter(Boolean)
    .join("\n");

  const json = extractJson(await ask(FEATURES_PROMPT, texto, { tier: "fast", maxTokens: 800, json: true }));
  if (!json) return [];

  const rationale = (json.rationale ?? {}) as Record<string, unknown>;
  const out: ProductFeature[] = [];
  for (const key of PRODUCT_FEATURE_KEYS) {
    const v = json[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const r = rationale[key];
    out.push({
      key: key as ProductFeatureKey,
      value: clampScore(v),
      // Techo deliberado: esto lo dijo un modelo leyendo copy publicitario,
      // no es una medición. Nunca debe parecer un dato duro.
      confidence: 0.55,
      rationale: typeof r === "string" && r.trim() ? r.trim().slice(0, 120) : null,
    });
  }
  return out;
}

// ------------------------------------------------------------
// 3 · Resumen "por qué destaca"
// ------------------------------------------------------------

/**
 * Resumen SIEMPRE troceado por origen. La parte observada se construye con
 * código (no puede alucinar) y la IA solo redacta la lectura. Aunque el
 * modelo falle, `observed` sigue siendo cierto.
 */
export async function generateOpportunitySummary(op: ProductOpportunity): Promise<OpportunitySummary> {
  const observed = buildObservedLines(op);
  const estimated = buildEstimatedLines(op);
  const base: OpportunitySummary = {
    observed,
    inferred: buildInferredLines(op),
    estimated,
    risks: buildRiskLines(op),
    generatedAt: Math.floor(Date.now() / 1000),
    aiGenerated: false,
  };
  if (!llmConfigured()) return base;

  const system =
    `Resume en JSON por qué un producto puede ser una oportunidad de dropshipping.\n` +
    `{"inferred":["máx 3 frases de lectura del mercado"],"risks":["máx 3 riesgos concretos"]}\n` +
    `NO inventes cifras: usa SOLO las que aparecen en los datos. Responde solo el JSON.`;
  const datos =
    `Producto: ${op.canonicalName}\n` +
    `Observado:\n${observed.map((l) => `- ${l}`).join("\n")}\n` +
    `Estimado:\n${estimated.map((l) => `- ${l}`).join("\n")}`;

  const json = extractJson(await ask(system, datos, { tier: "fast", maxTokens: 500, json: true }));
  if (!json) return base;
  const lista = (k: string): string[] =>
    Array.isArray(json[k]) ? (json[k] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 3) : [];
  const inferred = lista("inferred");
  const risks = lista("risks");
  return {
    ...base,
    inferred: inferred.length > 0 ? inferred : base.inferred,
    risks: risks.length > 0 ? [...base.risks, ...risks].slice(0, 5) : base.risks,
    aiGenerated: true,
  };
}

/**
 * «4 anunciante(s)» no lo escribe una persona: lo escribe un programa que no
 * se molestó. Y esto es lo primero que Pedro lee de cada producto.
 */
function n(valor: number, singular: string, plural: string): string {
  return `${new Intl.NumberFormat("es-ES").format(valor)} ${valor === 1 ? singular : plural}`;
}

export function buildObservedLines(op: ProductOpportunity): string[] {
  const s = op.signals;
  const out = [
    n(s.advertiserCount, "anunciante distinto", "anunciantes distintos"),
    `${n(s.activeAds, "anuncio activo", "anuncios activos")} de ${s.totalAds} vistos`,
    n(s.creativeCount, "creatividad", "creatividades"),
  ];
  if (s.oldestActiveAdDays !== null) out.push(`el anuncio más veterano lleva ${s.oldestActiveAdDays} días activo`);
  if (s.newAds7d !== null) {
    out.push(s.newAds7d === 0
      ? "ningún anuncio nuevo en los últimos 7 días"
      : n(s.newAds7d, "anuncio nuevo en 7 días", "anuncios nuevos en 7 días"));
  }
  if (s.countryCount > 0) {
    out.push(`presente en ${n(s.countryCount, "país", "países")} y ${n(s.platformCount, "plataforma", "plataformas")}`);
  }
  if (op.observedPriceMin !== null && op.observedPriceMax !== null) {
    const fmt = new Intl.NumberFormat("es-ES", { style: "currency", currency: op.currency || "EUR" });
    out.push(op.observedPriceMin === op.observedPriceMax
      ? `precio observado: ${fmt.format(op.observedPriceMin)}`
      : `precio observado entre ${fmt.format(op.observedPriceMin)} y ${fmt.format(op.observedPriceMax)}`);
  }
  return out;
}

export function buildInferredLines(op: ProductOpportunity): string[] {
  const out: string[] = [];
  const ci = op.scores.creative_investment.score;
  if (ci !== null) out.push(ci >= 66 ? "inversión creativa alta: producen anuncios nuevos con frecuencia" : ci >= 33 ? "inversión creativa moderada" : "inversión creativa baja");
  const mom = op.scores.momentum.score;
  if (mom === null) out.push("todavía no hay histórico suficiente para hablar de tendencia");
  else if (mom >= 65) out.push("el mercado está acelerando");
  else if (mom <= 35) out.push("el mercado se está enfriando");
  const sat = op.scores.saturation.score;
  if (sat !== null) out.push(sat >= 70 ? "mercado saturado: llegarías tarde" : sat <= 35 ? "poca competencia todavía" : "competencia moderada");
  return out;
}

export function buildEstimatedLines(op: ProductOpportunity): string[] {
  const e = op.economics;
  if (!e) return ["sin coste de proveedor no se puede estimar la economía"];
  const out: string[] = [];
  if (e.supplierCost.value !== null) out.push(`coste de proveedor ${e.supplierCost.value.toFixed(2)} € (${e.supplierCost.source ?? "estimado"})`);
  if (e.expectedProfit.value !== null) out.push(`beneficio esperado ${e.expectedProfit.value.toFixed(2)} € por pedido`);
  if (e.margin.value !== null) out.push(`margen ${Math.round(e.margin.value * 100)} %`);
  if (e.breakEvenCPA.value !== null) out.push(`CPA de equilibrio ${e.breakEvenCPA.value.toFixed(2)} €`);
  return out;
}

export function buildRiskLines(op: ProductOpportunity): string[] {
  const out: string[] = [];
  for (const f of op.features) {
    if (f.value === null || f.value < 70) continue;
    if (f.key === "fragilityRisk") out.push("frágil: cada rotura en COD es un rehusado más la mercancía");
    if (f.key === "regulatoryRisk") out.push("posible producto regulado: riesgo para la cuenta publicitaria");
    if (f.key === "sizingRisk") out.push("tiene tallas: multiplica devoluciones");
    if (f.key === "returnRisk") out.push("riesgo de devolución alto");
  }
  if (op.supplierCostMin === null) out.push("sin coste de proveedor confirmado");
  if (op.clusterConfidence < 0.6) out.push("la agrupación de anuncios es poco fiable: revisa que sea un solo producto");
  return out;
}

// ------------------------------------------------------------
// 4 · Análisis de creatividades (§22)
// ------------------------------------------------------------

export interface CreativeAnalysis {
  /** Ganchos que más se repiten, tal y como los usan los anunciantes. */
  hooks: string[];
  /** Ángulos de venta dominantes: problema, comparación, testimonio… */
  angles: string[];
  /** Formato más frecuente según el copy (no lo dice la API: es lectura). */
  dominantFormat: string | null;
  /** Rasgos observados en el conjunto: UGC, antes-después, demostración… */
  traits: string[];
  /** Qué copiaríamos si lanzáramos mañana. */
  takeaways: string[];
  aiGenerated: boolean;
}

const CREATIVE_PROMPT = `Eres analista de creatividades publicitarias. Te doy textos de anuncios REALES de un mismo producto.
Devuelve SOLO este JSON:
{"hooks":["3-5 ganchos que más se repiten, literales o casi"],
 "angles":["2-4 ángulos de venta dominantes"],
 "dominantFormat":"demostración|testimonio|antes y después|comparativa|oferta|desconocido",
 "traits":["2-5 rasgos observados: UGC, voz en off, antes-después, urgencia…"],
 "takeaways":["2-3 cosas que copiarías al lanzar este producto"]}
No inventes: si algo no se ve en los textos, no lo pongas. Español. Responde solo el JSON.`;

/**
 * Solo se llama sobre la SHORTLIST (§30). Analizar 2.000 anuncios uno a uno
 * costaría una fortuna y no cambiaría ninguna decisión: lo que importa es el
 * patrón del conjunto, no cada anuncio.
 */
export async function analyzeCreatives(input: {
  productName: string;
  adCopies: string[];
}): Promise<CreativeAnalysis> {
  const base = deterministicCreatives(input.adCopies);
  if (!llmConfigured() || input.adCopies.length === 0) return base;

  const datos = [
    `Producto: ${input.productName}`,
    ...input.adCopies.slice(0, 12).map((c, i) => `Anuncio ${i + 1}: ${c.slice(0, 320)}`),
  ].join("\n");

  const json = extractJson(await ask(CREATIVE_PROMPT, datos, { tier: "fast", maxTokens: 700, json: true }));
  if (!json) return base;

  const formato = typeof json.dominantFormat === "string" ? json.dominantFormat.trim().slice(0, 40) : null;
  return {
    hooks: stringList(json.hooks, 5, 140).length > 0 ? stringList(json.hooks, 5, 140) : base.hooks,
    angles: stringList(json.angles, 4, 100).length > 0 ? stringList(json.angles, 4, 100) : base.angles,
    dominantFormat: formato && formato.toLowerCase() !== "desconocido" ? formato : base.dominantFormat,
    traits: stringList(json.traits, 5, 80).length > 0 ? stringList(json.traits, 5, 80) : base.traits,
    takeaways: stringList(json.takeaways, 3, 160),
    aiGenerated: true,
  };
}

/**
 * Versión SIN IA. No es un placeholder: cuenta patrones de verdad sobre el
 * texto, así que sin clave la pestaña de creatividades sigue diciendo algo
 * cierto en vez de quedarse en blanco.
 */
export function deterministicCreatives(copies: string[]): CreativeAnalysis {
  const limpios = copies.filter((c) => c && c.trim().length > 0);
  if (limpios.length === 0) {
    return { hooks: [], angles: [], dominantFormat: null, traits: [], takeaways: [], aiGenerated: false };
  }

  // Primera frase de cada anuncio = el gancho, por construcción del formato.
  const primeras = limpios
    .map((c) => c.split(/[.!?\n]/)[0]?.trim() ?? "")
    .filter((f) => f.length >= 12 && f.length <= 120);
  const hooks = [...new Set(primeras)].slice(0, 5);

  const texto = limpios.join(" ").toLowerCase();
  const PATRONES: Array<[RegExp, string]> = [
    [/antes y despu[ée]s|before.{0,6}after/, "antes y después"],
    [/testimoni|clientes? dice|opini[oó]n real/, "testimonio"],
    [/mira c[oó]mo|te enseño|as[ií] funciona|demostraci/, "demostración"],
    [/oferta|descuento|\d+\s*%|env[ií]o gratis|2x1/, "oferta"],
    [/[úu]ltimas unidades|solo hoy|se agota|date prisa/, "urgencia"],
    [/contrareembolso|paga al recibir|pago al recibir/, "pago al recibir"],
    [/comparativa|mejor que|frente a/, "comparativa"],
  ];
  const traits = PATRONES.filter(([re]) => re.test(texto)).map(([, l]) => l);

  const FORMATO_PRIORIDAD = ["demostración", "antes y después", "testimonio", "comparativa", "oferta"];
  const dominantFormat = FORMATO_PRIORIDAD.find((f) => traits.includes(f)) ?? null;

  const angles: string[] = [];
  if (/problema|cansad|harto|molest|no soport/.test(texto)) angles.push("resuelve un problema concreto");
  if (/ahorr|barat|precio/.test(texto)) angles.push("ahorro");
  if (/f[áa]cil|r[áa]pido|en segundos|sin esfuerzo/.test(texto)) angles.push("facilidad y rapidez");
  if (/regalo|ideal para regalar/.test(texto)) angles.push("regalo");

  return { hooks, angles, dominantFormat, traits, takeaways: [], aiGenerated: false };
}
