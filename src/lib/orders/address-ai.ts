// ============================================================
// CAPA 2 · validación semántica de la dirección con OpenAI (07-09-2026).
// docs/VALIDACION-DIRECCION-IA.md
//
// UNA llamada por pedido (la caché vive en address_validations, por hash de
// dirección), con salida JSON estructurada y estricta. La IA solo SEÑALA
// duda: jamás corrige ni modifica el dato del cliente.
//
// FAIL-CLOSED (regla obligatoria): fallo de red, timeout, JSON inválido,
// veredicto desconocido o confianza < 0,6 → "dudosa", con el motivo en
// `problemas`. Nunca "correcta" por defecto.
//
// Timeout: ADDRESS_AI_TIMEOUT_MS (default 8000 ms). Modelo: ADDRESS_AI_MODEL
// (default gpt-4o-mini). Interruptor: ADDRESS_AI_VALIDATION_ENABLED=1 +
// OPENAI_API_KEY; sin ambos la capa NO se ejecuta (y se registra como tal).
// ============================================================

import type { AddressVerdict } from "./address-assessment";

export const ADDRESS_AI_MIN_CONFIDENCE = 0.6;
export const ADDRESS_AI_DEFAULT_TIMEOUT_MS = 8000;
export const ADDRESS_AI_DEFAULT_MODEL = "gpt-4o-mini";

export interface AddressAiInput {
  address: string;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  /** Provincia deducida del CP en la capa 1 (contexto para el modelo). */
  provinceFromCp: string | null;
}

export interface AddressAiVerdict {
  veredicto: AddressVerdict;
  problemas: string[];
  confianza: number;
}

export interface AddressAiResult {
  layer: 2;
  verdict: AddressVerdict;
  problems: string[];
  /** Confianza declarada por el modelo (0..1) o null si no hubo respuesta válida. */
  confidence: number | null;
  model: string;
  /** Respuesta cruda del modelo (o el error), para auditoría. */
  raw: string;
  /** false cuando el veredicto es el fallback fail-closed, no del modelo. */
  fromModel: boolean;
}

/** Esquema EXACTO que exige la spec. `strict` obliga al modelo a cumplirlo. */
export const ADDRESS_AI_JSON_SCHEMA = {
  name: "veredicto_direccion",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      veredicto: { type: "string", enum: ["correcta", "dudosa", "incorrecta"] },
      problemas: { type: "array", items: { type: "string" } },
      confianza: { type: "number" },
    },
    required: ["veredicto", "problemas", "confianza"],
  },
} as const;

export const ADDRESS_AI_SYSTEM_PROMPT =
  "Eres un verificador de direcciones postales de España para envíos contra reembolso. " +
  "Evalúa SOLO la dirección que se te da; no la corrijas ni propongas otra. Responde únicamente con el JSON pedido. " +
  "Criterios: (1) ¿la calle parece un nombre de vía real y coherente con la ciudad/provincia indicadas? " +
  "(2) Si el tipo de vía sugiere un edificio de pisos en zona urbana (Calle, Avenida, Paseo, Plaza…), ¿falta piso/puerta/portal? " +
  "Si es plausible que no aplique (chalet, urbanización con número, 'Carretera km X', polígono, s/n), no lo penalices. " +
  "(3) ¿Hay contradicciones internas (dos números de vía, ciudad que no cuadra con la provincia, texto sin sentido)? " +
  "Veredicto: 'correcta' si no ves problema; 'dudosa' si falta algo que un repartidor necesitaría o hay una incoherencia leve; " +
  "'incorrecta' si no es una dirección entregable. 'confianza' es tu seguridad en el veredicto (0 a 1). " +
  "'problemas' son frases cortas en español, vacío si no hay ninguno.";

export function buildAddressAiUserPrompt(input: AddressAiInput): string {
  return [
    `Dirección: ${input.address || "(vacía)"}`,
    `Ciudad: ${input.city ?? "(no indicada)"}`,
    `Provincia: ${input.province ?? "(no indicada)"}`,
    `Código postal: ${input.postalCode ?? "(no indicado)"}${input.provinceFromCp ? ` (prefijo → ${input.provinceFromCp})` : ""}`,
  ].join("\n");
}

