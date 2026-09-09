// ============================================================
// AVATAR CONSOLIDADO DE LA CUENTA vía OpenRouter (09-09-2026)
//
// Complemento opcional de account.ts: con OPENROUTER_API_KEY, Claude
// (mismo modelo que la visión, DEEP_DIVE_VISION_MODEL o haiku 4.5) lee los
// textos de los anuncios de la cuenta y describe en 2–4 frases a quién le
// habla. Sin clave devuelve null y queda la heurística de texto con citas.
// Nunca inventa datos: se le pide que hable SOLO de lo que dicen los textos.
// ============================================================

import OpenAI from "openai";
import type { AvatarSignal } from "./account";
import { visionModel } from "./vision";

const SYSTEM = `Eres analista de anuncios de ecommerce en España. Te llegan los textos de varios anuncios de UNA misma cuenta anunciante y unas señales heurísticas. Describe en 2 a 4 frases, en español, a quién le habla esa cuenta en conjunto (edad aproximada, situación, dolor o deseo principal, tono). Apóyate SOLO en lo que dicen los textos: si algo no se puede afirmar, no lo afirmes. Sin listas, sin JSON, sin inventar cifras.`;

export type AccountSummarizer = (bodies: string[], signals: AvatarSignal[]) => Promise<string | null>;

/** Crea el consolidador real (OpenRouter). Inyectable en tests; null si no hay clave. */
export function makeAccountSummarizer(env: Record<string, string | undefined> = process.env): AccountSummarizer | null {
  const key = (env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) return null;
  const model = visionModel(env);
  const client = new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1", timeout: 60_000, maxRetries: 1, defaultHeaders: { "HTTP-Referer": "https://casamable.com", "X-Title": "Casamable Hunter deep dive" } });
  return async (bodies, signals) => {
    if (!bodies.length) return null;
    const user = [
      `Señales heurísticas (etiqueta: nº de anuncios): ${signals.length ? signals.map((s) => `${s.label}: ${s.ads}`).join("; ") : "ninguna"}`,
      "Textos de los anuncios (uno por línea, recortados):",
      ...bodies.slice(0, 40).map((b, i) => `${i + 1}. ${b.replace(/\s+/g, " ").slice(0, 400)}`),
    ].join("\n");
    const completion = await client.chat.completions.create({ model, temperature: 0.2, max_tokens: 300, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] });
    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    return text ? text.slice(0, 600) : null;
  };
}
