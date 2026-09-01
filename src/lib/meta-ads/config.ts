// ============================================================
// Configuración de Meta Ads (Marketing API) — READ-ONLY por diseño.
//
// Esta integración SOLO lee insights (ads_read). No gestiona campañas, no
// toca presupuestos, no crea anuncios: no existe ninguna función de
// escritura en todo el módulo.
//
// El token es INDEPENDIENTE del de WhatsApp Cloud API: un token de WhatsApp
// no tiene por qué llevar ads_read, y mezclarlos invita a romper una
// integración al rotar la otra.
// ============================================================

/**
 * Versión de la Graph/Marketing API. Verificada contra el changelog oficial
 * de Meta el 01-09-2026: la vigente es v26.0 (publicada el 29-07-2026).
 * Centralizada aquí; el doctor avisa si el env fija una versión antigua.
 */
export const META_ADS_DEFAULT_API_VERSION = "v26.0";

export interface MetaAdsConfig {
  accessToken: string;
  /** Id numérico de la cuenta publicitaria (sin el prefijo act_). */
  accountId: string;
  apiVersion: string;
  baseUrl: string;
}

export function metaAdsApiVersion(): string {
  const v = (process.env.META_ADS_API_VERSION ?? "").trim();
  return /^v\d+\.\d+$/.test(v) ? v : META_ADS_DEFAULT_API_VERSION;
}

export function metaAdsConfig(): MetaAdsConfig | null {
  const accessToken = (process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  const cuenta = (process.env.META_ADS_ACCOUNT_ID ?? "").trim().replace(/^act_/, "");
  if (!accessToken || !cuenta) return null;
  return {
    accessToken,
    accountId: cuenta,
    apiVersion: metaAdsApiVersion(),
    baseUrl: "https://graph.facebook.com",
  };
}

export function metaAdsCredentialsPresent(): boolean {
  return metaAdsConfig() !== null;
}

/**
 * Sin flag de encendido aparte: con token + cuenta presentes, la lectura
 * está disponible (no hay nada peligroso que abrir — todo es GET). Quitar
 * las dos variables la apaga por completo.
 */
export function metaAdsEnabled(): boolean {
  return metaAdsCredentialsPresent();
}

/** ¿La versión configurada va por detrás de la vigente conocida? */
export function metaAdsVersionLagging(): boolean {
  const parse = (v: string) => parseFloat(v.replace(/^v/, ""));
  return parse(metaAdsApiVersion()) < parse(META_ADS_DEFAULT_API_VERSION);
}
