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
}

export type ParsedCallEventType = "call_started" | "call_ended" | "call_analyzed";

export interface ParsedCallEvent {
  type: ParsedCallEventType;
  providerCallId: string;
  /** epoch segundos del evento si el proveedor lo da. */
  eventAt: number | null;
  /** Estado técnico del proveedor (call_status / disconnection_reason). */
  providerStatus: string | null;
  disconnectionReason: string | null;
  durationMs: number | null;
  /** Datos de análisis (call_analyzed): resultado + correcciones, en crudo. */
  analysis: Record<string, unknown> | null;
}

/** Se lanza cuando el proveedor RECHAZA la petición antes de aceptarla. */
export class ProviderRequestError extends Error {
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ProviderRequestError";
    this.httpStatus = httpStatus;
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
