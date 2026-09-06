// ============================================================
// AI Winner Radar — FILTROS y DÓNDE SE APLICA CADA UNO.
//
// No todos los filtros son iguales y confundirlos produce resultados
// silenciosamente mal filtrados:
//
//   SOURCE_FILTER    lo entiende la API del proveedor → viaja en la consulta
//   POST_FILTER      se calcula al agrupar → se aplica sobre el cluster
//   AI_FILTER        depende de una inferencia → solo si hay análisis de IA
//   FINANCIAL_FILTER necesita economía → solo si hay precio y coste
//
// Un AI_FILTER aplicado sin análisis descartaría productos por una condición
// que nadie ha evaluado. Por eso, cuando el dato no existe, el filtro NO
// descarta: deja pasar y lo marca. Descartar por ignorancia es peor que no
// filtrar, porque el producto desaparece sin que nadie sepa por qué.
// ============================================================

import type { FilterKind, HunterFilters, ProductOpportunity } from "../types";

export const FILTER_KIND: Record<keyof HunterFilters, FilterKind> = {
  country: "SOURCE_FILTER",
  platforms: "SOURCE_FILTER",
  keywords: "SOURCE_FILTER",
  categories: "POST_FILTER",
  excludeKeywords: "POST_FILTER",
  priceMin: "POST_FILTER",
  priceMax: "POST_FILTER",
  supplierCostMax: "FINANCIAL_FILTER",
  minMargin: "FINANCIAL_FILTER",
  minExpectedProfit: "FINANCIAL_FILTER",
  minDaysActive: "SOURCE_FILTER",
  maxDaysActive: "POST_FILTER",
  minAdvertisers: "POST_FILTER",
  maxAdvertisers: "POST_FILTER",
  minActiveAds: "POST_FILTER",
  minCreativeCount: "POST_FILTER",
  momentumMin: "POST_FILTER",
  saturationMax: "POST_FILTER",
  codFit: "AI_FILTER",
  evergreen: "AI_FILTER",
  seasonality: "AI_FILTER",
  fragile: "AI_FILTER",
  requiresSizing: "AI_FILTER",
  electronics: "AI_FILTER",
  regulatoryRisk: "AI_FILTER",
  problemClarity: "AI_FILTER",
  demoability: "AI_FILTER",
  impulseBuy: "AI_FILTER",
  shippingComplexity: "AI_FILTER",
};

export function defaultFilters(): HunterFilters {
  return {
    country: "ES",
    platforms: [],
    categories: [],
    keywords: [],
    excludeKeywords: [],
    priceMin: null,
    priceMax: null,
    supplierCostMax: null,
    minMargin: null,
    minExpectedProfit: null,
    minDaysActive: null,
    maxDaysActive: null,
    minAdvertisers: null,
    maxAdvertisers: null,
    minActiveAds: null,
    minCreativeCount: null,
    momentumMin: null,
    saturationMax: null,
    codFit: null,
    evergreen: null,
    seasonality: null,
    fragile: null,
    requiresSizing: null,
    electronics: null,
    regulatoryRisk: null,
    problemClarity: null,
    demoability: null,
    impulseBuy: null,
    shippingComplexity: null,
  };
}

export interface FilterOutcome {
  keep: boolean;
  /** Qué filtro lo descartó, para poder explicárselo a Pedro. */
  rejectedBy: string | null;
  /** Filtros que no se pudieron evaluar por falta de dato. */
  skipped: string[];
}

/**
 * Aplica los filtros que se evalúan DESPUÉS de agrupar. Devuelve también qué
 * no se pudo comprobar: un resultado que pasa "porque no sabíamos" no es lo
 * mismo que uno que pasa de verdad, y la UI debe poder distinguirlo.
 */
