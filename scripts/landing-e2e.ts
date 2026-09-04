import path from "node:path";
import { HunterRepository } from "../src/lib/hunter/repository";
import { runLandingPipeline } from "../src/lib/landing/e2e";

function arg(name: string): string | null { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1]??null : null; }
const id=Number(arg("--candidate"));
if(!Number.isInteger(id)) throw new Error("Uso: npm run landing:e2e -- --candidate N [--out <dir>]");
const candidate=new HunterRepository().byId(id);
if(!candidate) throw new Error(`No existe el candidato ${id}`);
const result=runLandingPipeline(candidate,arg("--out")??path.join("outputs","landings"));
console.log(`1/5 Secciones emitidas: ${result.sectionCount}`);
console.log(`2/5 Ficheros generados: ${result.generatedFiles.length+1}`);
console.log(`3/5 Reglas de lint pasadas: ${result.lintRuleCount}`);
console.log(`4/5 Salida Liquid: ${result.sectionsDir}`);
console.log(`5/5 Pedro debe sustituir: ${result.placeholders.join(", ")}.`);
