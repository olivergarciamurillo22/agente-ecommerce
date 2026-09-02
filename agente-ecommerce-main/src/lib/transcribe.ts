// ============================================================
// Transcripción de notas de voz (WhatsApp) → texto.
// Usa el MISMO OpenRouter del chat (audio input a un modelo multimodal),
// así que NO hace falta otra API ni otra key: con la de OpenRouter basta.
// OpenRouter acepta el audio en base64 dentro de chat/completions y admite
// formato OGG, que es justo el que manda WhatsApp (Opus en contenedor OGG).
// Añadido 2026-07-07. No forma parte del kit base.
//
// Config en .env.local (opcional):
//   TRANSCRIPTION_MODEL   modelo multimodal con audio (default google/gemini-2.5-flash)
// ============================================================

import { getSetting } from "./db";

const MODEL = process.env.TRANSCRIPTION_MODEL || "google/gemini-2.5-flash";

export function transcriptionConfigured(): boolean {
  // La transcripción va por OpenRouter: si hay key de OpenRouter, funciona.
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * Transcribe un audio (buffer de WhatsApp, OGG/Opus por defecto) a texto en
 * español, pasándolo a un modelo multimodal vía OpenRouter. Devuelve null si
 * no hay key o si falla (el handler pedirá que lo escriban).
 */
export async function transcribeAudio(audio: Buffer, format = "ogg"): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const model = getSetting("transcription_model") || MODEL;

  try {
    const b64 = Buffer.from(audio).toString("base64");
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
              {
                type: "text",
                text: "Transcribe literalmente esta nota de voz en español. Devuelve SOLO la transcripción, sin comillas, sin comentarios ni notas tuyas. Si no se entiende nada, responde exactamente: (inaudible).",
              },
              { type: "input_audio", input_audio: { data: b64, format } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text || text.length === 0 || /^\(inaudible\)$/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}
