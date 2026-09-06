// ============================================================
// AI Winner Radar — CONTRATO DE PROVEEDOR DE INTELIGENCIA.
//
// Ningún proveedor implementa todo, y eso es normal: la Ad Library de Meta no
// sabe de costes de proveedor y Dropea no sabe de anuncios. Por eso el
// contrato es de capacidades declaradas, no de métodos obligatorios — quien
// no puede hacer algo lo dice y el orquestador se organiza sin él.
//
// Regla dura: un proveedor JAMÁS lanza. Devuelve `ProviderResult` con `ok:
// false` y el motivo. Que una fuente se caiga no puede tumbar la búsqueda
// entera (§68); baja la confianza, no el resultado.
// ============================================================

import type {
  CapabilityStatus,
  HunterAd,
  ProviderCapability,
  ProviderHealth,
  ProviderId,
} from "../types";

export interface ProviderResult<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  /** Código HTTP cuando lo hubo, para distinguir 401 de 429 de 500. */
  status: number | null;
  /** Llamadas realmente hechas (paginación incluida). */
  calls: number;
  /** Créditos consumidos, si el proveedor los reporta. */
  credits: number | null;
  /** true si salió de caché: no gastó créditos ni red. */
  fromCache: boolean;
}

export function providerOk<T>(data: T, opts: Partial<ProviderResult<T>> = {}): ProviderResult<T> {
  return { ok: true, data, error: null, status: 200, calls: 1, credits: null, fromCache: false, ...opts };
}

export function providerFail<T>(error: string, opts: Partial<ProviderResult<T>> = {}): ProviderResult<T> {
  return { ok: false, data: null, error, status: null, calls: 0, credits: null, fromCache: false, ...opts };
}

export interface AdSearchQuery {
  keywords: string;
  country: string;
  platforms?: string[];
  activeOnly?: boolean;
  minDaysActive?: number;
  limit?: number;
  /**
   * Cuántas páginas recorrer en una sola llamada. Meta devuelve 25 por
   * página aunque pidas 100, y quedarse en la primera hace que un mercado
   * activo parezca muerto.
   */
  pages?: number;
  /** Token opaco de paginación del proveedor. */
  cursor?: string | null;
}

export interface AdSearchResponse {
  ads: HunterAd[];
  nextCursor: string | null;
}

export interface ProductSearchQuery {
  keywords: string;
  country: string;
  limit?: number;
  cursor?: string | null;
}

export interface ExternalProduct {
  externalId: string;
  name: string;
  category: string | null;
  imageUrl: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  /** Métricas que el proveedor ESTIMA. Nunca se presentan como hechos. */
  estimatedSales: number | null;
  shopCount: number | null;
  raw: Record<string, unknown> | null;
}

export interface StoreSearchQuery {
  keywords: string;
  country: string;
  limit?: number;
}

export interface ExternalStore {
  externalId: string;
  name: string;
  domain: string | null;
  platform: string | null;
  raw: Record<string, unknown> | null;
}

export interface TrendQuery {
  keyword: string;
  country?: string;
}

export interface TrendPoint {
  keyword: string;
  /** 0-100 relativo, como lo entrega la fuente. */
  score: number | null;
  direction: "rising" | "flat" | "falling" | null;
  raw: Record<string, unknown> | null;
}

/**
 * Los métodos son OPCIONALES a propósito. `capabilities()` es la fuente de
 * verdad de qué se puede pedir; llamar a un método que el proveedor no
 * implementa devuelve un fallo controlado, nunca una excepción.
 */
export interface IntelligenceProvider {
  readonly id: ProviderId;
  capabilities(): Record<ProviderCapability, CapabilityStatus>;
  health(): Promise<ProviderHealth>;
  searchAds?(q: AdSearchQuery): Promise<ProviderResult<AdSearchResponse>>;
  searchProducts?(q: ProductSearchQuery): Promise<ProviderResult<ExternalProduct[]>>;
  searchStores?(q: StoreSearchQuery): Promise<ProviderResult<ExternalStore[]>>;
  searchTrends?(q: TrendQuery): Promise<ProviderResult<TrendPoint[]>>;
  getAdDetails?(externalId: string): Promise<ProviderResult<HunterAd>>;
  getProductDetails?(externalId: string): Promise<ProviderResult<ExternalProduct>>;
}

/** Todas UNAVAILABLE: base cómoda para declarar solo lo que sí se tiene. */
export function noCapabilities(): Record<ProviderCapability, CapabilityStatus> {
  return {
    META_ADS: "UNAVAILABLE",
    TIKTOK_ADS: "UNAVAILABLE",
    TIKTOK_SHOP: "UNAVAILABLE",
    SHOPIFY_STORES: "UNAVAILABLE",
    TRENDS: "UNAVAILABLE",
    LANDERS: "UNAVAILABLE",
    BRANDS: "UNAVAILABLE",
    SIMILAR_AD_SEARCH: "UNAVAILABLE",
    INTERNAL_METRICS: "UNAVAILABLE",
    SUPPLIER_COST: "UNAVAILABLE",
  };
}
