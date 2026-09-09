// ============================================================
// PALABRAS CLAVE EN EL IDIOMA DEL MERCADO (09-09-2026) — búsqueda 2
//
// Las palabras clave salen del nombre del producto en Dropea (español).
// Buscarlas tal cual en Italia o Francia no encuentra casi nada: la Ad
// Library casa texto, y los anuncios italianos dicen «cuscino», no «cojín».
// Con OPENROUTER_API_KEY, Claude traduce las 2–4 palabras al idioma del
// país (se guarda también el original, y el informe dice que se tradujo).
// Sin clave, se buscan en español y el informe lo declara: sin resultado no
// significa «sin competencia».
// ============================================================

import OpenAI from "openai";
import { tokens } from "../../product-hunter/internal/dropea-catalog";
import { visionModel } from "./vision";

/** Idioma de búsqueda por país (ISO-3166). Fuera de la lista: no se traduce y se dice. */
export const LANGUAGE_BY_COUNTRY: Record<string, string> = {
  ES: "español", MX: "español", AR: "español", CO: "español", CL: "español", PE: "español",
  IT: "italiano", PT: "portugués", BR: "portugués", FR: "francés", BE: "francés", DE: "alemán", AT: "alemán",
  NL: "neerlandés", GB: "inglés", IE: "inglés", US: "inglés", PL: "polaco", RO: "rumano", GR: "griego", SE: "sueco",
};

export const SPANISH_COUNTRIES = new Set(Object.entries(LANGUAGE_BY_COUNTRY).filter(([, l]) => l === "español").map(([c]) => c));

export type KeywordTranslator = (keywords: string[], country: string) => Promise<string[]>;

export function needsTranslation(country: string): boolean {
  const c = country.toUpperCase();
  return Boolean(LANGUAGE_BY_COUNTRY[c]) && !SPANISH_COUNTRIES.has(c);
}

/** Saca 2–4 palabras válidas de la respuesta del modelo (JSON o lista suelta). Puro, testeable. */
export function parseTranslatedKeywords(raw: string, max = 4): string[] {
  let lista: string[] = [];
  const m = raw.match(/\[[\s\S]*?\]/);
  if (m) { try { const j = JSON.parse(m[0]); if (Array.isArray(j)) lista = j.map((x) => String(x)); } catch { lista = []; } }
  if (!lista.length) lista = raw.split(/[,\n;]+/);
  const out: string[] = [];
  for (const item of lista) for (const t of tokens(item)) if (t.length >= 3 && !out.includes(t)) out.push(t);
  return out.slice(0, max);
}

export function makeKeywordTranslator(env: Record<string, string | undefined> = process.env): KeywordTranslator | null {
  const key = (env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) return null;
  const model = visionModel(env);
  const client = new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1", timeout: 30_000, maxRetries: 1, defaultHeaders: { "HTTP-Referer": "https://casamable.com", "X-Title": "Casamable Hunter deep dive" } });
  const cache = new Map<string, string[]>();
  return async (keywords, country) => {
    const c = country.toUpperCase();
    if (!needsTranslation(c) || !keywords.length) return keywords;
    const idioma = LANGUAGE_BY_COUNTRY[c];
    const k = `${c}:${keywords.join(" ")}`;
    const hit = cache.get(k); if (hit) return hit;
    const completion = await client.chat.completions.create({ model, temperature: 0, max_tokens: 80, messages: [
      { role: "system", content: `Traduces palabras clave de búsqueda de productos de ecommerce al ${idioma}, tal como las escribiría un anunciante de ese país. Responde SOLO con un array JSON de 2 a 4 palabras en minúsculas, sin frases, sin marcas, sin explicaciones.` },
      { role: "user", content: `Palabras clave en español: ${keywords.join(", ")}` },
    ] });
    const out = parseTranslatedKeywords(completion.choices[0]?.message?.content ?? "");
    const res = out.length >= 2 ? out : keywords;
    cache.set(k, res);
    return res;
  };
}
