import crypto from "node:crypto";
import type { AdLibraryAd, DiscoveryGroup } from "./types";

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (ad: AdLibraryAd) => new Set(normalize([...ad.captions, ...ad.bodies, ...ad.titles].join(" ")).split(" ").filter((x) => x.length > 2));
function similarity(a: Set<string>, b: Set<string>): number { if (!a.size || !b.size) return 0; const common = [...a].filter((x) => b.has(x)).length; return common / new Set([...a, ...b]).size; }
const active = (ad: AdLibraryAd, now: number) => !ad.stopTime || Date.parse(ad.stopTime) / 1000 >= now - 86400;
const NON_PRODUCT = /\b(app|software|curso|formacion|seguro|hipoteca|consultoria|servicio|webinar|suscripcion|empleo)\b/i;

function noiseOf(ads: AdLibraryAd[]): { noise: boolean; noiseReason: string | null } {
  const text = ads.flatMap((ad) => [...ad.captions, ...ad.bodies, ...ad.titles]).join(" ");
  if (!text.trim()) return { noise: true, noiseReason: "sin texto comercial para identificar un producto fisico" };
  if (NON_PRODUCT.test(normalize(text))) return { noise: true, noiseReason: "heuristica: anuncio de servicio, app o contenido" };
  const maxAudience = Math.max(0, ...ads.map((ad) => ad.audience?.upperBound ?? 0));
  if (maxAudience >= 1_000_000) return { noise: true, noiseReason: "heuristica: audiencia estimada >= 1.000.000 (marca establecida posible)" };
  return { noise: false, noiseReason: null };
}

export function groupAds(ads: AdLibraryAd[], now = Math.floor(Date.now() / 1000)): DiscoveryGroup[] {
  const groups: Array<{ pageId: string; pageName: string | null; seed: Set<string>; ads: AdLibraryAd[] }> = [];
  for (const ad of ads) {
    const candidate = groups.find((g) => g.pageId === ad.pageId && similarity(g.seed, tokens(ad)) >= 0.55);
    if (candidate) candidate.ads.push(ad); else groups.push({ pageId: ad.pageId, pageName: ad.pageName, seed: tokens(ad), ads: [ad] });
  }
  return groups.map((group) => {
    const fingerprintText = [...group.seed].sort().slice(0, 30).join(" ");
    const fingerprint = crypto.createHash("sha256").update(fingerprintText || group.ads[0].id).digest("hex").slice(0, 16);
    const current = group.ads.filter((ad) => active(ad, now));
    const starts = current.map((ad) => ad.startTime ? Date.parse(ad.startTime) / 1000 : NaN).filter(Number.isFinite);
    return { key: `${group.pageId}:${fingerprint}`, pageId: group.pageId, pageName: group.pageName, fingerprint, ads: group.ads,
      activeAds: current.length, oldestActiveAt: starts.length ? Math.min(...starts) : null, ...noiseOf(group.ads) };
  });
}
