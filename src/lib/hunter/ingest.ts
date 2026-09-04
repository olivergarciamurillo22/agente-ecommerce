import type { CandidateFacts } from "./types";

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
export function extractProductFacts(sourceUrl:string,html:string,fetchedAt=Math.floor(Date.now()/1000)):Extraction {
  const body=text(html); const title=meta(html,"og:title") ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const priceRaw=meta(html,"product:price:amount") ?? /(?:€|EUR)\s*([0-9]+(?:[,.][0-9]{1,2})?)/i.exec(body)?.[1] ?? /([0-9]+(?:[,.][0-9]{1,2})?)\s*(?:€|EUR)/i.exec(body)?.[1];
  const weight=/([0-9]+(?:[,.][0-9]+)?)\s*(kg|g)\b/i.exec(body); const dims=/([0-9]+(?:[,.][0-9]+)?)\s*[x×]\s*([0-9]+(?:[,.][0-9]+)?)\s*[x×]\s*([0-9]+(?:[,.][0-9]+)?)\s*cm\b/i.exec(body);
  const suspiciousInstruction=/(ignore (?:all|previous)|system prompt|instrucciones anteriores|actúa como|you are chatgpt)/i.test(body);
  const shell=body.trim().length<80;
  return { suspiciousInstruction,shell,facts:{ sourceUrl,sourceDomain:new URL(sourceUrl).hostname.toLowerCase(),fetchedAt,
    name:shell?null:cleanMarketplaceTitle(title),category:null,unitCostEur:shell?null:num(priceRaw),
    sourceCurrency:priceRaw?"EUR":null,sourceCost:shell?null:num(priceRaw),weightGrams:weight?round(num(weight[1])!*(weight[2].toLowerCase()==="kg"?1000:1)):null,
    lengthCm:dims?num(dims[1]):null,widthCm:dims?num(dims[2]):null,heightCm:dims?num(dims[3]):null,
    variants:null,specs:null,claims:null }};
}
const round=(n:number)=>Math.round(n*100)/100;
