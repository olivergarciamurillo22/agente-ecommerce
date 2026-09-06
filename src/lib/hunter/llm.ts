// ============================================================
// AI Winner Radar — CLIENTE DE MODELO, DOS VELOCIDADES.
//
// Por qué existe este fichero y no se llama a `openrouter.ts` directamente:
//
// 1. DOS NIVELES DE COSTE (§30). Clasificar 40 clusters y redactar UN informe
//    no son el mismo trabajo. `askFast` va con el modelo barato y se usa en
//    volumen; `askDeep` con el capaz y se usa una vez por búsqueda. Mandarlo
//    todo al modelo caro multiplica la factura por diez sin mejorar nada.
//
// 2. DOS PROVEEDORES. Si hay OPENAI_API_KEY se habla con OpenAI directamente;
//    si no, se cae a OpenRouter, que es lo que Casamable ya tenía. El radar
//    no puede exigir una suscripción nueva para arrancar.
//
// 3. UN SOLO SITIO DONDE SE COMPRUEBA LA PRIVACIDAD. Todo lo que sale hacia
//    un modelo pasa por `assertNoPII`. Un cortafuegos repartido por seis
//    ficheros es un cortafuegos que alguien se salta sin querer.
//
// La clave JAMÁS se escribe en base de datos, ni en logs, ni se devuelve por
// una API. Solo se lee de `process.env` en el momento de la llamada.
// ============================================================

import OpenAI from "openai";
import { completeText } from "../openrouter";

/** Barato: clasificar, etiquetar, extraer. Se llama decenas de veces. */
const DEFAULT_FAST_MODEL = "gpt-4o-mini";
/** Capaz: planificar la búsqueda y redactar el informe. Una o dos veces. */
const DEFAULT_DEEP_MODEL = "gpt-4o";

/** Tope de texto por llamada: un copy larguísimo no mejora el análisis y sí la factura. */
export const MAX_CHARS_PER_CALL = 6000;

export type ModelTier = "fast" | "deep";

function openaiKey(): string {
  return (process.env.OPENAI_API_KEY ?? "").trim();
}

function openrouterKey(): string {
  return (process.env.OPENROUTER_API_KEY ?? "").trim();
}

/** Qué proveedor de modelo hay vivo, sin revelar la clave. */
export function llmBackend(): "openai" | "openrouter" | "none" {
  if (openaiKey()) return "openai";
  if (openrouterKey()) return "openrouter";
  return "none";
}

export function llmConfigured(): boolean {
  return llmBackend() !== "none";
}

export function modelFor(tier: ModelTier): string {
  if (tier === "deep") return (process.env.WINNER_RADAR_MODEL_DEEP ?? "").trim() || DEFAULT_DEEP_MODEL;
  return (process.env.WINNER_RADAR_MODEL_FAST ?? "").trim() || DEFAULT_FAST_MODEL;
}

let _openai: OpenAI | null = null;
let _openaiKeyUsed = "";

function openaiClient(): OpenAI {
  const key = openaiKey();
  // Se reconstruye si la clave cambió: en tests y en el doctor la variable se
  // manipula, y un cliente cacheado con la clave vieja da fallos absurdos.
  if (_openai && _openaiKeyUsed === key) return _openai;
  _openai = new OpenAI({ apiKey: key, timeout: 60_000, maxRetries: 2 });
  _openaiKeyUsed = key;
  return _openai;
}

export class PIILeakError extends Error {
  constructor(what: string) {
    super(`bloqueado: el texto para la IA contenía ${what}`);
    this.name = "PIILeakError";
  }
}

/**
 * Cortafuegos de privacidad. Se ejecuta SIEMPRE antes de salir hacia el
 * modelo. Prefiere el falso positivo: quedarse sin análisis es barato,
 * filtrar el teléfono de un cliente no.
 *
 * Los `(?<!\d)`/`(?!\d)` del teléfono no son adorno: sin ellos un timestamp
 * unix de 10 cifras se lee como un móvil español y bloquea análisis buenos.
 */
export function assertNoPII(text: string): void {
  if (/[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(text)) throw new PIILeakError("un correo electrónico");
  if (/(?<!\d)(?:\+?34[\s-]?)?[6-9]\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/.test(text)) {
    throw new PIILeakError("un teléfono");
  }
  if (/\b\d{5}\s+(?:calle|avenida|c\/|plaza)\b/i.test(text)) throw new PIILeakError("una dirección");
}

export interface AskOptions {
  tier?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  /** Fuerza respuesta JSON cuando el backend lo soporta. */
  json?: boolean;
}

/**
 * `system` lleva las INSTRUCCIONES y `user` SOLO los DATOS. Separarlos no es
 * estética: reduce que un copy publicitario con texto tipo «ignora lo
 * anterior» se lea como instrucción. Todo el radar analiza texto escrito por
 * terceros, así que esto importa aquí más que en ningún otro sitio.
 *
 * Devuelve `null` en vez de lanzar: un fallo de IA baja la calidad del
 * análisis, no tumba una búsqueda que ya gastó llamadas a Meta.
 */
export async function ask(system: string, user: string, opts: AskOptions = {}): Promise<string | null> {
  const backend = llmBackend();
  if (backend === "none") return null;

  const datos = user.slice(0, MAX_CHARS_PER_CALL);
  assertNoPII(datos);

  const model = modelFor(opts.tier ?? "fast");
  const maxTokens = opts.maxTokens ?? 700;
  const temperature = opts.temperature ?? 0.3;

  try {
    if (backend === "openai") {
      const completion = await openaiClient().chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: datos },
        ],
        temperature,
        max_tokens: maxTokens,
        ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      });
      const out = completion.choices?.[0]?.message?.content ?? "";
      return out.trim() ? out.trim() : null;
    }
    // OpenRouter: mismo contrato, prefijo de proveedor en el nombre del modelo.
    const out = await completeText(system, datos, {
      model: model.includes("/") ? model : `openai/${model}`,
      maxTokens,
      temperature,
    });
    return typeof out === "string" && out.trim() ? out.trim() : null;
  } catch (e) {
    // ══ UN FALLO DE MODELO NO PUEDE SER INVISIBLE ══
    // Antes esto era un `catch {}` mudo. Consecuencia: con una clave
    // caducada, sin saldo o con un nombre de modelo mal escrito, TODO el
    // análisis caía al camino determinista y el panel seguía enseñando
    // resultados con normalidad. Nadie se enteraba nunca de que la mitad
    // cara del sistema llevaba semanas sin ejecutarse.
    //
    // Se registra en el mismo sitio que el resto de integraciones, para que
    // salga en Sistema → Eventos. El import es perezoso a propósito: arrastra
    // la base de datos y este módulo no debe llevarla siempre encima.
    void registrarFallo(backend, model, e);
    return null;
  }
}

