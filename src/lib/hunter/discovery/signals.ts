// ============================================================
// SEÑALES DE "POR QUÉ PARECE QUE LE FUNCIONA" (07-09-2026)
// docs/HUNTER-BUSCADOR.md
//
// REGLA DURA, y es la que gobierna este fichero: la Ad Library **no expone
// gasto, impresiones ni CTR** para anuncios comerciales normales (solo para
// los de temática social o política). Así que aquí NO hay métricas de
// rendimiento. Hay señales indirectas, y cada una declara:
//
//   fuente:      'api'       — campo devuelto por Meta, tal cual
//                'derivada'  — calculada por nosotros a partir de campos de la API
//                'declarado' — texto que escribió el anunciante (no verificado)
//   confirmado:  true  solo si es un dato de la API sin interpretación
//                false si es una señal, y entonces `limite` dice por qué
//
// Lo que se enseñe en pantalla debe llevar esa etiqueta. Una señal no es una
// métrica, y un dominio declarado no es un dominio resuelto.
// ============================================================

import { MOMENTUM_RULE, MOMENTUM_STALE_DAYS } from "./momentum";
import type { AdLibraryAd, DiscoverySnapshot, MomentumTrace } from "./types";

export type SignalSource = "api" | "derivada" | "declarado";

export interface CompetitorSignal {
  id: string;
  label: string;
  value: string | number | null;
  source: SignalSource;
  confirmado: boolean;
  /** Qué NO significa este número. Vacío solo si es un dato crudo de la API. */
  limite: string | null;
}

export interface CompetitorReport {
  /** El momentum con sus numeros y su fecha, para poder auditarlo. */
  momentum: MomentumTrace;
  pageId: string;
  pageName: string | null;
  candidateKey: string;
  /** Enlace a la ficha del anuncio en Meta: la evidencia, no el creativo. */
  snapshotUrls: string[];
  activeAds: number;
  signals: CompetitorSignal[];
  noise: boolean;
  noiseReason: string | null;
}

const DAY = 86_400;

/**
 * Textos creativos distintos: señal de test o escalado. Cuenta el COPY
 * (bodies y titles), NO el caption: ese es el dominio de visualización y es
 * el mismo en todos los anuncios de una tienda, así que inflaba el recuento.
 */
export function creativeVariants(ads: AdLibraryAd[]): number {
  const vistos = new Set<string>();
  for (const ad of ads) {
    const texto = [...ad.bodies, ...ad.titles].join(" ").trim().toLowerCase();
    if (texto) vistos.add(texto);
  }
  return vistos.size;
}

/**
 * Dominio DECLARADO por el anunciante en `ad_creative_link_captions`. Meta
 * suele devolver ahí el dominio de visualización del enlace. No es una URL
 * resuelta: no se visita nada, y el anunciante puede poner una marca en vez
 * del dominio real.
 */
export function declaredDomains(ads: AdLibraryAd[]): string[] {
  const dominios = new Set<string>();
  for (const ad of ads) {
    for (const caption of ad.captions) {
      const limpio = caption.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
      if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(limpio)) dominios.add(limpio);
    }
  }
  return [...dominios];
}

export interface CompetitorSignalsInput {
  snapshot: DiscoverySnapshot;
  now?: number;
  /** Países en los que ESTE candidato se ha visto, según corridas anteriores. */
  countriesSeen?: string[];
}

