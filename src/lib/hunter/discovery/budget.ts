// ============================================================
// PRESUPUESTO DE UNA BÚSQUEDA (07-09-2026) — docs/HUNTER-DISCOVERY-AUDITORIA.md
//
// Una búsqueda por una sola palabra que expande términos y pagina de forma
// agresiva puede tirarse quince minutos y cientos de peticiones. Sin un
// presupuesto explícito, lo único que la para es quedarse sin términos… o que
// Meta corte el token, que es justo lo que hay que evitar.
//
// Tres frenos, y los tres dicen POR QUÉ pararon:
//   · deadline    — tiempo de pared (el objetivo declarado: ~15 min)
//   · maxRequests — peticiones HTTP totales contra la Graph API
//   · cuota Meta  — la cabecera x-app-usage que ya se leía y se tiraba
//
// El presupuesto se comparte entre términos y páginas: es de la CORRIDA, no
// de cada llamada. Es un objeto mutable a propósito, para poder inyectarlo en
// los tests y observar el consumo.
// ============================================================

export type StopReason =
  | "completado"
  | "deadline"
  | "presupuesto_peticiones"
  | "cuota_meta"
  | "rate_limit"
  | "token_invalido"
  | "permiso"
  | "parada_emergencia"
  | "error";

export interface DiscoveryBudgetOptions {
  /** Instante (ms epoch) a partir del cual no se empieza ninguna petición nueva. */
  deadlineAt?: number;
  /** Tope de peticiones HTTP de toda la corrida. */
  maxRequests?: number;
  /** Porcentaje de uso de la cuota de Meta a partir del cual se para (x-app-usage). */
  maxUsagePercent?: number;
  now?: () => number;
}

export class DiscoveryBudget {
  readonly deadlineAt: number;
  readonly maxRequests: number;
  readonly maxUsagePercent: number;
  private readonly now: () => number;
  requests = 0;
  /** Mayor porcentaje visto en las cabeceras de cuota de Meta. */
  usagePercent = 0;

  constructor(opts: DiscoveryBudgetOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.deadlineAt = opts.deadlineAt ?? this.now() + 15 * 60_000;
    this.maxRequests = opts.maxRequests ?? 400;
    this.maxUsagePercent = opts.maxUsagePercent ?? 85;
  }

  /** ¿Se puede empezar otra petición? Devuelve el motivo si no. */
  check(): StopReason | null {
    if (this.requests >= this.maxRequests) return "presupuesto_peticiones";
    if (this.now() >= this.deadlineAt) return "deadline";
    if (this.usagePercent >= this.maxUsagePercent) return "cuota_meta";
    return null;
  }

  spend(): void {
    this.requests += 1;
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.now());
  }

  /**
   * Lee el uso declarado por Meta. `x-app-usage` trae porcentajes
   * (call_count, total_cputime, total_time): se queda con el mayor visto.
   */
  observeRateLimit(rateLimit: Record<string, unknown> | null): void {
    if (!rateLimit) return;
    for (const valor of Object.values(rateLimit)) {
      if (!valor || typeof valor !== "object") continue;
      for (const n of Object.values(valor as Record<string, unknown>)) {
        const num = Number(n);
        if (Number.isFinite(num) && num > this.usagePercent) this.usagePercent = num;
      }
    }
  }
}

/** Une las cabeceras de cuota de varias llamadas quedándose con el mayor uso. */
export function mergeRateLimits(
  acumulado: Record<string, unknown> | null,
  nuevo: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!nuevo) return acumulado;
  if (!acumulado) return nuevo;
  return { ...acumulado, ...nuevo };
}
