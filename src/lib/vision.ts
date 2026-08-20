// ============================================================
// Visión: interpreta las IMÁGENES que un lead envía por WhatsApp.
// Usa el MISMO OpenRouter del chat (imagen en base64 a un modelo multimodal),
// así que NO hace falta otra API ni otra key. Devuelve una descripción en texto
// que el agente usa como si el lead la hubiera escrito.
//
// Config en .env.local (opcional):
//   VISION_MODEL   modelo multimodal con visión (default google/gemini-2.5-flash)
// ============================================================

import { getSetting } from "./db";

const MODEL = process.env.VISION_MODEL || "google/gemini-2.5-flash";

export function visionConfigured(): boolean {
  // La visión va por OpenRouter: si hay key de OpenRouter, funciona.
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * Describe una imagen (buffer de WhatsApp) en español, de forma útil para un
 * agente de ventas. Devuelve la descripción, o null si no hay key o falla.
 * `mimetype` viene de WhatsApp (p.ej. "image/jpeg"); si falta, se asume jpeg.
 */
export async function describeImage(
  image: Buffer,
  mimetype = "image/jpeg",
  caption?: string
): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const model = getSetting("vision_model") || MODEL;
  const mime = mimetype && mimetype.startsWith("image/") ? mimetype : "image/jpeg";

  const instruccion =
    "Un cliente ha enviado esta imagen por WhatsApp a un negocio. Descríbela de forma BREVE y ÚTIL para que el agente de ventas entienda qué es y pueda responder. Si es una captura, di qué muestra (un producto, precios, un error, un comprobante de pago, una conversación...). En español, 1-2 frases, sin adornos ni comillas." +
    (caption ? ` El cliente la acompaña de este texto: "${caption}".` : "") +
    " Si no se ve nada claro, responde exactamente: (imagen no clara).";

  try {
    const b64 = Buffer.from(image).toString("base64");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/whatsapp-ai-agent-kit",
        "X-Title": "WhatsApp AI Agent Kit",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: instruccion },
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const desc = json.choices?.[0]?.message?.content?.trim();
    if (!desc || desc.length === 0 || /^\(imagen no clara\)$/i.test(desc)) return null;
    return desc;
  } catch {
    return null;
  }
}
