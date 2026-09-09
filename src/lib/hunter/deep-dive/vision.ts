// ============================================================
// VISIÓN DE LA CREATIVIDAD vía OpenRouter (09-09-2026)
//
// Mismo proveedor y misma clave que el resto del proyecto
// (OPENROUTER_API_KEY). Modelo: DEEP_DIVE_VISION_MODEL o, por defecto,
// anthropic/claude-haiku-4.5, que en OpenRouter declara
// input_modalities = [text, image, file] (comprobado el 09-09 contra
// /api/v1/models, sin clave). Nada de OpenAI ni segunda clave.
//
// Devuelve un JSON con seis campos; lo que el modelo no vea queda null. Si
// no hay clave, devuelve null con motivo: la pieza queda «sin_vision» y el
// informe se apoya en el texto del anuncio.
// ============================================================

import OpenAI from "openai";
import type { CreativeAnalysis, VisionFn } from "./deep-dive";

export const DEEP_DIVE_VISION_MODEL_DEFAULT = "anthropic/claude-haiku-4.5";
export const DEEP_DIVE_VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function visionModel(env: Record<string, string | undefined> = process.env): string {
  return (env.DEEP_DIVE_VISION_MODEL ?? "").trim() || DEEP_DIVE_VISION_MODEL_DEFAULT;
}

export function visionAvailable(env: Record<string, string | undefined> = process.env): { ok: boolean; reason: string | null } {
  if (!(env.OPENROUTER_API_KEY ?? "").trim()) return { ok: false, reason: "sin OPENROUTER_API_KEY: la creatividad no se analiza con visión (el informe usa el texto del anuncio)" };
  return { ok: true, reason: null };
}

const SYSTEM = `Eres analista de anuncios de ecommerce en España. Te llega la imagen de un anuncio de Facebook/Instagram y el texto que lo acompaña. Describe SOLO lo que se ve o se lee; si algo no está, devuelve null. Responde ÚNICAMENTE con un JSON con estas claves: hook (el gancho visual o textual principal, una frase), angle (ángulo de venta: dolor, deseo, oferta, prueba social, autoridad...), pain (el dolor o problema que ataca), desire (lo que promete), avatar (a quién le habla: edad aproximada, género si es evidente, situación), visiblePrice (precio u oferta visible EN LA IMAGEN, texto literal, o null). Nada de inventar precios: si no hay precio en la imagen, visiblePrice es null.`;

export function parseCreativeJson(raw: string, model: string): CreativeAnalysis | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const s = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim().slice(0, 300) : null);
    return { model, hook: s("hook"), angle: s("angle"), pain: s("pain"), desire: s("desire"), avatar: s("avatar"), visiblePrice: s("visiblePrice"), raw: raw.slice(0, 2000) };
  } catch { return null; }
}

/** Crea la función de visión real (OpenRouter). Inyectable en tests; null si no hay clave. */
export function makeOpenRouterVision(env: Record<string, string | undefined> = process.env): VisionFn | null {
  if (!visionAvailable(env).ok) return null;
  const model = visionModel(env);
  const client = new OpenAI({ apiKey: env.OPENROUTER_API_KEY!.trim(), baseURL: "https://openrouter.ai/api/v1", timeout: 60_000, maxRetries: 1, defaultHeaders: { "HTTP-Referer": "https://casamable.com", "X-Title": "Casamable Hunter deep dive" } });
  return async (image, context) => {
    if (image.bytes.byteLength > DEEP_DIVE_VISION_MAX_IMAGE_BYTES) return null;
    const dataUrl = `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}`;
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: [
          { type: "text", text: `Producto buscado: ${context.keywords.join(" ")}. Texto del anuncio: ${context.adText || "(sin texto)"}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ] },
      ],
    });
    return parseCreativeJson(completion.choices?.[0]?.message?.content ?? "", model);
  };
}
