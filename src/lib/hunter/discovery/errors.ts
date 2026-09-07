// ============================================================
// CLASIFICACIÓN DE ERRORES DE LA AD LIBRARY (07-09-2026)
// docs/HUNTER-DISCOVERY-AUDITORIA.md
//
// El cliente lanzaba un Error genérico ante cualquier respuesta no-2xx y nadie
// lo capturaba: un 429 en el minuto 14 de una búsqueda larga tiraba la corrida
// entera, quemaba la cuota y no persistía ni una fila. Aquí se decide, con el
// código de Meta en la mano, si conviene esperar y reintentar, parar del todo,
// o rendirse con lo que ya se tenga.
//
// Códigos de Meta (los que este repo ya conocía por el proveedor del PI
// Engine, más los del contrato de Ad Library):
//   4    · límite de llamadas de la APLICACIÓN
//   17   · límite de llamadas del USUARIO
//   32   · límite de la página
//   613  · límite personalizado (throttling agresivo)
//   80004· límite específico de Ad Library
//   190  · token caducado o inválido  → NO se reintenta jamás
//   102  · sesión caducada            → NO se reintenta
//   10 / 200-299 · permiso que la app no tiene → NO se reintenta
// ============================================================

export type AdLibraryErrorKind = "rate_limit" | "token_invalido" | "permiso" | "transitorio" | "fatal" | "parada_emergencia";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);
const TOKEN_CODES = new Set([102, 190, 463, 467]);
const PERMISSION_CODES = new Set([10, 200, 272, 294]);

export interface AdLibraryErrorClass {
  kind: AdLibraryErrorKind;
  /** ¿Tiene sentido volver a intentarlo con espera? */
  retryable: boolean;
  /** ¿Hay que abandonar la corrida entera, aunque queden términos? */
  abortRun: boolean;
  detail: string;
}

export function classifyAdLibraryError(status: number, code: number | null | undefined, message = ""): AdLibraryErrorClass {
  const c = typeof code === "number" ? code : null;
  if (c !== null && TOKEN_CODES.has(c)) {
    return { kind: "token_invalido", retryable: false, abortRun: true, detail: `token caducado o inválido (code ${c}): renovar META_AD_LIBRARY_ACCESS_TOKEN` };
  }
  if (status === 401 || /access token|session has expired|OAuthException/i.test(message)) {
    return { kind: "token_invalido", retryable: false, abortRun: true, detail: "el token no autentica: renovar META_AD_LIBRARY_ACCESS_TOKEN" };
  }
  if (c !== null && RATE_LIMIT_CODES.has(c)) {
    return { kind: "rate_limit", retryable: true, abortRun: false, detail: `límite de cuota de Meta (code ${c}): esperar y reintentar` };
  }
  if (status === 429) {
    return { kind: "rate_limit", retryable: true, abortRun: false, detail: "HTTP 429: demasiadas peticiones, esperar y reintentar" };
  }
  if (c !== null && PERMISSION_CODES.has(c)) {
    return { kind: "permiso", retryable: false, abortRun: true, detail: `la app no tiene permiso para esta consulta (code ${c}): revisar el acceso a /ads_archive` };
  }
  if (status === 403) {
    return { kind: "permiso", retryable: false, abortRun: true, detail: "HTTP 403: la app no tiene acceso a /ads_archive" };
  }
  if (status >= 500 || status === 0) {
    return { kind: "transitorio", retryable: true, abortRun: false, detail: `fallo temporal de Meta (HTTP ${status || "sin respuesta"})` };
  }
  return { kind: "fatal", retryable: false, abortRun: false, detail: `respuesta no esperada (HTTP ${status}${c !== null ? `, code ${c}` : ""})` };
}

export class AdLibraryError extends Error {
  readonly kind: AdLibraryErrorKind;
  readonly retryable: boolean;
  readonly abortRun: boolean;
  readonly status: number;
  readonly code: number | null;

  constructor(status: number, code: number | null, message: string, kindOverride?: AdLibraryErrorKind) {
    // El texto conserva la forma anterior para no romper diagnósticos ya escritos.
    super(message);
    this.name = "AdLibraryError";
    this.status = status;
    this.code = code;
    if (kindOverride) {
      this.kind = kindOverride;
      // Una parada de emergencia no se reintenta NUNCA y corta la corrida.
      this.retryable = false;
      this.abortRun = true;
      return;
    }
    const clase = classifyAdLibraryError(status, code, message);
    this.kind = clase.kind;
    this.retryable = clase.retryable;
    this.abortRun = clase.abortRun;
  }
}

export const DISCOVERY_HALTED_MESSAGE =
  "EMERGENCY_STOP activo: el Cazador no sale a Internet. Ninguna busqueda se ejecuta, se reintenta ni se encola hasta que se desactive (EMERGENCY_STOP=0).";

/** La parada de emergencia, como error explicito y reconocible. */
export class DiscoveryHaltedError extends AdLibraryError {
  constructor(message: string = DISCOVERY_HALTED_MESSAGE) {
    super(0, null, message, "parada_emergencia");
    this.name = "DiscoveryHaltedError";
  }
}

/** Un fallo de red (sin respuesta HTTP) también es transitorio, no fatal. */
export function asAdLibraryError(err: unknown): AdLibraryError {
  if (err instanceof AdLibraryError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // AbortSignal.timeout produce TimeoutError; DNS/socket producen TypeError.
  return new AdLibraryError(0, null, `sin respuesta de Meta: ${message.slice(0, 250)}`);
}

/** Espera con backoff exponencial y jitter determinista por intento. */
export function backoffMs(attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  const exponencial = Math.min(maxMs, baseMs * 2 ** attempt);
  // Jitter fijo por intento (no aleatorio): reproducible en tests y suficiente
  // para no sincronizar dos procesos que fallan a la vez.
  const jitter = (attempt % 3) * 137;
  return exponencial + jitter;
}
