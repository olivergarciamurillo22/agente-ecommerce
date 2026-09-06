import { ADLIB_FIELDS } from "./types";
import { AdLibraryClient, probeAdLibraryFields } from "./client";
import { groupAds } from "./grouping";
import { DiscoveryRepository } from "./repository";
import type { DiscoverySnapshot } from "./types";

/** Puente explicito hacia el Hunter predictivo; no calcula economia aqui. */
export function predictiveInputFor(snapshot: DiscoverySnapshot): { productQuery: string; sourceAdUrl: string | null } | null {
  if (snapshot.noise || snapshot.momentum !== "fuerte") return null;
  const ad = snapshot.ads[0];
  const text = [...ad.titles, ...ad.captions, snapshot.pageName ?? ""].map((value) => value.trim()).find(Boolean);
  return text ? { productQuery: text.slice(0, 200), sourceAdUrl: ad.snapshotUrl } : null;
}

export async function runDiscovery(input: { terms: string[]; country: string; days: number; token: string; now?: number; client?: AdLibraryClient; repository?: DiscoveryRepository }) {
  const now = input.now ?? Math.floor(Date.now() / 1000); const until = new Date(now * 1000).toISOString().slice(0, 10);
  const since = new Date((now - input.days * 86400) * 1000).toISOString().slice(0, 10); const client = input.client ?? new AdLibraryClient(input.token);
  const fieldProbes = await probeAdLibraryFields(client, { term: input.terms[0], country: input.country, since, until });
  const fields = fieldProbes.filter((field) => field.status !== "error").map((field) => field.field);
  if (!fields.includes("id")) fields.unshift("id"); if (!fields.includes("page_id")) fields.unshift("page_id");
  const all = []; let rateLimit: Record<string, unknown> | null = null;
  for (const term of input.terms) {
    const result = await client.search({ term, country: input.country, since, until, fields }); all.push(...result.ads); rateLimit = result.rateLimit ?? rateLimit;
  }
  const unique = [...new Map(all.map((ad) => [ad.id, ad])).values()]; const groups = groupAds(unique, now);
  const snapshots = (input.repository ?? new DiscoveryRepository()).saveRun({ terms: input.terms, country: input.country, days: input.days, fields: ADLIB_FIELDS, rawCount: unique.length, groups, rateLimit, now });
  return { snapshots, rawCount: unique.length, groupCount: groups.length, passedNoiseCount: groups.filter((g) => !g.noise).length, rateLimit, fieldProbes };
}
