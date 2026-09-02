import crypto from "node:crypto";
import path from "node:path";
import type { ProductSignal, ProductSnapshot, ProviderStatus, WatchlistItem, WatchlistStatus } from "./types";
import { intelligenceDataDir, readJsonRecovering, writeJsonAtomic } from "./persistence";

interface IntelligenceState { provider?: ProviderStatus; snapshots: ProductSnapshot[]; signals: ProductSignal[]; watchlist: WatchlistItem[] }
const empty = (): IntelligenceState => ({ snapshots: [], signals: [], watchlist: [] });
function statePath() { return path.join(intelligenceDataDir(), "product-intelligence-state.json"); }
function read(): IntelligenceState { return { ...empty(), ...readJsonRecovering(statePath(), empty) }; }
function write(state: IntelligenceState) { writeJsonAtomic(statePath(), state); }

export function getProviderHealth(): ProviderStatus | undefined { return read().provider; }
export function saveProviderHealth(provider: ProviderStatus) { const state = read(); state.provider = provider; write(state); }
export function listSignals(): ProductSignal[] { return read().signals; }
export function listWatchlist(): WatchlistItem[] { return read().watchlist; }
export function setWatchlist(productId: string, status: WatchlistStatus): WatchlistItem {
  const state = read(); const now = new Date().toISOString(); const previous = state.watchlist.find((item) => item.productId === productId);
  const item = { productId, status, addedAt: previous?.addedAt ?? now, updatedAt: now }; state.watchlist = state.watchlist.filter((entry) => entry.productId !== productId).concat(item); write(state); return item;
}
export function removeWatchlist(productId: string) { const state = read(); state.watchlist = state.watchlist.filter((item) => item.productId !== productId); write(state); }

export function appendSnapshot(snapshot: Omit<ProductSnapshot, "id" | "capturedAt">): ProductSnapshot {
  const state = read(); const current: ProductSnapshot = { ...snapshot, id: crypto.randomUUID(), capturedAt: new Date().toISOString() };
  const previous = [...state.snapshots].reverse().find((item) => item.productId === current.productId);
  state.snapshots.push(current);
  if (previous) {
    const events: Array<[ProductSignal["type"], boolean, string]> = [
      ["NEW_ADVERTISER", current.advertisers > previous.advertisers, `New advertiser: ${previous.advertisers} → ${current.advertisers}`],
      ["CREATIVE_SPIKE", current.newAds7d >= previous.newAds7d + 3, `Creative spike: ${previous.newAds7d} → ${current.newAds7d}`],
      ["SCORE_SPIKE", current.opportunityScore >= previous.opportunityScore + 10, `Opportunity Score +${current.opportunityScore - previous.opportunityScore}`],
      ["SCORE_DROP", current.opportunityScore <= previous.opportunityScore - 10, `Opportunity Score ${current.opportunityScore - previous.opportunityScore}`],
      ["LIFECYCLE_CHANGE", current.lifecycle !== previous.lifecycle, `Lifecycle ${previous.lifecycle} → ${current.lifecycle}`],
    ];
    for (const [type, applies, message] of events) if (applies) state.signals.push({ id: crypto.randomUUID(), productId: current.productId, type, createdAt: current.capturedAt, message });
  }
  write(state); return current;
}
export function listSnapshots(productId?: string): ProductSnapshot[] { const values = read().snapshots; return productId ? values.filter((item) => item.productId === productId) : values; }
export function resetTestFixtureState(productIds: string[]) { const ids = new Set(productIds); const state = read(); state.snapshots = state.snapshots.filter((item) => !ids.has(item.productId)); state.signals = state.signals.filter((item) => !ids.has(item.productId)); state.watchlist = state.watchlist.filter((item) => !ids.has(item.productId)); write(state); }
