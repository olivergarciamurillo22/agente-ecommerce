// ============================================================
// AI Winner Radar — SEÑALES A PARTIR DE LOS ANUNCIOS.
//
// Todo lo de aquí se CUENTA, no se interpreta. Es la frontera del módulo:
// por debajo hay hechos observados, por encima empiezan las puntuaciones.
// Mantenerla limpia es lo que permite decir en la ficha "14 anunciantes"
// como hecho y "alta inversión creativa" como lectura.
//
// `now` entra por parámetro para que los tests fijen el momento: una función
// que lee el reloj por dentro no se puede testear en serio.
// ============================================================

import { emptySignals, type HunterAd, type ProductSignals } from "./types";

const DAY = 86400;

export function computeSignals(ads: HunterAd[], nowSec = Math.floor(Date.now() / 1000)): ProductSignals {
  if (ads.length === 0) return emptySignals();

  const anunciantes = new Map<string, HunterAd[]>();
  for (const ad of ads) {
    const clave = ad.advertiserExternalId ?? ad.advertiserName ?? ad.id;
    const arr = anunciantes.get(clave) ?? [];
    arr.push(ad);
    anunciantes.set(clave, arr);
  }

  const activos = ads.filter((a) => a.active !== false);
  const paises = new Set<string>();
  const plataformas = new Set<string>();
  const creatividades = new Set<string>();
  for (const ad of ads) {
    for (const c of ad.countries) paises.add(c);
    plataformas.add(ad.platform);
    // Un anuncio sin ids de creatividad cuenta como UNA: es lo que se ve.
    if (ad.creativeExternalIds.length === 0) creatividades.add(ad.id);
    else for (const c of ad.creativeExternalIds) creatividades.add(`${ad.provider}:${c}`);
  }

  const desde = (dias: number) => nowSec - dias * DAY;
  const nuevosDesde = (dias: number) => ads.filter((a) => a.startedAt !== null && a.startedAt >= desde(dias)).length;
  const hayFechas = ads.some((a) => a.startedAt !== null);

  const anunciantesNuevos = (dias: number): number | null => {
    if (!hayFechas) return null;
    let n = 0;
    for (const grupo of anunciantes.values()) {
      const primero = grupo.reduce<number | null>((min, a) => {
        if (a.startedAt === null) return min;
        return min === null || a.startedAt < min ? a.startedAt : min;
      }, null);
      if (primero !== null && primero >= desde(dias)) n += 1;
    }
    return n;
  };

  const diasActivos = ads
    .map((a) => a.activeDays)
    .filter((d): d is number => d !== null && Number.isFinite(d));

  const conteos = [...anunciantes.values()].map((g) => g.length);
  const mayor = conteos.length > 0 ? Math.max(...conteos) : 0;

  const creativasNuevas = hayFechas
    ? ads.filter((a) => a.startedAt !== null && a.startedAt >= desde(7)).reduce((s, a) => s + Math.max(1, a.creativeExternalIds.length), 0)
    : null;

  return {
    advertiserCount: anunciantes.size,
    activeAds: activos.length,
    totalAds: ads.length,
    creativeCount: creatividades.size,
    oldestActiveAdDays: diasActivos.length > 0 ? Math.max(...diasActivos) : null,
    // Sin fechas no se cuenta lo "nuevo": sería contar todo como nuevo.
    newAds7d: hayFechas ? nuevosDesde(7) : null,
    newAds14d: hayFechas ? nuevosDesde(14) : null,
    newAdvertisers7d: anunciantesNuevos(7),
    newAdvertisers14d: anunciantesNuevos(14),
    countryCount: paises.size,
    platformCount: plataformas.size,
    topAdvertiserShare: ads.length > 0 ? mayor / ads.length : null,
    creativesPerAdvertiser: anunciantes.size > 0 ? creatividades.size / anunciantes.size : null,
    newCreatives7d: creativasNuevas,
  };
}

/** Rango de precios observado. `null` si ningún anuncio traía precio. */
export function observedPriceRange(ads: HunterAd[]): { min: number | null; max: number | null; currency: string } {
  const precios = ads.map((a) => a.priceObserved).filter((p): p is { amount: number; currency: string } => p !== null);
  if (precios.length === 0) return { min: null, max: null, currency: "EUR" };
  const montos = precios.map((p) => p.amount).filter((n) => Number.isFinite(n) && n > 0);
  if (montos.length === 0) return { min: null, max: null, currency: precios[0].currency };
  return { min: Math.min(...montos), max: Math.max(...montos), currency: precios[0].currency };
}

/** Primera y última vez que se vio el producto. */
export function seenRange(ads: HunterAd[]): { firstSeenAt: number | null; lastSeenAt: number | null } {
  const inicios = ads.map((a) => a.startedAt).filter((n): n is number => n !== null);
  const finales = ads.map((a) => a.lastSeenAt ?? a.startedAt).filter((n): n is number => n !== null);
  return {
    firstSeenAt: inicios.length > 0 ? Math.min(...inicios) : null,
    lastSeenAt: finales.length > 0 ? Math.max(...finales) : null,
  };
}

/**
 * Deduplica por huella (§67). Cuando el mismo anuncio llega por dos fuentes
 * se conserva el que trae MÁS información, no el primero: si WinningHunter
 * trae la landing y Meta no, quedarse con el de Meta pierde el dato.
 */
export function dedupeAds(ads: HunterAd[]): { ads: HunterAd[]; removed: number } {
  const porHuella = new Map<string, HunterAd>();
  for (const ad of ads) {
    const previo = porHuella.get(ad.fingerprint);
    if (!previo || richness(ad) > richness(previo)) porHuella.set(ad.fingerprint, ad);
  }
  return { ads: [...porHuella.values()], removed: ads.length - porHuella.size };
}

function richness(ad: HunterAd): number {
  let n = 0;
  if (ad.landingUrl) n += 2;
  if (ad.adCopy) n += 2;
  if (ad.productNameRaw) n += 2;
  if (ad.imageUrl) n += 1;
  if (ad.priceObserved) n += 2;
  if (ad.startedAt !== null) n += 1;
  if (ad.activeDays !== null) n += 1;
  n += ad.creativeExternalIds.length;
  return n;
}
