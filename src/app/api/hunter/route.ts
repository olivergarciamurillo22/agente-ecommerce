import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { HunterRepository } from "@/lib/hunter/repository";
import type { CandidateState } from "@/lib/hunter/types";
import { runLandingPipeline } from "@/lib/landing/e2e";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const STATES=new Set<CandidateState>(["nuevo","descartado","en_prueba","ganador"]);

export async function GET(req:NextRequest){
  const auth=requireOwner(req);if(!auth.ok)return auth.response;
  const repo=new HunterRepository(),raw=req.nextUrl.searchParams.get("id");
  if(raw!==null){const id=Number(raw),candidate=Number.isInteger(id)?repo.byId(id):null;return candidate?NextResponse.json({candidate}):NextResponse.json({ok:false,error:"Candidato no encontrado"},{status:404});}
  return NextResponse.json({candidates:repo.list()});
}

export async function POST(req:NextRequest){
  const auth=requireOwner(req);if(!auth.ok)return auth.response;
  let body:{op?:string;id?:number;state?:CandidateState;note?:string|null;salePriceEur?:number};try{body=await req.json()}catch{return NextResponse.json({ok:false,error:"JSON inválido"},{status:400})}
  const id=Number(body.id),repo=new HunterRepository();if(!Number.isInteger(id)||!repo.byId(id))return NextResponse.json({ok:false,error:"Candidato no encontrado"},{status:404});
  if(body.op==="score")return NextResponse.json({candidate:repo.score(id)});
  if(body.op==="price"&&typeof body.salePriceEur==="number")return NextResponse.json({candidate:repo.setSalePrice(id,body.salePriceEur)});
  if(body.op==="state"&&body.state&&STATES.has(body.state))return NextResponse.json({candidate:repo.setState(id,body.state,typeof body.note==="string"?body.note.slice(0,1000):null)});
  if(body.op==="generate"){
    const candidate=repo.byId(id)!;const result=runLandingPipeline(candidate,path.join(process.cwd(),"outputs","landings"));
    return NextResponse.json({ok:true,result:{...result,generatedFiles:result.generatedFiles.map((file)=>path.basename(file))}});
  }
  return NextResponse.json({ok:false,error:"Operación no permitida"},{status:400});
}
