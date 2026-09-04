import { HunterRepository } from "../src/lib/hunter/repository";
function arg(name:string){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??null:null}
const repo=new HunterRepository(); const id=arg("--id");
const rows=id?[repo.score(Number(id))]:process.argv.includes("--all")?repo.list().map(c=>repo.score(c.id)):[];
if(rows.length===0) throw new Error("Usa --id N o --all"); console.log(JSON.stringify(rows,null,2));