export function competitorSignals(input: CompetitorSignalsInput): CompetitorReport {
  const { snapshot } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const signals: CompetitorSignal[] = [];

  // 1 · Días activo. Derivada de ad_delivery_start_time del anuncio más viejo
  //     que sigue activo. Es la señal más honesta que da esta API.
  const dias = snapshot.oldestActiveAt !== null ? Math.max(0, Math.floor((now - snapshot.oldestActiveAt) / DAY)) : null;
  signals.push({
    id: "dias_activo",
    label: "Días que lleva activo el anuncio más antiguo",
    value: dias,
    source: "derivada",
    confirmado: false,
    limite:
      "solo cuenta anuncios ACTIVOS: si el anunciante pausó y relanzó, se lee más joven de lo que es. Que lleve semanas sugiere que le funciona; no lo demuestra.",
  });

  // 2 · Anuncios activos ahora mismo.
  signals.push({
    id: "anuncios_activos",
    label: "Anuncios activos de este producto",
    value: snapshot.activeAds,
    source: "api",
    confirmado: true,
    limite: null,
  });

  // 3 · Variantes creativas distintas: sugiere test o escalado.
  const variantes = creativeVariants(snapshot.ads);
  signals.push({
    id: "variantes_creativas",
    label: "Textos creativos distintos a la vez",
    value: variantes,
    source: "derivada",
    confirmado: false,
    limite:
      "cuenta textos distintos, no piezas de vídeo o imagen (la API no las da). Varias variantes sugieren que están testeando o escalando.",
  });

  // 4 · Momentum, con su traza: qué se compara, contra qué fecha y con qué regla.
  const trace = snapshot.momentumTrace;
  const viejo = trace.daysSincePrevious !== null && trace.daysSincePrevious >= MOMENTUM_STALE_DAYS;
  signals.push({
    id: "momentum",
    label: "Momentum",
    value: `${trace.status} · ${trace.reason}`,
    source: "derivada",
    confirmado: false,
    limite: `Regla: ${MOMENTUM_RULE}. ${
      trace.previousCapturedAt === null
        ? "No hay medida anterior: el veredicto no compara nada todavía."
        : `Se compara contra la medida de hace ${trace.daysSincePrevious} día(s)${viejo ? ", que ya es vieja: cuanto más separadas, menos dice el veredicto" : ""}.`
    }`,
  });

  // 5 · Países. La consulta es de UN país por corrida, así que esto solo
  //     puede decir dónde LO HEMOS VISTO nosotros, no dónde anuncia de verdad.
  const paises = input.countriesSeen ?? [];
  signals.push({
    id: "paises_vistos",
    label: "Países en los que lo hemos encontrado",
    value: paises.length ? paises.join(", ") : null,
    source: "derivada",
    confirmado: false,
    limite:
      "cada búsqueda consulta UN país (ad_reached_countries). Esto lista los países en los que hemos buscado y lo hemos encontrado, no su alcance real.",
  });

  // 6 · Dominio declarado.
  const dominios = declaredDomains(snapshot.ads);
  signals.push({
    id: "dominio_declarado",
    label: "Dominio que declara el anuncio",
    value: dominios.length ? dominios.join(", ") : null,
    source: "declarado",
    confirmado: false,
    limite:
      "es el texto del enlace que puso el anunciante (ad_creative_link_captions). No se ha visitado ni resuelto: puede ser una marca y no el dominio real de la tienda.",
  });

  return {
    momentum: trace,
    pageId: snapshot.pageId,
    pageName: snapshot.pageName,
    candidateKey: snapshot.key,
    snapshotUrls: snapshot.ads.map((ad) => ad.snapshotUrl).filter((u): u is string => typeof u === "string").slice(0, 10),
    activeAds: snapshot.activeAds,
    signals,
    noise: snapshot.noise,
    noiseReason: snapshot.noiseReason,
  };
}

/**
 * Lo que esta API NO puede dar, escrito para que nadie lo prometa en una
 * pantalla. Se expone a propósito: es parte del contrato con quien lo lee.
 */
export const NOT_AVAILABLE_FROM_AD_LIBRARY = [
  "gasto publicitario (solo existe para anuncios de temática social o política)",
  "impresiones reales de un anuncio comercial",
  "CTR, conversiones o ventas",
  "el creativo en sí (imagen o vídeo): la API devuelve el enlace a la ficha, no el fichero",
  "el dominio de destino resuelto (solo el que declara el anunciante)",
] as const;
