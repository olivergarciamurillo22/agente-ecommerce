import { ingestProductPage, type IngestEvent } from "../src/lib/hunter/ingest";
import { HunterRepository } from "../src/lib/hunter/repository";
import { logIntegrationEvent } from "../src/lib/system/repo";

function arg(name:string){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??null:null}
const url=arg("--url"); if(!url) throw new Error("Uso: npm run hunter:add -- --url <url> [--apply]");
new URL(url); const apply=process.argv.includes("--apply");
const audit:IngestEvent=(type,severity,message,attemptUrl)=>logIntegrationEvent("system",type,severity,message,new URL(attemptUrl).hostname);
const result=await ingestProductPage(url,fetch,audit);
const criticalMissing=[result.facts.unitCostEur,result.facts.weightGrams,result.facts.lengthCm,result.facts.widthCm,result.facts.heightCm].some(v=>v===null);
if(!apply){console.log(JSON.stringify({...result,mode:"dry-run",reason:criticalMissing?"Faltan datos críticos; usa --apply conscientemente para guardar el candidato incompleto.":"Falta --apply."},null,2));process.exit(0)}
const saved=new HunterRepository().upsert(result.facts); console.log(JSON.stringify(saved,null,2));
