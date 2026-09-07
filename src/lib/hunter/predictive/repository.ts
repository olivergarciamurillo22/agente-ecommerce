import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import { HunterRepository } from "../repository";
import type { CandidateFacts, ProductCandidate } from "../types";
import type { PredictiveEstimate } from "./types";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export class PredictiveRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}

  save(estimate: PredictiveEstimate): PredictiveEstimate {
    const result = this.db.prepare(`INSERT INTO hunter_predictive_estimates
      (product_query,competitor_url,search_available,search_mechanism,wholesale_json,retail_json,viability_json,verdict,reason,consulted_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      estimate.productQuery, estimate.competitorUrl, estimate.searchAvailable ? 1 : 0, estimate.searchMechanism,
      JSON.stringify(estimate.wholesale), JSON.stringify(estimate.retail), JSON.stringify(estimate.viability),
      estimate.viability.verdict, estimate.viability.reason, estimate.consultedAt, estimate.expiresAt
    );
    return { ...estimate, id: Number(result.lastInsertRowid), promotedCandidateId: null };
  }

  byId(id: number): PredictiveEstimate | null {
    const row = this.db.prepare("SELECT * FROM hunter_predictive_estimates WHERE id=?").get(id) as Row | undefined;
    return row ? {
      id: Number(row.id), productQuery: String(row.product_query), competitorUrl: row.competitor_url as string | null,
      searchAvailable: row.search_available === 1, searchMechanism: row.search_mechanism as string | null,
      wholesale: parse(row.wholesale_json), retail: parse(row.retail_json), viability: parse(row.viability_json),
      consultedAt: Number(row.consulted_at), expiresAt: Number(row.expires_at),
      promotedCandidateId: row.promoted_candidate_id === null ? null : Number(row.promoted_candidate_id),
    } : null;
  }

  promote(id: number, hunter = new HunterRepository(this.db)): ProductCandidate {
    const estimate = this.byId(id);
    if (!estimate) throw new Error(`No existe la estimacion ${id}`);
    if (!estimate.viability.verdict || estimate.viability.verdict === "descartar") throw new Error("solo se promocionan candidatos fuertes o por investigar");
    const sourceUrl = estimate.competitorUrl ?? estimate.retail.unit?.sources[0]?.sourceUrl ?? estimate.wholesale.at500?.sources[0]?.sourceUrl;
    if (!sourceUrl) throw new Error("la estimacion no tiene una URL fuente promocionable");
    const url = new URL(sourceUrl);
    const facts: CandidateFacts = {
      sourceUrl: url.toString(), sourceDomain: url.hostname, fetchedAt: estimate.consultedAt,
      name: estimate.productQuery, category: null,
      // Nunca se copian estimaciones a los campos confirmados que alimentan el score.
      unitCostEur: null, sourceCurrency: null, sourceCost: null,
      weightGrams: null, lengthCm: null, widthCm: null, heightCm: null, variants: null,
      specs: { predictiveEstimateId: String(id), costStatus: "estimado", pvpStatus: "estimado" }, claims: null,
    };
    const candidate = hunter.upsert(facts);
    this.db.prepare("UPDATE hunter_predictive_estimates SET promoted_candidate_id=? WHERE id=?").run(candidate.id, id);
    return candidate;
  }
}
