// ============================================================
// VÍDEO/AUDIO DEL ANUNCIO — OpenAI SOLO para este paso (09-09-2026)
// docs/HUNTER-DEEP-DIVE.md
//
// Decisión de Pedro: aprovechar la cuenta de OpenAI que ya paga (la misma
// OPENAI_API_KEY de la validación de direcciones) para leer el guion hablado,
// el gancho de los primeros segundos y el ritmo de los anuncios en vídeo.
//
// LO QUE ACEPTA LA API DE VERDAD (comprobado contra el SDK openai 6.38.0
// instalado, no supuesto):
//   · Chat Completions y Responses NO tienen entrada de vídeo. La entrada de
//     audio en chat (input_audio) solo admite wav/mp3 en base64: un mp4 no
//     entra ahí.
//   · /audio/transcriptions SÍ acepta el archivo tal cual: «flac, mp3, mp4,
//     mpeg, mpga, m4a, ogg, wav, or webm», máx. 25 MB. whisper-1 con
//     verbose_json devuelve segmentos con tiempos.
// Por tanto: el mp4 de render_ad se manda ENTERO a transcripciones (sin
// ffmpeg, sin extraer nada) y de ahí salen guion, gancho (primeros 5 s),
// duración y palabras por minuto. Lo VISUAL (movimiento, planos, texto en
// pantalla) NO se analiza: la API no lo acepta y sin ffmpeg no hay frames.
// El informe lo dice tal cual, nunca finge.
//
// La interpretación del guion (gancho, ángulo, dolor, deseo, avatar, CTA) la
// hace Claude por OpenRouter, como el resto del pipeline: OpenAI solo
// transcribe. Tope diario propio (DEEP_DIVE_VIDEO_DAILY_LIMIT, 50) contado
// sobre hunter_deep_dives; el token de la Ad Library nunca sale de memoria.
// ============================================================

import OpenAI, { toFile } from "openai";
import { visionModel } from "./vision";

export const DEEP_DIVE_VIDEO_MAX_BYTES = 25 * 1024 * 1024; // límite documentado de /audio/transcriptions
export const DEEP_DIVE_TRANSCRIBE_MODEL_DEFAULT = "whisper-1"; // el único con verbose_json (tiempos por segmento)
export const DEEP_DIVE_VIDEO_DAILY_LIMIT_DEFAULT = 50;

export type VideoStatus =
  | "analizada_audio"      // guion transcrito e interpretado; lo visual no
  | "sin_video"            // el anuncio no es un vídeo
  | "sin_openai_key"       // vídeo detectado, sin OPENAI_API_KEY
  | "desactivado"          // --sin-video
  | "tope_diario"          // DEEP_DIVE_VIDEO_DAILY_LIMIT alcanzado
  | "video_no_descargable" // fbcdn no lo sirvió (HTTP ≠ 200 o vacío)
  | "video_demasiado_grande"
  | "sin_audio"            // transcripción vacía (vídeo mudo o solo música)
  | "error";

export interface VideoAnalysis {
  transcribeModel: string;
  interpretModel: string | null;
  durationSec: number | null;
  language: string | null;
  /** Guion completo tal cual lo transcribe OpenAI (recortado a 3000 caracteres). */
  transcript: string;
  /** Lo que se dice en los primeros 5 segundos: el gancho. */
  hookFirstSeconds: string | null;
  wordsPerMinute: number | null;
  /** Interpretación por Claude (OpenRouter) del guion; null si no hay clave o falló. */
  interpretation: { hook: string | null; angle: string | null; pain: string | null; desire: string | null; avatar: string | null; cta: string | null; rhythm: string | null } | null;
  /** Siempre presente: qué NO se analizó y por qué. */
  limits: string;
  bytes: number;
  mime: string;
}

export const VIDEO_LIMITS = "solo audio: la API de OpenAI no acepta vídeo como entrada (SDK 6.38.0) y sin ffmpeg no hay frames; movimiento, planos y texto en pantalla NO analizados";

export function transcribeModel(env: Record<string, string | undefined> = process.env): string {
  return (env.DEEP_DIVE_TRANSCRIBE_MODEL ?? "").trim() || DEEP_DIVE_TRANSCRIBE_MODEL_DEFAULT;
}

export function videoDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt((env.DEEP_DIVE_VIDEO_DAILY_LIMIT ?? "").trim(), 10);
  return Number.isFinite(n) ? n : DEEP_DIVE_VIDEO_DAILY_LIMIT_DEFAULT;
}

export function videoAvailable(env: Record<string, string | undefined> = process.env): { ok: boolean; reason: string | null } {
  if (!(env.OPENAI_API_KEY ?? "").trim()) return { ok: false, reason: "sin OPENAI_API_KEY: los anuncios en vídeo se quedan sin guion (el informe usa el texto del anuncio y la imagen si la hay)" };
  return { ok: true, reason: null };
}

/** Segmentos con tiempos (verbose_json de whisper-1). */
export interface TranscriptSegment { start: number; end: number; text: string }
export interface Transcription { text: string; language: string | null; durationSec: number | null; segments: TranscriptSegment[] }

