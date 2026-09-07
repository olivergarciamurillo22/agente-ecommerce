// ============================================================
// IA DE INTENCIÓN POST-CONFIRMACIÓN (07-09-2026) — docs/AUTO-DESPACHO-COOLDOWN.md
//
// Se activa sobre el texto libre que llega DESPUÉS de que un pedido esté
// confirmado, y solo cuando el flujo determinista no lo entiende (hoy manda
// todo ese texto a una persona; esto lo REFINA, no lo sustituye).
//
// Salida estructurada exacta de la spec:
//   { intencion: cancelacion|duda_conocida|duda_no_reconocida|otro,
//     duda_conocida_id: string|null, confianza: 0..1, respuesta_sugerida: string|null }
//
// REGLA FAIL-CLOSED: solo `duda_conocida` con confianza ≥ 0,75 y una id que
// EXISTA en config/faq-post-confirmacion.json se responde sola — y con el
// texto FIJO de la FAQ, nunca con `respuesta_sugerida` del modelo. Todo lo
// demás (cancelación, duda no reconocida, otro, confianza baja, fallo,
// timeout, JSON inválido, id desconocida) → persona.
//
// Interruptor: POST_CONFIRMATION_AI_ENABLED=1 + OPENAI_API_KEY. Apagado por
// defecto hasta que Pedro apruebe el contenido de la FAQ.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { ADDRESS_AI_DEFAULT_MODEL } from "./address-ai";

export const INTENT_AI_MIN_CONFIDENCE = 0.75;
export const INTENT_AI_DEFAULT_TIMEOUT_MS = 8000;

export type PostConfirmationIntent = "cancelacion" | "duda_conocida" | "duda_no_reconocida" | "otro";

export interface FaqEntry {
  id: string;
  question: string;
  response: string;
  examples?: string[];
}

export interface IntentAiVerdict {
  intencion: PostConfirmationIntent;
  duda_conocida_id: string | null;
  confianza: number;
  respuesta_sugerida: string | null;
}

export interface IntentClassification {
  intent: PostConfirmationIntent;
  faqId: string | null;
  confidence: number | null;
  /** true solo cuando procede auto-responder con el texto fijo de la FAQ. */
  autoReply: string | null;
  /** Motivo por el que se escala (null si se auto-responde). */
  escalationReason: string | null;
  model: string;
  raw: string;
  fromModel: boolean;
}

export const INTENT_AI_JSON_SCHEMA = {
  name: "intencion_post_confirmacion",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      intencion: { type: "string", enum: ["cancelacion", "duda_conocida", "duda_no_reconocida", "otro"] },
      duda_conocida_id: { type: ["string", "null"] },
      confianza: { type: "number" },
      respuesta_sugerida: { type: ["string", "null"] },
    },
    required: ["intencion", "duda_conocida_id", "confianza", "respuesta_sugerida"],
  },
} as const;

let faqCache: { file: string; mtimeMs: number; entries: FaqEntry[] } | null = null;

export function faqFilePath(): string {
  return path.resolve(process.cwd(), "config", "faq-post-confirmacion.json");
}

/** Carga la FAQ (con caché por mtime). Sin fichero o inválido → lista vacía (nada se auto-responde). */
export function loadPostConfirmationFaq(file = faqFilePath()): FaqEntry[] {
  try {
    const stat = fs.statSync(file);
    if (faqCache && faqCache.file === file && faqCache.mtimeMs === stat.mtimeMs) return faqCache.entries;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: unknown };
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter((e): e is FaqEntry => !!e && typeof e === "object" && typeof (e as FaqEntry).id === "string" && typeof (e as FaqEntry).response === "string" && (e as FaqEntry).response.trim() !== "")
      : [];
    faqCache = { file, mtimeMs: stat.mtimeMs, entries };
    return entries;
  } catch {
    return [];
  }
}

export function postConfirmationAiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.POST_CONFIRMATION_AI_ENABLED ?? "0").trim() === "1" && (env.OPENAI_API_KEY ?? "").trim() !== "";
}

export function intentAiModel(env: Record<string, string | undefined> = process.env): string {
  return (env.POST_CONFIRMATION_AI_MODEL ?? "").trim() || ADDRESS_AI_DEFAULT_MODEL;
}

export function intentAiTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.POST_CONFIRMATION_AI_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? n : INTENT_AI_DEFAULT_TIMEOUT_MS;
}

