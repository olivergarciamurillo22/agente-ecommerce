// ============================================================
// Frontera con el proveedor de VOZ. El dominio (scheduler, resultados,
// panel) habla SOLO con esta interfaz — nunca con el SDK/HTTP de Retell
// directamente. No es una abstracción para 50 proveedores: es la costura
// mínima para poder testear sin red y cambiar de proveedor sin reescribir.
// ============================================================

export interface OutboundCallRequest {
  /** E.164 con '+'. */
  toNumber: string;
  fromNumber: string;
  /** Variables dinámicas EXACTAS (minimización: nada del payload completo). */
  dynamicVariables: Record<string, string>;
  /** Referencia nuestra (attempt id, pedido) para reconciliar. */
  metadata: Record<string, string>;
}

export interface OutboundCallAccepted {
  providerCallId: string;
  /** Qué agente/versión usó el proveedor de verdad (si lo reporta). */
  agentId?: string | null;
  agentVersion?: string | null;
  /** Versión que NOSOTROS pedimos (pin). Si difiere de agentVersion: deriva. */
  requestedAgentVersion?: string | null;
}

export type ParsedCallEventType = "call_started" | "call_ended" | "call_analyzed";

export interface ParsedCallEvent {
  type: ParsedCallEventType;
  providerCallId: string;
  /** Versión del agente según el propio evento (call.agent_version). */
  agentVersion?: string | null;
  /** epoch segundos del evento si el proveedor lo da. */
  eventAt: number | null;
  /** Estado técnico del proveedor (call_status / disconnection_reason). */
  providerStatus: string | null;
  disconnectionReason: string | null;
  durationMs: number | null;
  /** Datos de análisis (call_analyzed): resultado + correcciones, en crudo. */
  analysis: Record<string, unknown> | null;
}

/**
 * Clase del fallo, porque NO todos los errores admiten reintento:
 *   config          → nuestra configuración (versión sin fijar…): no hay llamada
 *   invalid_payload → 400/422: repetir el MISMO payload es inútil
 *   auth            → 401: bloquear llamadas hasta arreglar la key
 *   billing         → 402: bloquear llamadas (cuestan dinero)
 *   rate_limit      → 429: la petición fue RECHAZADA, reintentar es seguro
 *   transient       → rechazo claro y temporal (sin llamada creada)
 *   ambiguous       → timeout / red / 5xx: Retell PUDO haber creado la
 *                     llamada. Sin idempotency key en la API, reintentar
 *                     = riesgo de DOS llamadas al cliente → revisión manual.
 *   unknown         → cualquier otra cosa: revisión manual.
 */
export type ProviderErrorKind =
  | "config"
  | "invalid_payload"
  | "auth"
  | "billing"
  | "rate_limit"
  | "transient"
  | "ambiguous"
  | "unknown";

export function classifyProviderHttpStatus(status: number | null): ProviderErrorKind {
  if (status === null || status === 0) return "ambiguous";
  if (status === 400 || status === 422) return "invalid_payload";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "ambiguous";
  return "unknown";
}

/** ¿Se puede volver a intentar sin riesgo de crear una segunda llamada? */
export function providerErrorRetryable(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "transient";
}

/** Se lanza cuando el proveedor RECHAZA la petición (o no sabemos si la aceptó). */
export class ProviderRequestError extends Error {
  readonly httpStatus: number | null;
  readonly kind: ProviderErrorKind;
  constructor(message: string, httpStatus: number | null = null, kind?: ProviderErrorKind) {
    super(message);
    this.name = "ProviderRequestError";
    this.httpStatus = httpStatus;
    this.kind = kind ?? classifyProviderHttpStatus(httpStatus);
  }
}

export interface CallProvider {
  readonly name: string;
  /** Credenciales + número saliente presentes. */
  isConfigured(): boolean;
  createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallAccepted>;
  /** Verifica la firma del webhook sobre el RAW body. */
  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs?: number): boolean;
  /** Parsea un evento entrante. null = forma desconocida (no reventar). */
  parseEvent(rawBody: string): ParsedCallEvent | null;
}