/** Deduplicación en memoria: un fallo por modelo y minuto, no mil líneas. */
const ultimoAviso = new Map<string, number>();

async function registrarFallo(backend: string, model: string, e: unknown): Promise<void> {
  const clave = `${backend}|${model}`;
  const ahora = Date.now();
  if ((ultimoAviso.get(clave) ?? 0) > ahora - 60_000) return;
  ultimoAviso.set(clave, ahora);
  try {
    const { logIntegrationEvent } = await import("../system/repo");
    logIntegrationEvent("hunter", "hunter_llm_failed", "warning", sanitizarError(e, model, backend));
  } catch {
    // Si ni siquiera se puede registrar, no se tumba la búsqueda por ello.
  }
}

/**
 * Mensaje de error sin la clave dentro. Los SDK a veces incluyen la cabecera
 * de autorización en el detalle del error, y esto acaba escrito en la base.
 */
export function sanitizarError(e: unknown, model: string, backend: string): string {
  const bruto = e instanceof Error ? e.message : String(e);
  const limpio = bruto
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<oculta>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <oculto>")
    .slice(0, 220);
  return `${backend}/${model}: ${limpio}`;
}

/** Extrae el primer objeto JSON de una respuesta que puede traer texto alrededor. */
export function extractJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const limpio = raw.replace(/```(?:json)?/gi, "").trim();
  const ini = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (ini < 0 || fin <= ini) return null;
  try {
    const parsed = JSON.parse(limpio.slice(ini, fin + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Lista de textos de un campo del JSON, saneada. Evita repetir este bucle. */
export function stringList(value: unknown, max = 12, maxLen = 160): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, maxLen);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Solo para tests y para el doctor: olvida el cliente cacheado. */
export function __resetLlmClientForTests(): void {
  _openai = null;
  _openaiKeyUsed = "";
}

export interface LlmHealth {
  backend: "openai" | "openrouter" | "none";
  /** NOT_CONFIGURED · CONNECTED · ERROR. */
  status: "NOT_CONFIGURED" | "CONNECTED" | "ERROR";
  detail: string;
  fastModel: string;
  deepModel: string;
}

/**
 * Comprueba que la clave FUNCIONA, no solo que está escrita.
 *
 * Antes el doctor decía CONNECTED con solo ver la variable no vacía. Con una
 * clave caducada eso es una mentira tranquilizadora: el radar seguiría
 * funcionando en modo determinista y el diagnóstico diría que todo va bien.
 *
 * Se usa `models.list()` a propósito: no genera ni un token, así que la
 * comprobación no cuesta dinero.
 */
export async function llmHealth(): Promise<LlmHealth> {
  const backend = llmBackend();
  const base: LlmHealth = {
    backend,
    status: "NOT_CONFIGURED",
    detail: "Sin OPENAI_API_KEY ni OPENROUTER_API_KEY el radar busca igual, con análisis determinista y sin resúmenes.",
    fastModel: modelFor("fast"),
    deepModel: modelFor("deep"),
  };
  if (backend === "none") return base;

  try {
    if (backend === "openai") {
      const lista = await openaiClient().models.list();
      const nombres = new Set((lista.data ?? []).map((m) => m.id));
      // Que la clave valga no significa que el modelo pedido exista para esa
      // cuenta. Un nombre mal escrito daría CONNECTED y luego fallaría en
      // cada llamada, en silencio.
      const faltan = [modelFor("fast"), modelFor("deep")].filter((m) => !nombres.has(m));
      return {
        ...base,
        status: faltan.length > 0 ? "ERROR" : "CONNECTED",
        detail: faltan.length > 0
          ? `La clave funciona pero tu cuenta no tiene: ${faltan.join(", ")}. Ajusta WINNER_RADAR_MODEL_FAST/DEEP.`
          : `rápido=${base.fastModel} · profundo=${base.deepModel}`,
      };
    }
    // OpenRouter: se valida con el validador que Casamable ya tenía.
    const { validateApiKey } = await import("../openrouter");
    const r = await validateApiKey();
    return {
      ...base,
      status: r.ok ? "CONNECTED" : "ERROR",
      detail: r.ok ? `rápido=${base.fastModel} · profundo=${base.deepModel}` : (r.error ?? "la clave no valida"),
    };
  } catch (e) {
    return { ...base, status: "ERROR", detail: sanitizarError(e, modelFor("fast"), backend) };
  }
}
