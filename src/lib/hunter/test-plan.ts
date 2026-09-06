// ============================================================
// AI Winner Radar — PLAN DE PRUEBA y TRASPASO A LANDING STUDIO.
//
// Cuando Pedro marca TESTEAR, esto produce un PLAN: precio, CPA objetivo,
// presupuesto y duración. **No lanza ninguna campaña** ni toca Meta Ads: solo
// escribe lo que habría que hacer, con las cuentas a la vista.
//
// Todos los números salen del motor financiero, no de la IA. Un presupuesto
// de prueba inventado por un modelo es dinero real perdido.
// ============================================================

import type { ProductOpportunity, TestPlan } from "./types";

/** Pedidos necesarios para que un test diga algo. Menos es leer ruido. */
export const MIN_ORDERS_FOR_SIGNAL = 15;
/** Margen de seguridad sobre el CPA de equilibrio para el objetivo. */
export const TARGET_CPA_SAFETY = 0.7;

export function buildTestPlan(op: ProductOpportunity): TestPlan {
  const e = op.economics;
  const rationale: string[] = [];

  const recommendedPrice = op.observedPriceMax ?? op.observedPriceMin ?? null;
  if (recommendedPrice !== null) {
    rationale.push(
      `Precio ${recommendedPrice.toFixed(2)} € : es el más alto observado en la competencia. ` +
      `Empezar por abajo regala margen y bajar después siempre es más fácil que subir.`
    );
  }

  const breakEvenCPA = e?.breakEvenCPA.value ?? null;
  const targetCPA = breakEvenCPA !== null ? Number((breakEvenCPA * TARGET_CPA_SAFETY).toFixed(2)) : null;
  if (breakEvenCPA !== null && targetCPA !== null) {
    rationale.push(
      `CPA de equilibrio ${breakEvenCPA.toFixed(2)} €; objetivo ${targetCPA.toFixed(2)} € ` +
      `(${Math.round((1 - TARGET_CPA_SAFETY) * 100)} % por debajo, para que el test deje margen y no solo empate).`
    );
  } else {
    rationale.push("Sin coste de proveedor no hay CPA de equilibrio: mételo a mano antes de gastar un euro.");
  }

  // Presupuesto = lo que cuesta comprar los pedidos mínimos para leer algo.
  const recommendedDailyBudget =
    targetCPA !== null ? Math.max(10, Math.round((targetCPA * MIN_ORDERS_FOR_SIGNAL) / 5)) : null;
  if (recommendedDailyBudget !== null) {
    rationale.push(
      `Presupuesto ${recommendedDailyBudget} €/día durante 5 días: es lo que hace falta para ~${MIN_ORDERS_FOR_SIGNAL} pedidos. ` +
      `Con menos, lo que se mide es ruido.`
    );
  }

  const creativeAngles = buildCreativeAngles(op);

  return {
    opportunityId: op.id,
    recommendedPrice,
    targetCPA,
    breakEvenCPA,
    recommendedDailyBudget,
    testDurationDays: recommendedDailyBudget !== null ? 5 : null,
    creativeAngles,
    landingHypothesis: buildLandingHypothesis(op),
    generatedAt: Math.floor(Date.now() / 1000),
    rationale,
  };
}

/**
 * Ángulos derivados de lo OBSERVADO en la competencia, no inventados. Si el
 * 60 % de los anuncios activos son vídeo, el primer ángulo es demostración.
 */
export function buildCreativeAngles(op: ProductOpportunity): string[] {
  const angles: string[] = [];
  const f = (k: string) => op.features.find((x) => x.key === k)?.value ?? null;

  if ((f("demoability") ?? 0) >= 60) angles.push("Demostración en 5 segundos: el problema, el producto actuando, el resultado.");
  if ((f("problemClarity") ?? 0) >= 60) angles.push("Abrir con el problema visual antes de enseñar el producto.");
  if ((f("wowFactor") ?? 0) >= 60) angles.push("Antes/después sin cortes, para que no parezca truco.");
  if ((f("impulseBuy") ?? 0) >= 60) angles.push("Oferta directa con contrareembolso: pagar al recibir baja la barrera.");
  if (op.signals.creativeCount >= 8) {
    angles.push(`La competencia mantiene ${op.signals.creativeCount} creatividades: prepara al menos 3 variantes desde el día uno.`);
  }
  if (angles.length === 0) {
    angles.push("Sin análisis de IA todavía: mira los anuncios de la pestaña Creatividades y copia el patrón dominante.");
  }
  return angles;
}

function buildLandingHypothesis(op: ProductOpportunity): string | null {
  const precio = op.observedPriceMax ?? op.observedPriceMin;
  if (precio === null) return null;
  return (
    `Landing de producto único a ${precio.toFixed(2)} € con pago contrareembolso visible arriba, ` +
    `demostración en vídeo y garantía de devolución. Sin menú ni distracciones.`
  );
}

// --- Traspaso a Landing Studio -------------------------------------------

export interface LandingHandoff {
  productName: string;
  problem: string | null;
  benefits: string[];
  price: number | null;
  currency: string;
  offer: string | null;
  hooks: string[];
  competitorPatterns: string[];
  creativeAngles: string[];
  /** De dónde sale esto, para que el Studio no lo presente como verdad. */
  provenanceNote: string;
}

/**
 * Prepara el paquete para Landing Studio. NO duplica el editor: solo entrega
 * los datos. El Studio sigue siendo el dueño de la landing.
 */
export function buildLandingHandoff(op: ProductOpportunity): LandingHandoff {
  const plan = buildTestPlan(op);
  const patterns: string[] = [];
  if (op.signals.advertiserCount > 0) patterns.push(`${op.signals.advertiserCount} marcas compiten por este producto`);
  if (op.signals.oldestActiveAdDays !== null) patterns.push(`el anuncio más veterano lleva ${op.signals.oldestActiveAdDays} días activo`);
  if (op.observedPriceMin !== null && op.observedPriceMax !== null) {
    patterns.push(`precios de la competencia entre ${op.observedPriceMin.toFixed(2)} y ${op.observedPriceMax.toFixed(2)} ${op.currency}`);
  }

  return {
    productName: op.canonicalName,
    problem: op.summary?.observed[0] ?? null,
    benefits: op.summary?.inferred ?? [],
    price: plan.recommendedPrice,
    currency: op.currency,
    offer: plan.landingHypothesis,
    hooks: plan.creativeAngles,
    competitorPatterns: patterns,
    creativeAngles: plan.creativeAngles,
    provenanceNote:
      "Datos del AI Winner Radar: las señales son observadas, la economía es calculada y las lecturas son inferencias. " +
      "Verifica precio y coste antes de publicar nada.",
  };
}
