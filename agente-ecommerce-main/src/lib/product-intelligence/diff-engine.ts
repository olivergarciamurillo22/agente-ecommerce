import type { ProductSignal, ProductSnapshot } from "./types";

export interface ProductObservation { productId: string; adIds: string[]; advertiserIds: string[]; snapshot: ProductSnapshot }
export function diffObservations(previous: ProductObservation, current: ProductObservation, now = new Date().toISOString()): Omit<ProductSignal, "id">[] {
  const signals: Omit<ProductSignal, "id">[] = []; const add = (type: ProductSignal["type"], message: string) => signals.push({ productId: current.productId, type, message, createdAt: now });
  const oldAds = new Set(previous.adIds); const newAds = new Set(current.adIds); const oldAdvertisers = new Set(previous.advertiserIds);
  for (const id of current.adIds) if (!oldAds.has(id)) add("NEW_AD", `New ad ${id}`);
  for (const id of previous.adIds) if (!newAds.has(id)) add("REMOVED_AD", `Removed ad ${id}`);
  for (const id of current.advertiserIds) if (!oldAdvertisers.has(id)) add("NEW_ADVERTISER", `New advertiser ${id}`);
  if (current.snapshot.newAds7d >= previous.snapshot.newAds7d + 3) add("CREATIVE_SPIKE", `Creative velocity ${previous.snapshot.newAds7d} → ${current.snapshot.newAds7d}`);
  if (current.snapshot.opportunityScore >= previous.snapshot.opportunityScore + 10) add("SCORE_SPIKE", `Opportunity Score +${current.snapshot.opportunityScore - previous.snapshot.opportunityScore}`);
  if (current.snapshot.opportunityScore <= previous.snapshot.opportunityScore - 10) add("SCORE_DROP", `Opportunity Score ${current.snapshot.opportunityScore - previous.snapshot.opportunityScore}`);
  if (current.snapshot.lifecycle !== previous.snapshot.lifecycle) add("LIFECYCLE_CHANGE", `Lifecycle ${previous.snapshot.lifecycle} → ${current.snapshot.lifecycle}`);
  return signals;
}
