import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import type { DiscoveryGroup, DiscoverySnapshot, Momentum } from "./types";

export class DiscoveryRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}
  saveRun(input: { terms: string[]; country: string; days: number; fields: readonly string[]; rawCount: number; groups: DiscoveryGroup[]; rateLimit: Record<string, unknown> | null; now: number }): DiscoverySnapshot[] {
    const tx = this.db.transaction(() => {
      const query = this.db.prepare(`INSERT INTO adlib_queries(terms_json,country,days,fields_json,result_count,passed_noise_count,group_count,rate_limit_json,queried_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        JSON.stringify(input.terms), input.country, input.days, JSON.stringify(input.fields), input.rawCount,
        input.groups.filter((g) => !g.noise).length, input.groups.length, input.rateLimit ? JSON.stringify(input.rateLimit) : null, input.now
      );
      const queryId = Number(query.lastInsertRowid); const snapshots: DiscoverySnapshot[] = [];
      for (const group of input.groups) {
        this.db.prepare(`INSERT INTO adlib_candidates(candidate_key,page_id,page_name,fingerprint) VALUES(?,?,?,?) ON CONFLICT(candidate_key) DO UPDATE SET page_name=excluded.page_name,updated_at=unixepoch()`).run(group.key, group.pageId, group.pageName, group.fingerprint);
        const candidate = this.db.prepare("SELECT id FROM adlib_candidates WHERE candidate_key=?").get(group.key) as { id: number };
        const previous = this.db.prepare("SELECT active_ads,captured_at FROM adlib_candidate_snapshots WHERE candidate_id=? ORDER BY captured_at DESC,id DESC LIMIT 1").get(candidate.id) as { active_ads: number; captured_at: number } | undefined;
        let momentum: Momentum = "sin_historico";
        if (previous) momentum = group.activeAds >= 5 && group.activeAds - previous.active_ads >= 2 ? "fuerte" : "debil";
        if (group.activeAds === 0) momentum = "sin_datos";
        this.db.prepare(`INSERT INTO adlib_candidate_snapshots(query_id,candidate_id,captured_at,active_ads,oldest_active_at,momentum,previous_active_ads,noise,noise_reason,ads_json) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          queryId, candidate.id, input.now, group.activeAds, group.oldestActiveAt, momentum, previous?.active_ads ?? null, group.noise ? 1 : 0, group.noiseReason, JSON.stringify(group.ads)
        );
        snapshots.push({ ...group, candidateId: candidate.id, momentum, previousActiveAds: previous?.active_ads ?? null });
      }
      return snapshots;
    });
    return tx();
  }
}
