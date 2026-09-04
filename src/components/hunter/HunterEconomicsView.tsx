"use client";
import {useCallback,useEffect,useState} from "react";
import type{CandidateState,ProductCandidate}from"@/lib/hunter/types";
import{Card,EmptyState,GhostButton,PrimaryButton}from"../ui";

const euro=(n:number|null|undefined)=>n==null?"—":`${n.toFixed(2).replace(".",",")} €`;
const STATES:CandidateState[]=["nuevo","en_prueba","ganador","descartado"];
async function json(input:RequestInfo,init?:RequestInit){const r=await fetch(input,init);const data=await r.json();if(!r.ok)throw new Error(data.error??"Error del Hunter");return data;}

function CandidateEconomicsDetail({candidate,onChange}:{candidate:ProductCandidate;onChange:(c:ProductCandidate)=>void}){
  const [note,setNote]=useState(candidate.manualNote??"");const[busy,setBusy]=useState(false);const[message,setMessage]=useState<string|null>(null);
  const act=async(body:object)=>{setBusy(true);setMessage(null);try{const d=await json("/api/hunter",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:candidate.id,...body})});if(d.candidate)onChange(d.candidate);if(d.result)setMessage(`Landing validada: ${d.result.sectionCount} secciones en ${d.result.sectionsDir}`);}catch(e){setMessage(e instanceof Error?e.message:"Error");}finally{setBusy(false)}};
  const volume=candidate.lengthCm!=null&&candidate.widthCm!=null&&candidate.heightCm!=null?candidate.lengthCm*candidate.widthCm*candidate.heightCm/6:null;
  const score=candidate.scoring;
  return <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-display text-xl font-semibold">{candidate.name??"Producto sin nombre"}</h2><p className="text-xs text-brand-muted break-all">{candidate.sourceUrl}</p></div><PrimaryButton busy={busy} disabled={!score} onClick={()=>void act({op:"generate"})}>Generar landing</PrimaryButton></div>
    <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div><span className="text-brand-muted">Coste puesto</span><strong className="block">{euro(candidate.unitCostEur)}</strong></div>
      <div><span className="text-brand-muted">Paquete de venta</span><strong className="block">{candidate.lengthCm??"—"} × {candidate.widthCm??"—"} × {candidate.heightCm??"—"} cm</strong></div>
      <div><span className="text-brand-muted">Peso real</span><strong className="block">{candidate.weightGrams??"—"} g</strong></div>
      <div><span className="text-brand-muted">Peso volumétrico</span><strong className="block">{volume==null?"—":`${Math.round(volume)} g`}</strong></div>
      <div><span className="text-brand-muted">Tramo / envío</span><strong className="block">{score?`${score.shippingTier.replace("_"," ")} · ${euro(score.shippingEur)}`:"—"}</strong></div>
      <div><span className="text-brand-muted">PVP propuesto</span><strong className="block">{euro(score?.proposedPriceEur)}</strong></div>
      <div><span className="text-brand-muted">Margen por enviado</span><strong className="block">{euro(score?.unitMarginEur)}</strong></div>
      <div><span className="text-brand-muted">CPA máximo</span><strong className="block">{euro(score?.maxCpaEur)}</strong></div>
      <div><span className="text-brand-muted">Entrega de cálculo</span><strong className="block">62,90 %</strong></div>
      <div><span className="text-brand-muted">COD entregado</span><strong className="block">0,70 €</strong></div>
      <div><span className="text-brand-muted">Rehúse</span><strong className="block">9,37 €</strong></div>
      <div><span className="text-brand-muted">Break-even entrega</span><strong className="block">{score?`${score.breakEvenDeliveryPct.toFixed(2).replace(".",",")} %`:"—"}</strong></div>
    </div>
    <div className="mt-5"><h3 className="text-sm font-semibold">Puntuación {score?`${score.score}/100 · ${score.verdict}`:"pendiente"}</h3><ul className="mt-2 space-y-1 text-sm">{candidate.reasons.map((r,i)=><li key={`${r.factor}-${i}`} className="flex justify-between gap-3"><span>{r.factor.replaceAll("_"," ")} · {r.detail}</span><strong>{r.points} pt</strong></li>)}</ul></div>
    <div className="mt-5 flex flex-col md:flex-row gap-2"><select className="rounded-lg border border-brand-border bg-brand-surface px-3 py-2 text-sm" value={candidate.state} onChange={e=>void act({op:"state",state:e.target.value,note})}>{STATES.map(s=><option key={s}>{s}</option>)}</select><input className="min-w-0 flex-1 rounded-lg border border-brand-border bg-brand-surface px-3 py-2 text-sm" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota de decisión"/><GhostButton disabled={busy} onClick={()=>void act({op:"score"})}>Recalcular</GhostButton></div>
    {message?<p className="mt-3 text-sm text-brand-muted" aria-live="polite">{message}</p>:null}</Card>;
}

export default function HunterEconomicsView(){const[items,setItems]=useState<ProductCandidate[]>([]),[selected,setSelected]=useState<number|null>(null),[error,setError]=useState<string|null>(null);const load=useCallback(async()=>{try{const d=await json("/api/hunter");setItems(d.candidates);setSelected((v)=>v??d.candidates[0]?.id??null);}catch(e){setError(e instanceof Error?e.message:"Error");}},[]);useEffect(()=>{void load()},[load]);const current=items.find(x=>x.id===selected);const change=(c:ProductCandidate)=>setItems(xs=>xs.map(x=>x.id===c.id?c:x));if(error)return <Card className="p-5 text-sm text-red-700">{error}</Card>;if(!items.length)return <Card><EmptyState title="Aún no hay candidatos locales" hint="Ingiere uno con hunter:add y aparecerá aquí con sus economics auditables."/></Card>;return <div className="grid gap-4 lg:grid-cols-[280px_1fr]"><Card className="p-2"><ul>{items.map(c=><li key={c.id}><button className={`w-full rounded-lg p-3 text-left text-sm ${selected===c.id?"bg-brand-surface-2":"hover:bg-brand-surface-2/60"}`} onClick={()=>setSelected(c.id)}><strong className="block truncate">{c.name??`Candidato ${c.id}`}</strong><span className="text-xs text-brand-muted">{c.scoring?`${c.scoring.score}/100 · ${c.scoring.verdict}`:"Sin puntuación"}</span></button></li>)}</ul></Card>{current?<CandidateEconomicsDetail candidate={current} onChange={change}/>:null}</div>}
