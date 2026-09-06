// ============================================================
// AI Winner Radar — EL VEREDICTO: TESTEAR · VIGILAR · DESCARTAR.
//
// Un «87/100» no dice qué hacer. Lo que Pedro necesita leer en la tarjeta es
// un verbo, y detrás el motivo.
//
// Se decide con REGLAS EXPLÍCITAS, no con IA. Tres razones:
//   · Se puede auditar: cada veredicto lleva su «porque…».
//   · Es estable: el mismo producto con los mismos datos da el mismo verbo
//     hoy y dentro de un mes. Un modelo cambia de opinión entre llamadas.
//   · Es gratis: no gasta una llamada por producto.
//
// Y una regla de honestidad: SIN DATOS SUFICIENTES NO SE DICE «DESCARTAR».
// Se dice «VIGILAR» con el motivo. Descartar por ignorancia es como se
// pierden los productos buenos que llegaron un poco pronto.
// ============================================================

import { adLibrarySearchUrl } from "./links";
import type { ProductOpportunity, Recommendation } from "./types";
import { MIN_VIABLE_MARGIN, VERY_SATURATED_THRESHOLD } from "./scoring/weights";

export interface Verdict {
  recommendation: Recommendation;
  /** Una frase. Es lo que se enseña bajo el verbo. */
  because: string;
  /** Lo que habría que resolver para que el veredicto suba. */
  blockers: string[];
}

/** Score de oportunidad a partir del cual merece la pena gastar en un test. */
export const TEST_THRESHOLD = 68;
/** Por debajo de esto, ni vigilar: no hay señal. */
export const DISCARD_THRESHOLD = 38;
/** Confianza mínima para atreverse a recomendar un test. */
export const MIN_CONFIDENCE_TO_TEST = 0.5;

