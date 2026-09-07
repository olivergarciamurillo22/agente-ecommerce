import type Database from "better-sqlite3";
import { systemDbHandle } from "../../db";
import type { DiscoveryGroup, DiscoverySnapshot, Momentum } from "./types";

export class DiscoveryRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}
  saveRun(input: {
    terms: string[]; country: string; days: number; fields: readonly string[]; rawCount: number;
    groups: DiscoveryGroup[]; rateLimit: Record<string, unknown> | null; now: number;
    /** Por que termino la corrida (migracion 28). "completado" si se agotaron los terminos. */
    stopReason?: string;
    /** Peticiones HTTP gastadas contra la Graph API. */
    requests?: number;
  }): DiscoverySnapshot[] {
    const tx = this.db.transaction(() => {
      const query = this.db.prepare(`INSERT INTO adlib_queries(terms_json,country,days,fields_json,result_count,passed_noise_count,group_count,rate_limit_json,queried_at,stop_reason,requests_used) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        JSON.stringify(input.terms), input.country, input.days, JSON.stringify(input.fields), input.rawCount,
        input.groups.filter((g) => !g.noise).length, input.groups.length, input.rateLimit ? JSON.stringify(input.rateLimit) : null, input.now,
        input.stopReason ?? "completado", input.requests ?? null
      );
      const queryId = Number(query.lastInsertRowid); const snapshots: DiscoverySnapshot[] = [];
      for (const group of input.groups) {
        this.db.prepare(`INSERT INTO adlib_candidates(candidate_key,page_id,page_name,fingerprint) VALUES(?,?,?,?) ON CONFLICT(candidate_key) DO UPDATE SET page_name=excluded.page_name,updated_at=unixepoch()`).run(group.key, group.pageId, group.pageName, group.fingerprint);
        const candidate = this.db.prepare("SELECT id FROM adlib_candidates WHERE candidate_key=?").get(group.key) as { id: number };
        // El snapshot anterior NUNCA puede ser de esta misma corrida: si no se
        // excluye query_id, un guardado por lotes compara el momentum contra
        // si mismo y siempre sale "debil".
        const previous = this.db.prepare("SELECT active_ads,captured_at FROM adlib_candidate_snapshots WHERE candidate_id=? AND query_id<>? ORDER BY captured_at DESC,id DESC LIMIT 1").get(candidate.id, queryId) as { active_ads: number; captured_at: number } | undefined;
        let momentum: Momentum = "sin_historico";
        if (previous) momentum = group.activeAds >= 5 && group.activeAds - previous.active_ads >= 2 ? "fuerte" : "debil";
        if (group.activeAds === 0) momentum = "sin_datos";
        // ON CONFLICT: dos grupos que colisionaran en candidate_key ya no
        // tumban la corrida entera con un rollback por UNIQUE.
        this.db.prepare(`INSERT INTO adlib_candidate_snapshots(query_id,candidate_id,captured_at,active_ads,oldest_active_at,momentum,previous_active_ads,noise,noise_reason,ads_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(query_id,candidate_id) DO UPDATE SET active_ads=excluded.active_ads,oldest_active_at=excluded.oldest_active_at,momentum=excluded.momentum,previous_active_ads=excluded.previous_active_ads,noise=excluded.noise,noise_reason=excluded.noise_reason,ads_json=excluded.ads_json`).run(
          queryId, candidate.id, input.now, group.activeAds, group.oldestActiveAt, momentum, previous?.active_ads ?? null, group.noise ? 1 : 0, group.noiseReason, JSON.stringify(group.ads)
        );
        snapshots.push({ ...group, candidateId: candidate.id, momentum, previousActiveAds: previous?.active_ads ?? null });
      }
      return snapshots;
    });
    return tx();
  }

  /**
   * Paises en los que hemos visto a este candidato. La clave lleva el pais
   * delante (PAIS:pageId:huella), asi que basta con mirar las claves que
   * comparten pagina y huella. NO dice donde anuncia de verdad: dice donde
   * hemos buscado y lo hemos encontrado.
   */
  countriesForCandidate(pageId: string, fingerprint: string): string[] {
    const filas = this.db
      .prepare("SELECT DISTINCT candidate_key FROM adlib_candidates WHERE page_id = ? AND fingerprint = ?")
      .all(pageId, fingerprint) as Array<{ candidate_key: string }>;
    const paises = new Set<string>();
    for (const fila of filas) {
      const trozos = fila.candidate_key.split(":");
      // Formato nuevo: PAIS:pageId:huella. El formato viejo (pageId:huella) no
      // lleva pais y se ignora en vez de inventarlo.
      if (trozos.length >= 3 && /^[A-Z]{2}$/.test(trozos[0])) paises.add(trozos[0]);
    }
    return [...paises].sort();
  }
}
