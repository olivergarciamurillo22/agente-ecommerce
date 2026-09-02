import type { Confidence, RawAd } from "./types";

const STOP = new Set(["de", "del", "la", "el", "para", "con", "un", "una", "y"]);
const ALIASES: Record<string, string> = { juanetes: "hallux", juanete: "hallux", valgus: "hallux", ferula: "corrector", férula: "corrector" };
export function productFingerprint(value: string): string[] {
  return value.toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word && !STOP.has(word)).map((word) => ALIASES[word] ?? word).sort();
}
export function clusterSimilarity(a: string, b: string): { score: number; confidence: Confidence } {
  const left = new Set(productFingerprint(a)); const right = new Set(productFingerprint(b));
  const intersection = [...left].filter((word) => right.has(word)).length; const union = new Set([...left, ...right]).size;
  const score = union ? intersection / union : 0;
  return { score, confidence: score >= 0.75 ? "HIGH" : score >= 0.5 ? "MEDIUM" : "LOW" };
}
export function advertiserKey(ad: RawAd): string {
  if (ad.pageId || ad.advertiserId !== "unknown") return `page:${ad.pageId ?? ad.advertiserId}`;
  try { if (ad.landingUrl) return `domain:${new URL(ad.landingUrl).hostname.replace(/^www\./, "")}`; } catch { /* malformed source URL */ }
  return `name:${productFingerprint(ad.advertiserName).join("-")}`;
}