export function decideVerdict(op: ProductOpportunity): Verdict {
  const opp = op.scores.opportunity;
  const sat = op.scores.saturation.score;
  const mom = op.scores.momentum.score;
  const bloqueos: string[] = [];

  // --- Descalificaciones duras. Van primero: da igual el score. ---
  const margen = op.economics?.margin.value ?? null;
  if (margen !== null && margen < MIN_VIABLE_MARGIN) {
    return {
      recommendation: "DESCARTAR",
      because: `El margen sale al ${Math.round(margen * 100)} %, por debajo del mínimo viable (${Math.round(MIN_VIABLE_MARGIN * 100)} %).`,
      blockers: ["Conseguir el producto más barato o venderlo más caro"],
    };
  }
  if (sat !== null && sat >= VERY_SATURATED_THRESHOLD) {
    return {
      recommendation: "DESCARTAR",
      because: `El mercado ya está muy saturado (${Math.round(sat)}/100): llegarías tarde y pagando el CPA de todos.`,
      blockers: ["Buscar un ángulo o un nicho que no esté ocupado"],
    };
  }
  for (const f of op.features) {
    if (f.value === null) continue;
    if (f.key === "regulatoryRisk" && f.value >= 75) {
      return {
        recommendation: "DESCARTAR",
        because: "Parece un producto regulado: el riesgo no es perder el test, es perder la cuenta publicitaria.",
        blockers: ["Confirmar que se puede anunciar antes de gastar un euro"],
      };
    }
    if (f.key === "fragilityRisk" && f.value >= 80) bloqueos.push("Es frágil: en contrareembolso cada rotura es un rehusado más la mercancía");
    if (f.key === "sizingRisk" && f.value >= 75) bloqueos.push("Tiene tallas: multiplica devoluciones");
  }

  // --- Sin evidencia no se dictamina. ---
  if (opp.score === null) {
    return {
      recommendation: "VIGILAR",
      because: "Todavía no hay datos suficientes para juzgarlo. Vuelve a mirarlo cuando haya más anuncios.",
      blockers: ["Hacen falta más anuncios o más histórico"],
    };
  }
  if (op.signals.advertiserCount <= 1) {
    return {
      recommendation: "VIGILAR",
      because: `Solo lo anuncia ${op.signals.advertiserCount} marca: puede ser el principio de algo o puede no funcionar para nadie.`,
      blockers: ["Esperar a que entre un segundo anunciante"],
    };
  }

  if (opp.score < DISCARD_THRESHOLD) {
    return {
      recommendation: "DESCARTAR",
      because: `La señal es floja (${Math.round(opp.score)}/100) y no hay nada que compense.`,
      blockers: bloqueos,
    };
  }

  // --- Zona de test ---
  if (opp.score >= TEST_THRESHOLD && opp.confidence >= MIN_CONFIDENCE_TO_TEST && bloqueos.length === 0) {
    const razones: string[] = [];
    if (mom !== null && mom >= 65) razones.push("está acelerando");
    if (sat !== null && sat <= 45) razones.push("sin señales claras de saturación");
    if (op.economics?.expectedProfit.value != null && op.economics.expectedProfit.value > 0) {
      razones.push(`deja unos ${op.economics.expectedProfit.value.toFixed(0)} € por pedido`);
    }
    return {
      recommendation: "TESTEAR",
      because: razones.length > 0
        ? `${capitalizar(razones.join(", "))}. ${op.signals.advertiserCount} anunciantes y ${op.signals.activeAds} anuncios activos lo sostienen.`
        : `Buena señal de mercado con ${op.signals.advertiserCount} anunciantes y ${op.signals.activeAds} anuncios activos.`,
      blockers: [],
    };
  }

  // --- Todo lo demás: vigilar, y decir qué le falta. ---
  const falta: string[] = [...bloqueos];
  if (opp.confidence < MIN_CONFIDENCE_TO_TEST) falta.push(`La confianza es del ${Math.round(opp.confidence * 100)} %: faltan datos para arriesgar dinero`);
  if (opp.score < TEST_THRESHOLD) falta.push(`El score de oportunidad (${Math.round(opp.score)}) se queda por debajo de ${TEST_THRESHOLD}`);
  if (op.economics === null) falta.push("Sin coste de proveedor no se puede calcular si sale a cuenta");
  if (op.scores.momentum.score === null) falta.push("Sin histórico todavía no se sabe si sube o baja");

  return {
    recommendation: "VIGILAR",
    because: falta[0] ?? "Tiene señal, pero aún no lo suficiente para gastar en un test.",
    blockers: falta.slice(1, 4),
  };
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Una frase corta de por qué interesa, para la tarjeta (§11). Se construye
 * SOLO con lo observado: si el modelo no está disponible, la tarjeta sigue
 * diciendo algo cierto.
 */
export function whyLine(op: ProductOpportunity): string {
  const s = op.signals;
  const trozos: string[] = [];

  const mom = op.scores.momentum.score;
  const sat = op.scores.saturation.score;
  if (mom !== null && mom >= 65 && sat !== null && sat <= 50) {
    trozos.push("Está acelerando sin señales claras de saturación");
  } else if (mom !== null && mom >= 65) {
    trozos.push("Está acelerando");
  } else if (sat !== null && sat >= 70) {
    trozos.push("Mercado concurrido");
  } else if (s.oldestActiveAdDays !== null && s.oldestActiveAdDays >= 60) {
    trozos.push(`Lleva ${s.oldestActiveAdDays} días vendiéndose sin parar`);
  } else {
    trozos.push("Señal temprana");
  }

  const datos: string[] = [];
  if (s.newAdvertisers14d !== null && s.newAdvertisers14d > 0) datos.push(`${s.newAdvertisers14d} anunciantes nuevos en 14 días`);
  else if (s.advertiserCount > 0) datos.push(`${s.advertiserCount} anunciantes`);
  if (s.activeAds > 0) datos.push(`${s.activeAds} creatividades activas`);

  return datos.length > 0 ? `${trozos[0]}. ${capitalizar(datos.join(" y "))}.` : `${trozos[0]}.`;
}

/**
 * Rellena lo que NO se guarda en base porque se deriva: el veredicto y el
 * enlace a la Biblioteca de Anuncios. Se aplica al leer, no al escribir, para
 * que una búsqueda de hace dos semanas se juzgue con las reglas de hoy y
 * cambiar un umbral no obligue a reescribir la tabla entera.
 */
export function withVerdict(op: ProductOpportunity, country = "ES"): ProductOpportunity {
  return {
    ...op,
    recommendation: op.recommendation ?? decideVerdict(op).recommendation,
    adLibraryUrl: op.adLibraryUrl ?? adLibrarySearchUrl(op.canonicalName, country),
  };
}

export function withVerdictAll(ops: ProductOpportunity[], country = "ES"): ProductOpportunity[] {
  return ops.map((o) => withVerdict(o, country));
}