export function buildIntentSystemPrompt(faq: FaqEntry[]): string {
  const catalog = faq.map((e) => `- id "${e.id}": ${e.question}${e.examples?.length ? ` (ej.: ${e.examples.slice(0, 3).join(" / ")})` : ""}`).join("\n");
  return (
    "Clasificas mensajes de WhatsApp de clientes que YA han confirmado un pedido contra reembolso en una tienda española. " +
    "Responde solo con el JSON pedido. Intenciones: " +
    "'cancelacion' = quiere cancelar, devolver, rechazar, dice que no lo pidió, o duda seria sobre seguir adelante; " +
    "'duda_conocida' = pregunta que coincide claramente con UNA de estas preguntas frecuentes (pon su id en duda_conocida_id):\n" +
    (catalog || "(sin preguntas frecuentes configuradas)") +
    "\n'duda_no_reconocida' = pregunta o petición que NO está en la lista. " +
    "REGLA ESTRICTA: cualquier pregunta sobre características técnicas del producto (medidas, materiales, compatibilidad, funcionamiento, contenido del pack, garantía) que no coincida EXACTAMENTE con una de las preguntas frecuentes es 'duda_no_reconocida', nunca 'duda_conocida': la responderá una persona. " +
    "'otro' = saludos, agradecimientos, mensajes vacíos o sin sentido. " +
    "Ante cualquier duda entre cancelación y otra cosa, elige 'cancelacion'. 'confianza' es tu seguridad (0 a 1). " +
    "'respuesta_sugerida' es opcional y NO se enviará al cliente."
  );
}

export type IntentAiCompleter = (args: { model: string; system: string; user: string; timeoutMs: number }) => Promise<string>;

export const openAiIntentCompleter: IntentAiCompleter = async ({ model, system, user, timeoutMs }) => {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY ?? "").trim(), timeout: timeoutMs, maxRetries: 0 });
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: INTENT_AI_JSON_SCHEMA },
  });
  return completion.choices[0]?.message?.content ?? "";
};

export function parseIntentVerdict(raw: string): IntentAiVerdict | null {
  try {
    const p = JSON.parse(raw) as Partial<IntentAiVerdict>;
    if (!p || typeof p !== "object") return null;
    if (!["cancelacion", "duda_conocida", "duda_no_reconocida", "otro"].includes(String(p.intencion))) return null;
    if (typeof p.confianza !== "number" || !Number.isFinite(p.confianza) || p.confianza < 0 || p.confianza > 1) return null;
    return {
      intencion: p.intencion as PostConfirmationIntent,
      duda_conocida_id: typeof p.duda_conocida_id === "string" && p.duda_conocida_id.trim() ? p.duda_conocida_id.trim() : null,
      confianza: p.confianza,
      respuesta_sugerida: typeof p.respuesta_sugerida === "string" ? p.respuesta_sugerida : null,
    };
  } catch {
    return null;
  }
}

/**
 * Clasifica un mensaje. NUNCA lanza. Decide `autoReply` (texto fijo de la
 * FAQ) o `escalationReason` (fail-closed en todo lo demás).
 */
export async function classifyPostConfirmationMessage(
  text: string,
  deps: { complete?: IntentAiCompleter; env?: Record<string, string | undefined>; faq?: FaqEntry[] } = {}
): Promise<IntentClassification> {
  const env = deps.env ?? process.env;
  const model = intentAiModel(env);
  const timeoutMs = intentAiTimeoutMs(env);
  const faq = deps.faq ?? loadPostConfirmationFaq();
  const complete = deps.complete ?? openAiIntentCompleter;
  const escalate = (reason: string, raw: string, intent: PostConfirmationIntent = "otro", confidence: number | null = null, faqId: string | null = null): IntentClassification => ({
    intent, faqId, confidence, autoReply: null, escalationReason: reason, model, raw: raw.slice(0, 2000), fromModel: false,
  });

  let raw = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race<string>([
      complete({ model, system: buildIntentSystemPrompt(faq), user: text.slice(0, 2000), timeoutMs }),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs} ms`)), timeoutMs + 500); }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return escalate(/timeout/i.test(message) ? "timeout_llamada_ia" : "fallo_llamada_ia", message);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const v = parseIntentVerdict(raw);
  if (!v) return escalate("respuesta_ia_invalida", raw);
  const base = { intent: v.intencion, faqId: v.duda_conocida_id, confidence: v.confianza, model, raw: raw.slice(0, 2000), fromModel: true };
  if (v.intencion !== "duda_conocida") return { ...base, autoReply: null, escalationReason: `intencion_${v.intencion}` };
  if (v.confianza < INTENT_AI_MIN_CONFIDENCE) return { ...base, autoReply: null, escalationReason: `confianza_baja_${v.confianza.toFixed(2)}` };
  const entry = v.duda_conocida_id ? faq.find((e) => e.id === v.duda_conocida_id) : undefined;
  if (!entry) return { ...base, autoReply: null, escalationReason: "duda_conocida_id_desconocida" };
  // Texto FIJO de la FAQ, jamás el del modelo.
  return { ...base, autoReply: entry.response, escalationReason: null };
}