export function applyPostFilters(op: ProductOpportunity, f: HunterFilters): FilterOutcome {
  const skipped: string[] = [];
  const reject = (name: string): FilterOutcome => ({ keep: false, rejectedBy: name, skipped });

  if (f.categories.length > 0) {
    if (op.category === null) skipped.push("categories");
    else if (!f.categories.some((c) => op.category!.toLowerCase().includes(c.toLowerCase()))) return reject("categories");
  }

  if (f.excludeKeywords.length > 0) {
    const texto = `${op.canonicalName} ${op.description ?? ""}`.toLowerCase();
    if (f.excludeKeywords.some((k) => k.trim() && texto.includes(k.toLowerCase()))) return reject("excludeKeywords");
  }

  // Precio: se compara contra el rango observado. Si el rango no se solapa
  // con lo pedido, fuera; si no hay precio observado, no se descarta.
  if (f.priceMin !== null) {
    if (op.observedPriceMax === null) skipped.push("priceMin");
    else if (op.observedPriceMax < f.priceMin) return reject("priceMin");
  }
  if (f.priceMax !== null) {
    if (op.observedPriceMin === null) skipped.push("priceMax");
    else if (op.observedPriceMin > f.priceMax) return reject("priceMax");
  }

  const s = op.signals;
  if (f.minAdvertisers !== null && s.advertiserCount < f.minAdvertisers) return reject("minAdvertisers");
  if (f.maxAdvertisers !== null && s.advertiserCount > f.maxAdvertisers) return reject("maxAdvertisers");
  if (f.minActiveAds !== null && s.activeAds < f.minActiveAds) return reject("minActiveAds");
  if (f.minCreativeCount !== null && s.creativeCount < f.minCreativeCount) return reject("minCreativeCount");

  if (f.maxDaysActive !== null) {
    if (s.oldestActiveAdDays === null) skipped.push("maxDaysActive");
    else if (s.oldestActiveAdDays > f.maxDaysActive) return reject("maxDaysActive");
  }
  if (f.minDaysActive !== null) {
    if (s.oldestActiveAdDays === null) skipped.push("minDaysActive");
    else if (s.oldestActiveAdDays < f.minDaysActive) return reject("minDaysActive");
  }

  // Momentum y saturación pueden no existir por falta de histórico. No se
  // descarta por ello: sería enterrar todo lo recién descubierto, que es
  // justo lo que más interesa encontrar.
  if (f.momentumMin !== null) {
    const m = op.scores.momentum.score;
    if (m === null) skipped.push("momentumMin");
    else if (m < f.momentumMin) return reject("momentumMin");
  }
  if (f.saturationMax !== null) {
    const sat = op.scores.saturation.score;
    if (sat === null) skipped.push("saturationMax");
    else if (sat > f.saturationMax) return reject("saturationMax");
  }

  return { keep: true, rejectedBy: null, skipped };
}

/** Filtros financieros: solo cuando hay economía calculada. */
export function applyFinancialFilters(op: ProductOpportunity, f: HunterFilters): FilterOutcome {
  const skipped: string[] = [];
  const e = op.economics;
  const reject = (name: string): FilterOutcome => ({ keep: false, rejectedBy: name, skipped });

  if (f.supplierCostMax !== null) {
    const cost = e?.supplierCost.value ?? op.supplierCostMin;
    if (cost === null) skipped.push("supplierCostMax");
    else if (cost > f.supplierCostMax) return reject("supplierCostMax");
  }
  if (f.minMargin !== null) {
    const m = e?.margin.value ?? null;
    if (m === null) skipped.push("minMargin");
    else if (m < f.minMargin) return reject("minMargin");
  }
  if (f.minExpectedProfit !== null) {
    const p = e?.expectedProfit.value ?? null;
    if (p === null) skipped.push("minExpectedProfit");
    else if (p < f.minExpectedProfit) return reject("minExpectedProfit");
  }
  return { keep: true, rejectedBy: null, skipped };
}

/** Filtros que dependen de la IA. Sin features, no descartan. */
export function applyAiFilters(op: ProductOpportunity, f: HunterFilters): FilterOutcome {
  const skipped: string[] = [];
  const val = (k: string): number | null => op.features.find((x) => x.key === k)?.value ?? null;
  const reject = (name: string): FilterOutcome => ({ keep: false, rejectedBy: name, skipped });

  const gate = (
    name: string,
    wanted: boolean | null,
    featureKey: string,
    /** true = la feature ALTA significa "sí lo es". */
    highMeansYes = true
  ): FilterOutcome | null => {
    if (wanted === null) return null;
    const v = val(featureKey);
    if (v === null) {
      skipped.push(name);
      return null;
    }
    const es = highMeansYes ? v >= 50 : v < 50;
    return es === wanted ? null : reject(name);
  };

  const checks = [
    gate("fragile", f.fragile, "fragilityRisk"),
    gate("requiresSizing", f.requiresSizing, "sizingRisk"),
    gate("regulatoryRisk", f.regulatoryRisk, "regulatoryRisk"),
    gate("evergreen", f.evergreen, "evergreen"),
  ];
  for (const c of checks) if (c) return c;

  const minimo = (name: string, wanted: number | null, featureKey: string): FilterOutcome | null => {
    if (wanted === null) return null;
    const v = val(featureKey);
    if (v === null) {
      skipped.push(name);
      return null;
    }
    return v >= wanted ? null : reject(name);
  };
  for (const c of [
    minimo("problemClarity", f.problemClarity, "problemClarity"),
    minimo("demoability", f.demoability, "demoability"),
    minimo("impulseBuy", f.impulseBuy, "impulseBuy"),
  ]) {
    if (c) return c;
  }

  if (f.shippingComplexity !== null) {
    const v = val("complexity");
    if (v === null) skipped.push("shippingComplexity");
    else if (v > f.shippingComplexity) return reject("shippingComplexity");
  }
  return { keep: true, rejectedBy: null, skipped };
}
