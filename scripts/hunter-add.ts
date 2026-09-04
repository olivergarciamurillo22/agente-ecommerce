import { extractProductFacts } from "../src/lib/hunter/ingest";
import { HunterRepository } from "../src/lib/hunter/repository";
import { logIntegrationEvent } from "../src/lib/system/repo";

function arg(name:string){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??null:null}
const url=arg("--url"); if(!url) throw new Error("Uso: npm run hunter:add -- --url <url> [--apply]");
new URL(url); const apply=process.argv.includes("--apply");
const response=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 CasamableHunter/1.0"},signal:AbortSignal.timeout(15000)});
if(!response.ok) throw new Error(`La fuente respondió HTTP ${response.status}`);
const result=extractProductFacts(url,await response.text());
if(result.suspiciousInstruction) logIntegrationEvent("system","hunter_remote_instruction","warning","La fuente del Hunter contenía texto con forma de instrucción; se trató como dato inerte.");
const criticalMissing=[result.facts.unitCostEur,result.facts.weightGrams,result.facts.lengthCm,result.facts.widthCm,result.facts.heightCm].some(v=>v===null);
if(!apply||criticalMissing){console.log(JSON.stringify({...result,mode:"dry-run",reason:criticalMissing?"Faltan datos críticos; usa --apply conscientemente para guardar.":"Falta --apply."},null,2));process.exit(0)}
const saved=new HunterRepository().upsert(result.facts); console.log(JSON.stringify(saved,null,2));
