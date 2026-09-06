// ============================================================
// AI Winner Radar — ETAPAS DE UNA BÚSQUEDA Y TIEMPO ESTIMADO.
//
// Una búsqueda tarda minutos, no segundos: son decenas de llamadas a Meta con
// su propio ritmo, más análisis de IA. Un spinner durante tres minutos hace
// creer que la aplicación se ha colgado, y la reacción normal es recargar —
// que tira el trabajo y vuelve a gastar llamadas.
//
// Por eso la búsqueda se cuenta por ETAPAS con nombre y con contadores
// reales. No es decoración: es la diferencia entre «esto está roto» y «va por
// la tercera de seis».
//
// SOBRE EL TIEMPO ESTIMADO — la regla es no mentir:
//   · Con histórico de búsquedas parecidas → media real, escalada por número
//     de consultas.
//   · Sin histórico → heurística, y la interfaz dice «suele tardar 2-4
//     minutos» en vez de prometer un segundero exacto.
// Prometer «1 min 12 s» sin saberlo y tardar cuatro es peor que no estimar.
// ============================================================

export type StageKey = "interpret" | "explore" | "cluster" | "creative" | "score" | "select";
export type StageStatus = "pending" | "active" | "complete" | "failed" | "skipped";

export interface StageDef {
  key: StageKey;
  label: string;
  /** Qué está pasando, en lenguaje de persona. */
  hint: string;
  /** Peso sobre el total, para la barra y para repartir el ETA. Suma 1. */
  weight: number;
}

/**
 * El orden es el orden real de ejecución. `explore` se lleva más de la mitad
 * del peso porque es donde se va el tiempo de verdad: cada consulta a Meta
 * lleva su pausa de cortesía para no chocar con la cuota.
 */
export const STAGES: readonly StageDef[] = [
  { key: "interpret", label: "Interpretando tu búsqueda", hint: "Traduciendo lo que has pedido a criterios y consultas", weight: 0.08 },
  { key: "explore", label: "Explorando Meta", hint: "Recorriendo la Biblioteca de Anuncios consulta a consulta", weight: 0.52 },
  { key: "cluster", label: "Agrupando productos", hint: "Reuniendo los anuncios que venden lo mismo", weight: 0.06 },
  { key: "creative", label: "Analizando creatividades", hint: "Leyendo los anuncios para entender ángulo y formato", weight: 0.18 },
  { key: "score", label: "Calculando oportunidad", hint: "Cruzando mercado, producto y tus números", weight: 0.08 },
  { key: "select", label: "Preparando tu selección", hint: "Ordenando lo que merece la pena y redactando el informe", weight: 0.08 },
] as const;

export const STAGE_KEYS: readonly StageKey[] = STAGES.map((s) => s.key);

export interface StageState {
  key: StageKey;
  label: string;
  hint: string;
  status: StageStatus;
  startedAt: number | null;
  completedAt: number | null;
  /** Una línea de resultado: «1.284 anuncios revisados». Nunca un log técnico. */
  summary: string | null;
  /** Contadores en crudo para la interfaz. Sin secretos ni prompts. */
  counters: Record<string, number>;
}

export function initialStages(): StageState[] {
  return STAGES.map((s) => ({
    key: s.key,
    label: s.label,
    hint: s.hint,
    status: "pending",
    startedAt: null,
    completedAt: null,
    summary: null,
    counters: {},
  }));
}

export function stageDef(key: StageKey): StageDef {
  return STAGES.find((s) => s.key === key) ?? STAGES[0];
}

/** Fracción completada 0..1, contando la etapa activa a mitad de su peso. */
export function stageProgress(stages: StageState[]): number {
  let acc = 0;
  for (const s of stages) {
    const w = stageDef(s.key).weight;
    if (s.status === "complete" || s.status === "skipped") acc += w;
    else if (s.status === "active") acc += w * 0.5;
    else if (s.status === "failed") acc += w; // fallida es terminada: no bloquea la barra
  }
  return Math.min(1, Math.max(0, acc));
}

// ------------------------------------------------------------
// Estimación de duración
// ------------------------------------------------------------

/** Segundos por consulta a un proveedor de anuncios, pausa de cortesía incluida. */
const SECONDS_PER_QUERY = 3.2;
/** Segundos por producto analizado con IA. */
const SECONDS_PER_AI_ANALYSIS = 2.6;
/** Coste fijo: interpretar + informe final. */
const FIXED_SECONDS = 14;
/** Suelo y techo: fuera de esto la estimación deja de ser creíble. */
const MIN_ESTIMATE = 25;
const MAX_ESTIMATE = 900;

export interface EstimateInput {
  queries: number;
  providers: number;
  /** Tope de análisis de IA de esta búsqueda. */
  aiBudget: number;
  /** Muestras históricas: duraciones reales en segundos por consulta. */
  historicalSecondsPerQuery?: number | null;
}

export interface DurationEstimate {
  seconds: number;
  /** true si sale de búsquedas anteriores; false si es la heurística. */
  fromHistory: boolean;
  /** Texto honesto para la interfaz. */
  label: string;
}

export function estimateDuration(input: EstimateInput): DurationEstimate {
  const consultas = Math.max(1, input.queries) * Math.max(1, input.providers);
  const porConsulta = input.historicalSecondsPerQuery ?? null;
  const fromHistory = porConsulta !== null && porConsulta > 0;

  const bruto = fromHistory
    ? FIXED_SECONDS + consultas * porConsulta
    : FIXED_SECONDS + consultas * SECONDS_PER_QUERY + input.aiBudget * SECONDS_PER_AI_ANALYSIS;

  const seconds = Math.round(Math.min(MAX_ESTIMATE, Math.max(MIN_ESTIMATE, bruto)));
  return {
    seconds,
    fromHistory,
    // Sin histórico no se promete un segundero: se da la horquilla honesta.
    label: fromHistory ? formatDuration(seconds) : `${formatDuration(Math.round(seconds * 0.7))}–${formatDuration(Math.round(seconds * 1.6))}`,
  };
}

/**
 * Tiempo restante, recalculado con lo que YA ha tardado. Si va lento, el
 * número sube: una cuenta atrás que se estanca en «quedan 10 s» durante dos
 * minutos destruye la confianza en todo lo demás de la pantalla.
 */
export function remainingSeconds(opts: {
  startedAt: number;
  now: number;
  progress: number;
  estimateSeconds: number;
}): number | null {
  const transcurrido = Math.max(0, opts.now - opts.startedAt);
  if (opts.progress <= 0.02) return Math.max(0, opts.estimateSeconds - transcurrido);
  if (opts.progress >= 0.999) return 0;
  // Proyección por ritmo real, promediada con la estimación inicial para que
  // no pegue saltos absurdos con los primeros puntos.
  const proyectado = transcurrido / opts.progress;
  const mezcla = proyectado * 0.65 + opts.estimateSeconds * 0.35;
  return Math.max(0, Math.round(mezcla - transcurrido));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r === 0 ? `${m} min` : `${m} min ${r} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
