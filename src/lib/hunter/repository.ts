import type Database from "better-sqlite3";
import { systemDbHandle } from "../db";
import { missingScoreReasons, scoreCandidate } from "./scoring";
import type { CandidateFacts, CandidateScore, CandidateState, ProductCandidate, ScoreReason, Verdict } from "./types";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

function fromRow(row: Row): ProductCandidate {
  const scoring: CandidateScore | null = row.score === null ? null : {
    shippingTier: row.tramo_envio as "hasta_1kg" | "hasta_4kg",
    shippingEur: Number(row.envio_eur), proposedPriceEur: Number(row.pvp_propuesto_eur),
    unitMarginEur: Number(row.margen_unitario_eur), maxCpaEur: Number(row.cpa_maximo_eur),
    breakEvenDeliveryPct: Number(row.break_even_entrega_pct), score: Number(row.score),
    verdict: row.veredicto as Verdict,
    reasons: parse<ScoreReason[]>(row.motivos_json, []),
  };
  return {
    id: Number(row.id), sourceUrl: String(row.source_url), sourceDomain: String(row.source_domain),
    fetchedAt: row.fetched_at === null ? null : Number(row.fetched_at), name: row.nombre_limpio as string | null,
    category: row.categoria as string | null, unitCostEur: row.coste_unitario_eur as number | null,
    sourceCurrency: row.moneda_origen as string | null, sourceCost: row.coste_origen as number | null,
    weightGrams: row.peso_gramos as number | null, lengthCm: row.largo_cm as number | null,
    widthCm: row.ancho_cm as number | null, heightCm: row.alto_cm as number | null,
    variants: parse<string[] | null>(row.variantes_json, null), specs: parse<Record<string,string> | null>(row.specs_json, null),
    claims: parse<string[] | null>(row.claims_json, null), state: row.estado as CandidateState,
    manualNote: row.nota_manual as string | null, scoring, reasons: parse<ScoreReason[]>(row.motivos_json, []),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export class HunterRepository {
  constructor(private readonly db: Database.Database = systemDbHandle()) {}

  upsert(f: CandidateFacts): ProductCandidate {
    this.db.prepare(`INSERT INTO product_candidates
      (source_url,source_domain,fetched_at,nombre_limpio,categoria,coste_unitario_eur,moneda_origen,coste_origen,
       peso_gramos,largo_cm,ancho_cm,alto_cm,variantes_json,specs_json,claims_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_url) DO UPDATE SET source_domain=excluded.source_domain,fetched_at=excluded.fetched_at,
       nombre_limpio=excluded.nombre_limpio,categoria=excluded.categoria,coste_unitario_eur=excluded.coste_unitario_eur,
       moneda_origen=excluded.moneda_origen,coste_origen=excluded.coste_origen,peso_gramos=excluded.peso_gramos,
       largo_cm=excluded.largo_cm,ancho_cm=excluded.ancho_cm,alto_cm=excluded.alto_cm,
       variantes_json=excluded.variantes_json,specs_json=excluded.specs_json,claims_json=excluded.claims_json,
       updated_at=unixepoch()`).run(f.sourceUrl,f.sourceDomain,f.fetchedAt,f.name,f.category,f.unitCostEur,
       f.sourceCurrency,f.sourceCost,f.weightGrams,f.lengthCm,f.widthCm,f.heightCm,
       f.variants ? JSON.stringify(f.variants) : null,f.specs ? JSON.stringify(f.specs) : null,
       f.claims ? JSON.stringify(f.claims) : null);
    const item = this.byUrl(f.sourceUrl)!;
    this.event(item.id,"ingesta",null,item.state,null,item.scoring?.score ?? null,{ sourceUrl:f.sourceUrl });
    return item;
  }

  byUrl(url: string): ProductCandidate | null { const row=this.db.prepare("SELECT * FROM product_candidates WHERE source_url=?").get(url) as Row|undefined; return row?fromRow(row):null; }
  byId(id: number): ProductCandidate | null { const row=this.db.prepare("SELECT * FROM product_candidates WHERE id=?").get(id) as Row|undefined; return row?fromRow(row):null; }
  list(): ProductCandidate[] { return (this.db.prepare("SELECT * FROM product_candidates ORDER BY score IS NULL, score DESC, updated_at DESC").all() as Row[]).map(fromRow); }

  score(id: number): ProductCandidate {
    const before=this.byId(id); if(!before) throw new Error(`No existe el candidato ${id}`);
    const result=scoreCandidate(before,before.manualNote); const reasons=result?.reasons ?? missingScoreReasons(before);
    this.db.prepare(`UPDATE product_candidates SET tramo_envio=?,envio_eur=?,pvp_propuesto_eur=?,margen_unitario_eur=?,
      cpa_maximo_eur=?,break_even_entrega_pct=?,score=?,veredicto=?,motivos_json=?,updated_at=unixepoch() WHERE id=?`)
      .run(result?.shippingTier??null,result?.shippingEur??null,result?.proposedPriceEur??null,result?.unitMarginEur??null,
        result?.maxCpaEur??null,result?.breakEvenDeliveryPct??null,result?.score??null,result?.verdict??null,JSON.stringify(reasons),id);
    this.event(id,"scoring",before.state,before.state,before.scoring?.score??null,result?.score??null,{ reasons });
    return this.byId(id)!;
  }

  setState(id:number,state:CandidateState,note:string|null=null):ProductCandidate {
    const before=this.byId(id); if(!before) throw new Error(`No existe el candidato ${id}`);
    this.db.prepare("UPDATE product_candidates SET estado=?,nota_manual=COALESCE(?,nota_manual),updated_at=unixepoch() WHERE id=?").run(state,note,id);
    this.event(id,"estado",before.state,state,before.scoring?.score??null,before.scoring?.score??null,{ note }); return this.byId(id)!;
  }
  private event(id:number,type:string,prev:CandidateState|null,next:CandidateState|null,prevScore:number|null,nextScore:number|null,details:unknown){
    this.db.prepare(`INSERT INTO candidate_events(candidate_id,event_type,previous_state,next_state,previous_score,next_score,details_json) VALUES(?,?,?,?,?,?,?)`).run(id,type,prev,next,prevScore,nextScore,JSON.stringify(details));
  }
}
