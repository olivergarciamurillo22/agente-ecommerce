export const ADLIB_FIELDS = [
  "id", "page_id", "page_name", "ad_snapshot_url", "ad_creation_time",
  "ad_delivery_start_time", "ad_delivery_stop_time", "ad_creative_bodies",
  "ad_creative_link_captions", "ad_creative_link_titles", "publisher_platforms",
  "languages", "impressions", "estimated_audience_size",
] as const;

export interface AdLibraryAd {
  id: string; pageId: string; pageName: string | null; snapshotUrl: string | null;
  bodies: string[]; captions: string[]; titles: string[]; platforms: string[]; languages: string[];
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
export interface DiscoverySnapshot extends DiscoveryGroup { candidateId: number; momentum: Momentum; previousActiveAds: number | null }