/** Deriva gancho (primeros 5 s), palabras/minuto y guion a partir de la transcripción. Puro, testeable. */
export function analyzeTranscript(t: Transcription): Pick<VideoAnalysis, "transcript" | "hookFirstSeconds" | "wordsPerMinute" | "durationSec" | "language"> {
  const transcript = t.text.replace(/\s+/g, " ").trim().slice(0, 3000);
  const primeros = t.segments.filter((s) => s.start < 5).map((s) => s.text.trim()).join(" ").trim();
  const hookFirstSeconds = primeros || (transcript ? transcript.split(/(?<=[.!?…])\s+/)[0]?.slice(0, 200) ?? null : null);
  const words = transcript ? transcript.split(/\s+/).length : 0;
  const dur = t.durationSec ?? (t.segments.length ? Math.max(...t.segments.map((s) => s.end)) : null);
  const wordsPerMinute = dur && dur > 0 && words ? Math.round((words / dur) * 60) : null;
  return { transcript, hookFirstSeconds: hookFirstSeconds || null, wordsPerMinute, durationSec: dur === null ? null : Math.round(dur * 10) / 10, language: t.language };
}

export type TranscribeFn = (video: { bytes: Uint8Array; mime: string }) => Promise<Transcription>;
export type InterpretFn = (transcript: string, context: { keywords: string[]; adText: string }) => Promise<VideoAnalysis["interpretation"]>;
export type VideoFn = (video: { bytes: Uint8Array; mime: string }, context: { keywords: string[]; adText: string }) => Promise<VideoAnalysis | null>;

const INTERPRET_SYSTEM = `Eres analista de anuncios de ecommerce en España. Te llega el GUION HABLADO (transcripción) de un anuncio en vídeo y el texto que lo acompaña. Describe SOLO lo que se dice; si algo no está, devuelve null. Responde ÚNICAMENTE con un JSON con estas claves: hook (qué dice en los primeros segundos para enganchar), angle (ángulo de venta: dolor, deseo, oferta, prueba social, autoridad...), pain (el problema que ataca), desire (lo que promete), avatar (a quién le habla: edad aproximada, situación), cta (la llamada a la acción literal), rhythm (ritmo del guion: lento/normal/rápido y por qué, a partir del texto). Nada de inventar: si no hay datos, null.`;

export function parseInterpretation(raw: string): VideoAnalysis["interpretation"] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const s = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim().slice(0, 300) : null);
    return { hook: s("hook"), angle: s("angle"), pain: s("pain"), desire: s("desire"), avatar: s("avatar"), cta: s("cta"), rhythm: s("rhythm") };
  } catch { return null; }
}

/** Transcripción real con OpenAI: el mp4 va tal cual a /audio/transcriptions. */
export function makeOpenAiTranscribe(env: Record<string, string | undefined> = process.env): TranscribeFn | null {
  const key = (env.OPENAI_API_KEY ?? "").trim();
  if (!key) return null;
  const model = transcribeModel(env);
  const client = new OpenAI({ apiKey: key, timeout: 120_000, maxRetries: 1 });
  return async (video) => {
    const ext = video.mime.includes("webm") ? "webm" : video.mime.includes("mpeg") ? "mpeg" : "mp4";
    const file = await toFile(Buffer.from(video.bytes), `anuncio.${ext}`, { type: video.mime || "video/mp4" });
    if (model === "whisper-1") {
      const r = await client.audio.transcriptions.create({ file, model, response_format: "verbose_json", temperature: 0 });
      const v = r as unknown as { text?: string; language?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> };
      return { text: v.text ?? "", language: v.language ?? null, durationSec: typeof v.duration === "number" ? v.duration : null, segments: (v.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })) };
    }
    // gpt-4o-transcribe / mini: solo json (sin tiempos): el gancho se aproxima con la primera frase.
    const r = await client.audio.transcriptions.create({ file, model, response_format: "json", temperature: 0 });
    return { text: (r as { text?: string }).text ?? "", language: null, durationSec: null, segments: [] };
  };
}

/** Interpretación del guion por Claude vía OpenRouter (misma clave y modelo que la visión). */
export function makeOpenRouterInterpret(env: Record<string, string | undefined> = process.env): InterpretFn | null {
  const key = (env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) return null;
  const model = visionModel(env);
  const client = new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1", timeout: 60_000, maxRetries: 1, defaultHeaders: { "HTTP-Referer": "https://casamable.com", "X-Title": "Casamable Hunter deep dive" } });
  return async (transcript, context) => {
    const completion = await client.chat.completions.create({ model, temperature: 0.2, max_tokens: 500, messages: [
      { role: "system", content: INTERPRET_SYSTEM },
      { role: "user", content: `Producto buscado: ${context.keywords.join(" ")}. Texto del anuncio: ${context.adText || "(sin texto)"}\n\nGuion hablado:\n${transcript}` },
    ] });
    return parseInterpretation(completion.choices[0]?.message?.content ?? "");
  };
}

/** Compone transcripción (OpenAI) + interpretación (Claude). Inyectable en tests. */
export function composeVideoAnalysis(transcribe: TranscribeFn, interpret: InterpretFn | null, models: { transcribe: string; interpret: string | null }): VideoFn {
  return async (video, context) => {
    if (video.bytes.byteLength > DEEP_DIVE_VIDEO_MAX_BYTES) return null;
    const t = await transcribe(video);
    const base = analyzeTranscript(t);
    let interpretation: VideoAnalysis["interpretation"] = null;
    if (interpret && base.transcript) { try { interpretation = await interpret(base.transcript, context); } catch { interpretation = null; } }
    return { transcribeModel: models.transcribe, interpretModel: interpretation ? models.interpret : null, ...base, interpretation, limits: VIDEO_LIMITS, bytes: video.bytes.byteLength, mime: video.mime };
  };
}

export function makeVideoAnalysis(env: Record<string, string | undefined> = process.env): VideoFn | null {
  const transcribe = makeOpenAiTranscribe(env);
  if (!transcribe) return null;
  const interpret = makeOpenRouterInterpret(env);
  return composeVideoAnalysis(transcribe, interpret, { transcribe: transcribeModel(env), interpret: interpret ? visionModel(env) : null });
}
