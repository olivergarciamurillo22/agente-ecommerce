import type { MomentumComponents, MomentumStatus, ProductSnapshot } from "./types";

export interface MomentumResult { status: MomentumStatus; score: number; components: MomentumComponents }

export function calculateMomentum(current: Pick<ProductSnapshot, "activeAds" | "totalAds" | "newAds7d">, previous?: ProductSnapshot, now = Date.now()): MomentumResult {
  const currentTotal = current.totalAds ?? current.activeAds;
  if (!previous) return {
    status: "SIN_HISTORICO",
    score: 0,
    components: { deltaActiveAds: 0, deltaCreatives: 0, newAds: 0, removedAds: 0, oldAdsStillActive: current.activeAds, daysBetweenSnapshots: 0 },
  };
  const previousTotal = previous.totalAds ?? previous.activeAds;
  const deltaActiveAds = current.activeAds - previous.activeAds;
  const deltaCreatives = currentTotal - previousTotal;
  const newAds = Math.max(0, deltaCreatives, current.newAds7d - previous.newAds7d);
  const removedAds = Math.max(0, -deltaCreatives, previous.activeAds - current.activeAds);
  const oldAdsStillActive = Math.min(previous.activeAds, current.activeAds);
  const daysBetweenSnapshots = Math.max(0, Math.round((now - new Date(previous.capturedAt).getTime()) / 86400000 * 10) / 10);
  const components = { deltaActiveAds, deltaCreatives, newAds, removedAds, oldAdsStillActive, daysBetweenSnapshots };
  if (current.activeAds >= 5 && deltaActiveAds >= 2 && newAds >= 2 && oldAdsStillActive > 0) return { status: "STRONG_GROWTH", score: 85, components };
  if (deltaActiveAds > 0 || newAds > 0) return { status: "GROWTH", score: 65, components };
  if (deltaActiveAds < 0 || removedAds > 0) return { status: "DECLINING", score: 10, components };
  return { status: "STABLE", score: 40, components };
}
