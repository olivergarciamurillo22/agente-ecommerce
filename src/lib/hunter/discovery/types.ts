export const ADLIB_FIELDS = [
  "id", "page_id", "page_name", "ad_snapshot_url", "ad_creation_time",
  "ad_delivery_start_time", "ad_delivery_stop_time", "ad_creative_bodies",
  "ad_creative_link_captions", "ad_creative_link_titles", "publisher_platforms",
  "languages", "impressions", "estimated_audience_size",
  // Descripción del enlace (07-09-2026): texto real del anuncio que el
  // auditor cita como evidencia de ángulos. Si Meta lo rechaza, el sondeo
  // campo a campo lo retira sin invalidar la consulta.
  "ad_creative_link_descriptions",
] as const;

export interface AdLibraryAd {
  id: string; pageId: string; pageName: string | null; snapshotUrl: string | null;
  bodies: string[]; captions: string[]; titles: string[]; platforms: string[]; languages: string[];
  /** ad_creative_link_descriptions. Opcional: los tests antiguos no lo traen. */
  descriptions?: string[];
  creationTime: string | null; startTime: string | null; stopTime: string | null;
  impressions: { lowerBound: number | null; upperBound: number | null } | null;
  audience: { lowerBound: number | null; upperBound: number | null } | null;
}
export interface AdLibraryPage { ads: AdLibraryAd[]; after: string | null; rateLimit: Record<string, unknown> | null }
export interface DiscoveryGroup {
  key: string; pageId: string; pageName: string | null; fingerprint: string; ads: AdLibraryAd[];
  activeAds: number; oldestActiveAt: number | null; noise: boolean; noiseReason: string | null;
}
export type Momentum = "fuerte" | "debil" | "sin_historico" | "sin_datos";

/**
 * El momentum, con TODO lo que hizo falta para calcularlo (07-09-2026).
 * Antes se guardaba solo la palabra "fuerte" o "debil", y en pantalla parecia
 * un veredicto cuando en realidad es una comparacion contra una fecha que no
 * se veia: un "fuerte" contra una corrida de hace dos meses dice muy poco.
 */
export interface MomentumTrace {
  status: Momentum;
  /** Anuncios activos AHORA. */
  activeAds: number;
  /** Anuncios activos la ultima vez que miramos (null = primera vez). */
  previousActiveAds: number | null;
  /** Diferencia entre ambos. Null si no hay con que comparar. */
  delta: number | null;
  /** Cuando se tomo la medida anterior (unixepoch). */
  previousCapturedAt: number | null;
  /** Dias entre aquella medida y esta. Cuanto mayor, menos dice el veredicto. */
  daysSincePrevious: number | null;
  /** La regla aplicada, literal. */
  rule: string;
  /** La frase que se puede leer en pantalla. */
  reason: string;
}

export interface DiscoverySnapshot extends DiscoveryGroup {
  candidateId: number;
  momentum: Momentum;
  previousActiveAds: number | null;
  previousCapturedAt: number | null;
  momentumTrace: MomentumTrace;
}
