// ============================================================
// AI Winner Radar — NORMALIZACIÓN Y HUELLAS.
//
// Convierte lo que devuelve cada proveedor en un `HunterAd` con la misma
// forma, y calcula la huella que permite reconocer el MISMO anuncio llegando
// por dos fuentes distintas (§67). Sin esto, un anuncio visto en
// WinningHunter y en la Ad Library cuenta dos veces y todas las señales de
// volumen quedan infladas — exactamente el error que hace parecer ganador a
// un producto mediocre.
// ============================================================

import { createHash } from "node:crypto";
import type { AdFormat, AdPlatform, HunterAd, ProviderId } from "./types";

export interface RawAdInput {
  provider: ProviderId;
  externalId: string;
  platform: string | null;
  advertiserName: string | null;
  advertiserExternalId: string | null;
  productName: string | null;
  adCopy: string | null;
  format: string | null;
  countries: string[];
  startedAt: string | number | null;
  lastSeenAt: string | number | null;
  active: boolean | null;
  activeDays: number | null;
  landingUrl: string | null;
  previewUrl: string | null;
  imageUrl: string | null;
  creativeIds: string[];
  priceAmount: number | null;
  priceCurrency: string | null;
  raw: Record<string, unknown> | null;
}

export function normalizeExternalAd(input: RawAdInput): HunterAd {
  const startedAt = toEpoch(input.startedAt);
  const lastSeenAt = toEpoch(input.lastSeenAt);
  const activeDays = input.activeDays ?? deriveActiveDays(startedAt, lastSeenAt, input.active);

  return {
    id: `${input.provider}:${input.externalId}`,
    provider: input.provider,
    externalId: input.externalId,
    platform: normalizePlatform(input.platform),
    advertiserName: clean(input.advertiserName),
    advertiserExternalId: clean(input.advertiserExternalId),
    productNameRaw: clean(input.productName),
    adCopy: clean(input.adCopy),
    format: normalizeFormat(input.format),
    countries: input.countries.map((c) => c.trim().toUpperCase()).filter(Boolean),
    startedAt,
    lastSeenAt,
    active: input.active,
    activeDays,
    landingUrl: normalizeUrl(input.landingUrl),
    previewUrl: clean(input.previewUrl),
    imageUrl: clean(input.imageUrl),
    creativeExternalIds: input.creativeIds.filter(Boolean),
    priceObserved:
      input.priceAmount !== null && Number.isFinite(input.priceAmount)
        ? { amount: input.priceAmount, currency: (input.priceCurrency ?? "EUR").toUpperCase() }
        : null,
    fingerprint: adFingerprint({
      advertiser: input.advertiserName,
      landingUrl: input.landingUrl,
      copy: input.adCopy,
      productName: input.productName,
    }),
    raw: input.raw,
  };
}

/**
 * Huella de un anuncio. Deliberadamente NO incluye el id del proveedor: dos
 * fuentes que describen el mismo anuncio deben producir la misma huella, que
 * es justo lo que permite no contarlo dos veces.
 *
 * Se construye con anunciante + dominio de la landing + un extracto
 * normalizado del copy. El dominio (no la URL entera) porque los parámetros
 * UTM cambian entre fuentes y harían distinto lo que es igual.
 */
export function adFingerprint(input: {
  advertiser: string | null;
  landingUrl: string | null;
  copy: string | null;
  productName: string | null;
}): string {
  const advertiser = normalizeText(input.advertiser ?? "");
  const domain = extractDomain(input.landingUrl);
  const copyHead = normalizeText(input.copy ?? "").slice(0, 120);
  const name = normalizeText(input.productName ?? "");
  const seed = [advertiser, domain, copyHead || name].filter(Boolean).join("|");
  return createHash("sha1").update(seed || `sinhuella:${Math.random()}`).digest("hex").slice(0, 20);
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractDomain(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeUrl(url: string | null): string | null {
  const c = clean(url);
  if (!c) return null;
  try {
    const u = new URL(c.startsWith("http") ? c : `https://${c}`);
    // Fuera parámetros de campaña: son ruido y rompen la comparación.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ttclid|msclkid)/i.test(p)) u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return c;
  }
}

function clean(s: string | null): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

export function normalizePlatform(p: string | null): AdPlatform {
  const n = (p ?? "").toLowerCase();
  if (n.includes("instagram")) return "instagram";
  if (n.includes("tiktok")) return "tiktok";
  if (n.includes("facebook") || n.includes("meta")) return "facebook";
  return "other";
}

export function normalizeFormat(f: string | null): AdFormat | null {
  if (!f) return null;
  const n = f.toLowerCase();
  if (n.includes("video")) return "video";
  if (n.includes("carousel") || n.includes("carrusel")) return "carousel";
  if (n.includes("image") || n.includes("photo") || n.includes("imagen")) return "image";
  return "other";
}

/** Acepta epoch (s o ms) e ISO. Devuelve epoch en segundos o `null`. */
export function toEpoch(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  const s = v.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return toEpoch(Number(s));
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Días activo cuando el proveedor no lo da. Si el anuncio sigue vivo se mide
 * hasta hoy; si paró, hasta la última vez que se vio. Sin fecha de inicio no
 * se estima nada: `null`.
 */
function deriveActiveDays(startedAt: number | null, lastSeenAt: number | null, active: boolean | null): number | null {
  if (startedAt === null) return null;
  const end = active === false && lastSeenAt !== null ? lastSeenAt : Math.floor(Date.now() / 1000);
  const days = Math.floor((end - startedAt) / 86400);
  return days >= 0 ? days : null;
}
