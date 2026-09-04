import type { CandidateFacts } from "./types";

export const HUNTER_FETCH_TIMEOUT_MS=15_000;
export const HUNTER_MAX_HTML_BYTES=2*1024*1024;
export const HUNTER_USER_AGENT="Casamable-Hunter/1.0 (+https://casamable.com/contacto; investigación de producto)";
export type IngestEvent=(eventType:string,severity:"info"|"warning"|"critical",message:string,url:string)=>void;

const SPAM = /\b(?:20\d{2}|new|hot|sale|fashion|best|quality|free shipping|dropshipping|wholesale)\b/gi;
export function cleanMarketplaceTitle(raw: string): string | null {
  const clean = raw.replace(/[\p{Extended_Pictographic}©®™]/gu, " ").replace(SPAM," ")
    .replace(/[|_,;]+/g," ").replace(/\s+/g," ").replace(/^[-–—: ]+|[-–—: ]+$/g,"").trim();
  return clean ? clean.split(" ").slice(0, 12).join(" ") : null;
}

function text(html:string):string { return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&euro;|&#8364;/gi,"€").replace(/\s+/g," "); }
function meta(html:string,key:string):string|null { const re=new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,`i`); return re.exec(html)?.[1]?.trim()??null; }
function num(raw:string|undefined):number|null { if(!raw)return null; const n=Number(raw.replace(",",".")); return Number.isFinite(n)&&n>=0?n:null; }

export interface Extraction { facts:CandidateFacts; suspiciousInstruction:boolean; shell:boolean }
export async function fetchProductHtml(sourceUrl:string,fetcher:typeof fetch=fetch,onEvent:IngestEvent=()=>{}):Promise<string>{
  const url=new URL(sourceUrl).toString();onEvent("hunter_fetch_attempt","info",`Intento de ingesta Hunter: ${url}`,url);
  try{
    const response=await fetcher(url,{headers:{"user-agent":HUNTER_USER_AGENT,"accept":"text/html,application/xhtml+xml"},signal:AbortSignal.timeout(HUNTER_FETCH_TIMEOUT_MS)});
    if(!response.ok)throw new Error(`La fuente respondió HTTP ${response.status}`);
    const contentType=response.headers.get("content-type")?.toLowerCase()??"";
    if(!/(?:text\/html|application\/xhtml\+xml)/.test(contentType))throw new Error(`Tipo de contenido no HTML: ${contentType||"ausente"}`);
    const declared=Number(response.headers.get("content-length"));
    if(Number.isFinite(declared)&&declared>HUNTER_MAX_HTML_BYTES)throw new Error(`Respuesta demasiado grande: máximo ${HUNTER_MAX_HTML_BYTES} bytes`);
    if(!response.body)throw new Error("La fuente no devolvió cuerpo HTML");
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
    while(true){const{done,value}=await reader.read();if(done)break;if(value){total+=value.byteLength;if(total>HUNTER_MAX_HTML_BYTES){await reader.cancel();throw new Error(`Respuesta demasiado grande: máximo ${HUNTER_MAX_HTML_BYTES} bytes`)}chunks.push(value)}}
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
    const html=new TextDecoder("utf-8",{fatal:false}).decode(bytes);onEvent("hunter_fetch_success","info",`Ingesta Hunter completada (${total} bytes): ${url}`,url);return html;
  }catch(error){const message=error instanceof Error?error.message:"Error desconocido";onEvent("hunter_fetch_failure","warning",`Ingesta Hunter fallida: ${url} · ${message}`,url);throw error}
}
export function extractProductFacts(sourceUrl:string,html:string,fetchedAt=Math.floor(Date.now()/1000)):Extraction {
  const body=text(html); const title=meta(html,"og:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const priceRaw=meta(html,"product:price:amount") ?? /(?:€|EUR)\s*([0-9]+(?:[,.][0-9]{1,2})?)/i.exec(body)?.[1] ?? /([0-9]+(?:[,.][0-9]{1,2})?)\s*(?:€|EUR)/i.exec(body)?.[1];
  const weight=/([0-9]+(?:[,.][0-9]+)?)\s*(kg|g)\b/i.exec(body); const dims=/([0-9]+(?:[,.][0-9]+)?)\s*[x×]\s*([0-9]+(?:[,.][0-9]+)?)\s*[x×]\s*([0-9]+(?:[,.][0-9]+)?)\s*cm\b/i.exec(body);
  const suspiciousInstruction=/(ignore (?:all|previous)|system prompt|instrucciones anteriores|actúa como|you are chatgpt)/i.test(body);
  const shell=body.trim().length<80;
  const normalizedUrl=new URL(sourceUrl).toString().slice(0,2048),domain=new URL(sourceUrl).hostname.toLowerCase().slice(0,253);
  return { suspiciousInstruction,shell,facts:{ sourceUrl:normalizedUrl,sourceDomain:domain,fetchedAt,
    name:shell?null:(cleanMarketplaceTitle(title)?.slice(0,160)??null),category:null,unitCostEur:shell?null:num(priceRaw),
    sourceCurrency:priceRaw?"EUR":null,sourceCost:shell?null:num(priceRaw),weightGrams:weight?round(num(weight[1])!*(weight[2].toLowerCase()==="kg"?1000:1)):null,
    lengthCm:dims?num(dims[1]):null,widthCm:dims?num(dims[2]):null,heightCm:dims?num(dims[3]):null,
    variants:null,specs:null,claims:null }};
}
const round=(n:number)=>Math.round(n*100)/100;

export async function ingestProductPage(sourceUrl:string,fetcher:typeof fetch=fetch,onEvent:IngestEvent=()=>{}):Promise<Extraction>{
  const result=extractProductFacts(sourceUrl,await fetchProductHtml(sourceUrl,fetcher,onEvent));
  if(result.suspiciousInstruction)onEvent("hunter_remote_instruction","warning",`La fuente ${new URL(sourceUrl).toString()} contenía texto con forma de instrucción; se trató como dato inerte.`,new URL(sourceUrl).toString());
  return result;
}
