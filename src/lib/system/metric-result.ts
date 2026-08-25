// ============================================================
// MÉTRICAS FAIL-CLOSED — "0" y "no lo sé" no se pintan igual.
//
// El patrón peligroso que esto sustituye:
//
//     try { ...consulta... } catch { return 0; }
//
// Ante un fallo devuelve un número plausible. El panel lo enseña como si
// fuera un dato, nadie se entera, y una decisión de negocio se toma sobre
// una cifra inventada. En un sistema donde la tasa de entrega decide si la
// publicidad es rentable, eso es peor que no tener la métrica.
//
// Aquí toda métrica declara CON QUÉ CONFIANZA responde:
//
//   ok       → se calculó entera y con datos suficientes
//   partial  → se calculó, pero falta parte (una sección falló, o la muestra
//              es demasiado pequeña para afirmar nada)
//   unknown  → no hay datos todavía. NO es un error: es una respuesta.
//   error    → algo falló. NUNCA se acompaña de un número.
//
// La diferencia entre `unknown` y `error` importa: "aún no ha pasado nada"
// se arregla esperando; "la consulta revienta" se arregla mirando el log.
// ============================================================

import pino from "pino";
import { logIntegrationEvent } from "./repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export type MetricStatus = "ok" | "partial" | "unknown" | "error";

export interface Measured<T> {
  status: MetricStatus;
  /** `null` siempre que `status === "error"`. Nunca un número de relleno. */
  value: T | null;
  /** Mensaje técnico si falló. Sin PII. */
  error: string | null;
  /** Qué partes no se pudieron calcular (status `partial`). */
  degraded: string[];
}

export function ok<T>(value: T, degraded: string[] = []): Measured<T> {
  return { status: degraded.length ? "partial" : "ok", value, error: null, degraded };
}

export function unknown<T>(motivo: string): Measured<T> {
  return { status: "unknown", value: null, error: null, degraded: [motivo] };
}

export function failed<T>(err: unknown, contexto: string): Measured<T> {
  const mensaje = err instanceof Error ? err.message : String(err);
  logger.error({ err: mensaje }, `[METRICS] ${contexto} falló`);
  logIntegrationEvent(
    "system",
    "metric_failed",
    "warning",
    `la métrica "${contexto}" no se pudo calcular: ${mensaje}`
  );
  return { status: "error", value: null, error: mensaje, degraded: [] };
}

/**
 * Ejecuta un cálculo de métrica capturando el fallo como ESTADO, no como
 * valor de relleno. Es lo contrario de `catch { return 0 }`.
 */
export function measure<T>(contexto: string, fn: () => T): Measured<T> {
  try {
    return ok(fn());
  } catch (err) {
    return failed<T>(err, contexto);
  }
}

/**
 * Igual, pero para métricas compuestas por partes que pueden fallar por
 * separado: si una sección revienta, el resto se conserva y la métrica queda
 * `partial` con el detalle de lo que falta — en vez de perderlo todo o, peor,
 * fingir que la parte rota valía cero.
 */
export function measureParts<T extends Record<string, unknown>>(
  contexto: string,
  partes: { [K in keyof T]: () => T[K] }
): Measured<T> {
  const out = {} as T;
  const degraded: string[] = [];
  for (const clave of Object.keys(partes) as Array<keyof T>) {
    try {
      out[clave] = partes[clave]();
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      degraded.push(`${String(clave)}: ${mensaje}`);
      logger.warn({ err: mensaje }, `[METRICS] ${contexto}.${String(clave)} falló`);
    }
  }
  if (degraded.length === Object.keys(partes).length) {
    return failed<T>(new Error(degraded.join(" | ")), contexto);
  }
  if (degraded.length) {
    logIntegrationEvent(
      "system",
      "metric_partial",
      "info",
      `la métrica "${contexto}" salió incompleta: ${degraded.length} parte(s) sin calcular`
    );
  }
  return ok(out, degraded);
}

/**
 * ¿Hay muestra suficiente para AFIRMAR una tasa?
 *
 * Con 3 pedidos resueltos, una tasa del 33 % no significa nada, y enseñarla
 * como si significara algo dispara alertas y decisiones falsas. Por debajo
 * del mínimo la métrica es `partial`: se ve el dato en crudo, pero queda
 * marcado que todavía no se puede concluir.
 */
export function withMinimumSample<T>(m: Measured<T>, resueltos: number, minimo: number): Measured<T> {
  if (m.status !== "ok" || resueltos >= minimo) return m;
  return {
    ...m,
    status: "partial",
    degraded: [
      ...m.degraded,
      `muestra insuficiente: ${resueltos} pedido(s) resuelto(s) de los ${minimo} necesarios para afirmar una tasa`,
    ],
  };
}
