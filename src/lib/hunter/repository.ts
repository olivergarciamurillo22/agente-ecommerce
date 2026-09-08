import type Database from "better-sqlite3";
import { systemDbHandle } from "../db";
import { missingScoreReasons, scoreCandidate } from "./scoring";
import type { CandidateFacts, CandidateScore, CandidateState, ProductCandidate, ScoreReason, ShippingTier, Verdict } from "./types";

type Row = Record<string, unknown>;
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

function fromRow(row: Row): ProductCandidate {
  const scoring: CandidateScore | null = row.score === null ? null : {
    shippingTier: row.tramo_envio as ShippingTier,
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
    salePriceEur: row.pvp_entrada_eur as number | null,
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
      (source_url,source_domain,fetched_at,nombre_limpio,categoria,coste_unitario_eur,pvp_entrada_eur,moneda_origen,coste_origen,
       peso_gramos,largo_cm,ancho_cm,alto_cm,variantes_json,specs_json,claims_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_url) DO UPDATE SET source_domain=excluded.source_domain,fetched_at=excluded.fetched_at,
       nombre_limpio=excluded.nombre_limpio,categoria=excluded.categoria,coste_unitario_eur=excluded.coste_unitario_eur,pvp_entrada_eur=excluded.pvp_entrada_eur,
       moneda_origen=excluded.moneda_origen,coste_origen=excluded.coste_origen,peso_gramos=excluded.peso_gramos,
       largo_cm=excluded.largo_cm,ancho_cm=excluded.ancho_cm,alto_cm=excluded.alto_cm,
       variantes_json=excluded.variantes_json,specs_json=excluded.specs_json,claims_json=excluded.claims_json,
       updated_at=unixepoch()`).run(f.sourceUrl,f.sourceDomain,f.fetchedAt,f.name,f.category,f.unitCostEur,f.salePriceEur??null,
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
  setSalePrice(id:number,salePriceEur:number):ProductCandidate {
    const before=this.byId(id);if(!before)throw new Error(`No existe el candidato ${id}`);
    if(!Number.isFinite(salePriceEur)||salePriceEur<=0)throw new Error("El precio de venta debe ser mayor que cero");
    this.db.prepare("UPDATE product_candidates SET pvp_entrada_eur=?,score=NULL,motivos_json=NULL,updated_at=unixepoch() WHERE id=?").run(salePriceEur,id);
    this.event(id,"precio_venta",before.state,before.state,before.scoring?.score??null,null,{salePriceEur});return this.score(id);
  }
  /**
   * Hechos manuales (F3, 08-09-2026): coste, PVP, peso y medidas que Pedro
   * teclea porque la fuente no los da (Dropi/Dropea: catálogo privado). Solo
   * se tocan los campos que llegan; los demás se conservan. Queda constancia
   * del ORIGEN humano en nota_manual y en candidate_events, para que después
   * se pueda auditar qué dato es scrapeado y cuál es de Pedro.
   * Invalida el score (se recalcula con score()).
   */
  setFacts(id:number,facts:{unitCostEur?:number|null;salePriceEur?:number|null;weightGrams?:number|null;lengthCm?:number|null;widthCm?:number|null;heightCm?:number|null},origin:"manual"|"dropea"="manual"):ProductCandidate {
    const before=this.byId(id); if(!before) throw new Error(`No existe el candidato ${id}`);
    const cols:Array<[string,number|null]>=[];
    const given=(v:unknown):v is number|null=>v!==undefined;
    if(given(facts.unitCostEur))cols.push(["coste_unitario_eur",facts.unitCostEur]);
    if(given(facts.salePriceEur))cols.push(["pvp_entrada_eur",facts.salePriceEur]);
    if(given(facts.weightGrams))cols.push(["peso_gramos",facts.weightGrams]);
    if(given(facts.lengthCm))cols.push(["largo_cm",facts.lengthCm]);
    if(given(facts.widthCm))cols.push(["ancho_cm",facts.widthCm]);
    if(given(facts.heightCm))cols.push(["alto_cm",facts.heightCm]);
    for(const [,v] of cols) if(v!==null&&(!Number.isFinite(v)||v<0)) throw new Error("Los hechos manuales deben ser números no negativos");
    if(!cols.length) return before;
    const sobrescritos=cols.filter(([c])=>{const k=c as keyof typeof before; const prev=(before as unknown as Record<string,unknown>)[{coste_unitario_eur:"unitCostEur",pvp_entrada_eur:"salePriceEur",peso_gramos:"weightGrams",largo_cm:"lengthCm",ancho_cm:"widthCm",alto_cm:"heightCm"}[c] as string]; return prev!==null&&prev!==undefined&&k;}).map(([c])=>c);
    const marca=`[${origin} ${new Date().toISOString().slice(0,10)}] ${cols.map(([c,v])=>`${c}=${v}`).join(", ")}${sobrescritos.length?` (sobrescribe dato previo: ${sobrescritos.join(", ")})`:""}`;
    this.db.prepare(`UPDATE product_candidates SET ${cols.map(([c])=>`${c}=?`).join(",")},score=NULL,motivos_json=NULL,nota_manual=CASE WHEN nota_manual IS NULL OR nota_manual='' THEN ? ELSE nota_manual||char(10)||? END,updated_at=unixepoch() WHERE id=?`).run(...cols.map(([,v])=>v),marca,marca,id);
    this.event(id,"hechos_manuales",before.state,before.state,before.scoring?.score??null,null,{origin,facts:Object.fromEntries(cols),sobrescritos});
    return this.byId(id)!;
  }
  private event(id:number,type:string,prev:CandidateState|null,next:CandidateState|null,prevScore:number|null,nextScore:number|null,details:unknown){
    this.db.prepare(`INSERT INTO candidate_events(candidate_id,event_type,previous_state,next_state,previous_score,next_score,details_json) VALUES(?,?,?,?,?,?,?)`).run(id,type,prev,next,prevScore,nextScore,JSON.stringify(details));
  }
}