/** Firma inyectable: recibe los mensajes y devuelve el texto del modelo. */
export type AddressAiCompleter = (args: { model: string; system: string; user: string; timeoutMs: number }) => Promise<string>;

export function addressAiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ADDRESS_AI_VALIDATION_ENABLED ?? "0").trim() === "1" && (env.OPENAI_API_KEY ?? "").trim() !== "";
}

export function addressAiModel(env: Record<string, string | undefined> = process.env): string {
  return (env.ADDRESS_AI_MODEL ?? "").trim() || ADDRESS_AI_DEFAULT_MODEL;
}

export function addressAiTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ADDRESS_AI_TIMEOUT_MS ?? "");
  return Number.isFinite(n) && n >= 1000 && n <= 60_000 ? n : ADDRESS_AI_DEFAULT_TIMEOUT_MS;
}

/** Cliente real de OpenAI (importado perezosamente: el módulo no exige la key al cargar). */
export const openAiCompleter: AddressAiCompleter = async ({ model, system, user, timeoutMs }) => {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: (process.env.OPENAI_API_KEY ?? "").trim(), timeout: timeoutMs, maxRetries: 0 });
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: ADDRESS_AI_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: ADDRESS_AI_JSON_SCHEMA },
  });
  return completion.choices[0]?.message?.content ?? "";
};

/** Parsea y valida la salida del modelo contra el esquema. null = no válida. */
export function parseAddressAiVerdict(raw: string): AddressAiVerdict | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AddressAiVerdict>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.veredicto !== "correcta" && parsed.veredicto !== "dudosa" && parsed.veredicto !== "incorrecta") return null;
    if (!Array.isArray(parsed.problemas) || !parsed.problemas.every((p) => typeof p === "string")) return null;
    if (typeof parsed.confianza !== "number" || !Number.isFinite(parsed.confianza) || parsed.confianza < 0 || parsed.confianza > 1) return null;
    return { veredicto: parsed.veredicto, problemas: parsed.problemas.map((p) => p.slice(0, 200)), confianza: parsed.confianza };
  } catch {
    return null;
  }
}

/**
 * Evalúa la dirección con el modelo. NUNCA lanza: cualquier fallo se
 * convierte en "dudosa" con el motivo (fail-closed), listo para auditar.
 */
export async function evaluateAddressWithAi(
  input: AddressAiInput,
  deps: { complete?: AddressAiCompleter; env?: Record<string, string | undefined> } = {}
): Promise<AddressAiResult> {
  const env = deps.env ?? process.env;
  const model = addressAiModel(env);
  const timeoutMs = addressAiTimeoutMs(env);
  const complete = deps.complete ?? openAiCompleter;
  const failClosed = (reason: string, raw: string, confidence: number | null = null): AddressAiResult => ({
    layer: 2, verdict: "dudosa", problems: [`sin_confirmar:${reason}`], confidence, model, raw, fromModel: false,
  });

  let raw = "";
  // Guarda de timeout PROPIA además de la del cliente: si el proveedor no
  // responde nunca, el veredicto sigue siendo "dudosa" en timeoutMs+500.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race<string>([
      complete({ model, system: ADDRESS_AI_SYSTEM_PROMPT, user: buildAddressAiUserPrompt(input), timeoutMs }),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs} ms`)), timeoutMs + 500); }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failClosed(/timeout/i.test(message) ? "timeout_llamada_ia" : "fallo_llamada_ia", message.slice(0, 500));
  } finally {
    if (timer) clearTimeout(timer);
  }

  const parsed = parseAddressAiVerdict(raw);
  if (!parsed) return failClosed("respuesta_ia_invalida", raw.slice(0, 2000));
  if (parsed.confianza < ADDRESS_AI_MIN_CONFIDENCE) {
    return {
      layer: 2,
      verdict: "dudosa",
      problems: [`sin_confirmar:confianza_baja_${parsed.confianza.toFixed(2)}`, ...parsed.problemas],
      confidence: parsed.confianza,
      model,
      raw: raw.slice(0, 2000),
      fromModel: true,
    };
  }
  return { layer: 2, verdict: parsed.veredicto, problems: parsed.problemas, confidence: parsed.confianza, model, raw: raw.slice(0, 2000), fromModel: true };
}
