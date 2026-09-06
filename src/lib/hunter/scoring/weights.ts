// ============================================================
// AI Winner Radar — PESOS. Config versionada, no números sueltos por el código.
//
// Cada peso lleva su porqué. Un score cuyos pesos nadie puede explicar es un
// número que no se puede discutir, y un número que no se puede discutir se
// acaba ignorando o —peor— obedeciendo a ciegas.
//
// Al cambiar pesos, SUBE `SCORING_VERSION`: los scores guardados se calcularon
// con la versión anterior y compararlos entre versiones no significa nada.
// ============================================================

export const SCORING_VERSION = "1.0.0";

/**
 * Casamable pesa MÁS que el mercado a propósito. Un producto que arrasa en
 * TikTok pero deja 3 € de margen en COD español no es una oportunidad para
 * nosotros: es una oportunidad para otro. Y el mercado pesa más que el
 * producto porque la demanda demostrada es más difícil de fabricar que una
 * buena creatividad.
 */
export const OPPORTUNITY_SCORE_WEIGHTS = {
  market: 0.35,
  product: 0.25,
  casamable: 0.4,
} as const;

/** Componentes del Market Score. Suman 1. */
export const MARKET_WEIGHTS = {
  /** Un anuncio que lleva 60 días vivo es dinero votando: nadie quema
   *  presupuesto dos meses en algo que no convierte. La señal más fiable. */
  adLongevity: 0.24,
  /** Muchos anuncios activos = demanda sostenida, no un pico. */
  activeAdDensity: 0.16,
  /** Varias marcas vendiéndolo valida el producto, no solo al anunciante. */
  advertiserDiversity: 0.16,
  /** Producir creatividades cuesta: hacerlo indica que les sale rentable. */
  creativeInvestment: 0.18,
  /** Creatividades nuevas esta semana = siguen invirtiendo AHORA. */
  creativeVelocity: 0.1,
  /** Anunciantes nuevos entrando = el mercado se está abriendo. */
  advertiserVelocity: 0.08,
  /** Funciona en varias plataformas/países: menos dependiente de un algoritmo. */
  crossPlatform: 0.08,
} as const;

/** Componentes de la saturación. Suman 1. */
export const SATURATION_WEIGHTS = {
  advertiserCount: 0.3,
  adCount: 0.2,
  countrySpread: 0.15,
  creativeDuplication: 0.15,
  ageDistribution: 0.1,
  /** Concentración INVERTIDA: si un solo actor domina, hay hueco; si está
   *  repartido entre veinte, llegas tarde. */
  marketConcentration: 0.1,
} as const;

/**
 * Umbrales de referencia. Son juicios de negocio explícitos, no constantes
 * mágicas: cambiarlos cambia qué considera "bueno" el sistema.
 */
export const MARKET_REFERENCE = {
  /** Días de anuncio activo a partir de los cuales la señal es máxima. */
  longevityFullDays: 60,
  /** Anuncios activos que ya se consideran densidad plena. */
  activeAdsFull: 40,
  /** Anunciantes que ya se consideran diversidad plena. */
  advertisersFull: 12,
  /** Creatividades por anunciante que indican inversión seria. */
  creativesPerAdvertiserFull: 6,
} as const;

export const SATURATION_REFERENCE = {
  /** A partir de aquí el mercado está lleno. */
  advertisersSaturated: 25,
  adsSaturated: 120,
  countriesSaturated: 8,
} as const;

/**
 * Penalizaciones. Se aplican al FINAL y son duras porque cada una representa
 * una forma conocida de perder dinero, no una preferencia estética.
 */
export const PENALTIES = {
  /** Un producto regulado puede costar la cuenta publicitaria entera. */
  regulatoryRisk: 0.45,
  /** Margen bajo mínimo: no hay volumen que arregle vender a pérdida. */
  marginBelowThreshold: 0.5,
  /** Sin proveedor no hay negocio, por bonito que sea el producto. */
  supplierUnavailable: 0.35,
  /** Saturación extrema: llegas tarde y pagas el CPA de todos. */
  verySaturated: 0.3,
  /** Frágil en COD: cada rotura es un rehusado más la mercancía perdida. */
  highFragility: 0.25,
} as const;

/** Margen por debajo del cual el producto no compensa (fracción sobre precio). */
export const MIN_VIABLE_MARGIN = 0.25;

/** Saturación a partir de la cual se penaliza de verdad. */
export const VERY_SATURATED_THRESHOLD = 80;

/** Riesgo (0-100) a partir del cual una feature de riesgo penaliza. */
export const HIGH_RISK_THRESHOLD = 70;
