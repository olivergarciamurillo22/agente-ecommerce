// ============================================================
// TOPE DIARIO DE LLAMADAS A OPENAI (07-09-2026) — docs/COSTE-IA.md
//
// Hay dos capas que llaman a OpenAI (validación de direcciones y clasificación
// de intención post-confirmación). Sin techo, un pico de mensajes o un bucle
// por error puede convertir un coste de céntimos en una factura. Esto pone un
// tope POR TIPO DE LLAMADA y, al alcanzarse, la capa deja de llamar a la API.
//
// CÓMO SE CUENTA, y por qué así: una fila por llamada en `ai_call_log`, y el
// tope es un `COUNT(*)` sobre esa tabla desde la medianoche de Madrid. Es el
// mismo patrón que el tope diario de llamadas de teléfono
// (`countCallsStartedSince` + `callsDailyCap`), y es el único seguro aquí: el
// bot y el panel son procesos distintos sobre la misma SQLite, así que un
// contador de leer-sumar-escribir en `settings` se pisaría entre procesos y el
// tope se superaría.
//
// SE CUENTA EL INTENTO, no el éxito: la fila se escribe ANTES de llamar. Un
// timeout o un 500 también consumen cuota en la práctica, y contar solo los
// éxitos dejaría un agujero por el que se cuela justo el caso malo (un fallo
// que se repite).
//
// NO cuenta OpenRouter (`src/lib/openrouter.ts`): esa es otra cuenta y otra
// clave (OPENROUTER_API_KEY), y el agente conversacional del kit no forma
// parte del flujo COD.
//
// PRIORIDAD DE CONFIGURACIÓN (igual que las llaves de llamadas): la clave de
// `settings` gana a la variable de entorno, y esta al default. Así el tope se
// puede subir desde el panel un día de pico sin desplegar.
// ============================================================

import { getSetting, systemDbHandle } from "../db";
import { startOfBusinessDay } from "../time";

export type AiCallKind = "address" | "intent";

/** Tope por tipo y día. 500 es ~10× el volumen actual: no estorba, pero acota. */
export const AI_DAILY_LIMIT_DEFAULT = 500;

const ENV_BY_KIND: Record<AiCallKind, string> = {
  address: "OPENAI_DAILY_CALL_LIMIT_ADDRESS",
  intent: "OPENAI_DAILY_CALL_LIMIT_INTENT",
};
const SETTING_BY_KIND: Record<AiCallKind, string> = {
  address: "openai_daily_call_limit_address",
  intent: "openai_daily_call_limit_intent",
};

function cfg(settingKey: string, envName: string, fallbackEnv: string, env: Record<string, string | undefined>): string {
  let db: string | null = null;
  try {
    db = getSetting(settingKey);
  } catch {
    db = null; // sin base (tests puros): se cae a env/default
  }
  if (db !== null && db.trim() !== "") return db.trim();
  const propio = (env[envName] ?? "").trim();
  if (propio !== "") return propio;
  return (env[fallbackEnv] ?? "").trim();
}

/** Tope vigente para ese tipo. 0 o negativo = sin tope (se avisa en el doctor). */
export function aiDailyLimit(kind: AiCallKind, env: Record<string, string | undefined> = process.env): number {
  const raw = cfg(SETTING_BY_KIND[kind], ENV_BY_KIND[kind], "OPENAI_DAILY_CALL_LIMIT", env);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return AI_DAILY_LIMIT_DEFAULT;
  return n;
}

/** Llamadas ya intentadas hoy (desde la medianoche de Madrid). */
export function aiCallsToday(kind: AiCallKind, nowMs = Date.now()): number {
  const r = systemDbHandle()
    .prepare("SELECT COUNT(*) AS n FROM ai_call_log WHERE kind = ? AND created_at >= ?")
    .get(kind, startOfBusinessDay(nowMs)) as { n: number };
  return r.n;
}

/** Registra el INTENTO. Se llama justo antes de salir a la API. Nunca lanza. */
export function recordAiCall(kind: AiCallKind, orderId: number | null = null): void {
  try {
    systemDbHandle().prepare("INSERT INTO ai_call_log (kind, order_id) VALUES (?, ?)").run(kind, orderId);
  } catch {
    /* la auditoría de coste jamás rompe el flujo del pedido */
  }
}

export interface AiBudgetVerdict {
  /** true = NO se puede llamar a la API. */
  exhausted: boolean;
  limit: number;
  used: number;
  remaining: number;
  reason: string | null;
}

/**
 * ¿Queda cuota para una llamada más de este tipo? Fail-closed en el sentido
 * útil: si la base no se puede leer, se DEJA pasar (el tope es una protección
 * de coste, no de seguridad; bloquear el flujo del pedido por no poder contar
 * sería peor que el gasto que evita).
 */
export function aiBudget(kind: AiCallKind, env: Record<string, string | undefined> = process.env, nowMs = Date.now()): AiBudgetVerdict {
  const limit = aiDailyLimit(kind, env);
  if (limit <= 0) return { exhausted: false, limit, used: 0, remaining: Number.POSITIVE_INFINITY, reason: null };
  let used = 0;
  try {
    used = aiCallsToday(kind, nowMs);
  } catch {
    return { exhausted: false, limit, used: 0, remaining: limit, reason: null };
  }
  const remaining = Math.max(0, limit - used);
  return {
    exhausted: used >= limit,
    limit,
    used,
    remaining,
    reason: used >= limit ? `tope diario de llamadas a OpenAI alcanzado (${used}/${limit} para '${kind}')` : null,
  };
}

/**
 * Qué hace la capa de direcciones cuando se agota la cuota.
 *  - 'dudosa' (DEFAULT, decisión de Pedro): veredicto dudoso → ALERTA_DIRECCION
 *    → una persona la revisa. Es fail-closed estricto: nunca se da por buena
 *    una dirección que no se ha podido validar. Contrapartida real: esos
 *    pedidos quedan con el auto-despacho RETENIDO hasta que alguien cierre la
 *    alerta, así que agotar la cuota se nota en la bandeja.
 *  - 'omitir': la capa 2 declara `no_ejecutada` y manda el veredicto de la
 *    capa 1 determinista, exactamente como cuando la IA está apagada (que es
 *    el estado de producción hoy). No abre alertas ni retiene despachos, y el
 *    pedido se reevalúa mañana cuando la cuota vuelva.
 */
export function addressLimitFallback(env: Record<string, string | undefined> = process.env): "dudosa" | "omitir" {
  return (env.OPENAI_LIMIT_ADDRESS_FALLBACK ?? "").trim().toLowerCase() === "omitir" ? "omitir" : "dudosa";
}

/** Coste declarado por llamada (docs/COSTE-IA.md). Solo para informes. */
export const AI_COST_PER_CALL_EUR = 0.0001;

export function aiBudgetSummary(env: Record<string, string | undefined> = process.env, nowMs = Date.now()): {
  kinds: Array<AiBudgetVerdict & { kind: AiCallKind }>;
  maxDailyCostEur: number;
} {
  const kinds = (["address", "intent"] as AiCallKind[]).map((kind) => ({ kind, ...aiBudget(kind, env, nowMs) }));
  const topes = kinds.reduce((acc, k) => acc + (k.limit > 0 ? k.limit : 0), 0);
  return { kinds, maxDailyCostEur: Math.round(topes * AI_COST_PER_CALL_EUR * 10000) / 10000 };
}
