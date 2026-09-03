// ============================================================
// Adaptador de Retell — contrato verificado contra docs.retellai.com el
// 24-08-2026 y re-verificado el 03-09-2026 (hardening):
//   POST https://api.retellai.com/v2/create-phone-call
//     Authorization: Bearer <RETELL_API_KEY>
//     body: { from_number, to_number, retell_llm_dynamic_variables,
//             metadata, override_agent_id? }  → 201 { call_id, ... }
//   Webhook: la verificación vive en ./retell-webhook.ts, alineada con la
//     fuente del SDK oficial. OJO: solo la API key con "webhook badge"
//     firma los webhooks salientes (causa del incidente del 03-09).
//   Eventos: call_started | call_ended | call_analyzed, con { event, call }
//     y call.call_analysis.custom_analysis_data para el análisis.
//   Política 03-09: override_agent_version SIEMPRE numérico (pin);
//   errores clasificados (ambiguo → revisión manual, nunca reintento ciego);
//   firma SOLO en formato oficial con timestamp (sin fallback replayable).
// ============================================================

import { validateRetellCallVariables } from "./payload";
import { verifyRetellWebhookSignature } from "./retell-webhook";
import {
  ProviderRequestError,
  type CallProvider,
  type OutboundCallAccepted,
  type OutboundCallRequest,
  type ParsedCallEvent,
  type ParsedCallEventType,
} from "./provider";

const API_BASE = "https://api.retellai.com";

function apiKey(): string {
  return (process.env.RETELL_API_KEY ?? "").trim();
}
export function retellFromNumber(): string {
  return (process.env.RETELL_FROM_NUMBER ?? "").trim();
}
function agentId(): string {
  return (process.env.RETELL_AGENT_ID ?? "").trim();
}

/**
 * Política de versión del agente (incidente "[password 1]", 02-09): las
 * llamadas por API usan la ÚLTIMA versión GUARDADA del agente — una edición
 * accidental del dashboard cambia las llamadas reales al instante. Con
 * RETELL_AGENT_VERSION fijada, cada llamada lleva override_agent_version
 * (contrato oficial: NÚMERO de versión publicada; "latest_published" y los
 * tags los admite la API pero aquí se rechazan porque se mueven solos).
 * Sin fijar, no sale ninguna llamada y se avisa en salud y en el doctor.
 */
export function retellAgentVersion(): string {
  return (process.env.RETELL_AGENT_VERSION ?? "").trim();
}

/**
 * Política de pin (hardening 03-09): SOLO un número de versión PUBLICADA.
 * La API admite también "latest", "latest_published" o un tag de entorno
 * (docs create-phone-call), pero todos ellos SE MUEVEN: alguien publica o
 * mueve el tag y las llamadas cambian sin que nadie toque el .env. Con un
 * número, "qué versión dijo esto" tiene una sola respuesta.
 */
export function agentVersionPinIssue(version: string): string | null {
  if (!version) return "RETELL_AGENT_VERSION no está fijada";
  if (!/^\d+$/.test(version)) return `RETELL_AGENT_VERSION="${version}" no es un número de versión publicada (los tags y "latest*" se mueven solos)`;
  return null;
}

/** Deriva: pedimos la versión X y Retell resolvió Y. */
export function agentVersionDrift(requested: string | null, resolved: string | null): boolean {
  if (!requested || !resolved) return false;
  return requested.trim() !== resolved.trim();
}

/**
 * Cuerpo EXACTO de POST /v2/create-phone-call (contrato verificado contra
 * docs.retellai.com el 03-09-2026). Exportado para el golden test: cualquier
 * campo nuevo tiene que pasar por aquí y por el fixture.
 */
export function buildCreatePhoneCallBody(req: OutboundCallRequest, version: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from_number: req.fromNumber,
    to_number: req.toNumber,
    retell_llm_dynamic_variables: req.dynamicVariables,
    metadata: req.metadata,
  };
  if (agentId()) body.override_agent_id = agentId();
  body.override_agent_version = Number(version);
  return body;
}

export const retellProvider: CallProvider = {
  name: "retell",

  isConfigured(): boolean {
    return Boolean(apiKey() && retellFromNumber());
  },

  async createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallAccepted> {
    if (!this.isConfigured()) {
      throw new ProviderRequestError("Retell no configurado (RETELL_API_KEY / RETELL_FROM_NUMBER)", null, "config");
    }
    // PIN OBLIGATORIO: sin número de versión publicada no sale NINGUNA
    // llamada, ni manual. (incidente "[password 1]": el draft cambió solo)
    const version = retellAgentVersion();
    const pinIssue = agentVersionPinIssue(version);
    if (pinIssue) throw new ProviderRequestError(`agent_version_not_pinned: ${pinIssue}`, null, "config");
    // PREFLIGHT de variables aquí también (cinturón y tirantes): el builder ya
    // lo hace, pero esta es la última puerta antes de la red.
    const issues = validateRetellCallVariables(req.dynamicVariables);
    if (issues.length > 0) throw new ProviderRequestError(`unsafe_dynamic_variables: ${issues.join("; ").slice(0, 250)}`, null, "config");

    const body = buildCreatePhoneCallBody(req, version);

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/v2/create-phone-call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Timeout / red: la petición PUDO llegar. Sin idempotency key en la
      // API de Retell, esto es AMBIGUO: jamás se reintenta solo.
      throw new ProviderRequestError(
        `Retell inaccesible o sin respuesta: ${err instanceof Error ? err.message : String(err)}`,
        null,
        "ambiguous"
      );
    }
    if (!res.ok) {
      // El cuerpo de error puede llevar detalles; NUNCA se loguea la key.
      const detalle = await res.text().catch(() => "");
      throw new ProviderRequestError(`Retell HTTP ${res.status}: ${detalle.slice(0, 300)}`, res.status);
    }
    let json: { call_id?: string; agent_id?: string; agent_version?: number | string };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new ProviderRequestError("Retell respondió 2xx sin JSON legible: comprobar en el dashboard si la llamada salió", null, "ambiguous");
    }
    if (!json.call_id) throw new ProviderRequestError("Retell aceptó pero sin call_id en la respuesta", null, "ambiguous");
    return {
      providerCallId: json.call_id,
      agentId: typeof json.agent_id === "string" ? json.agent_id : null,
      agentVersion: json.agent_version !== undefined && json.agent_version !== null ? String(json.agent_version) : null,
      requestedAgentVersion: version,
    };
  },

  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs = Date.now()): boolean {
    return verifyRetellWebhookSignature(rawBody, signatureHeader, apiKey(), nowMs).valid;
  },

  /** Igual que `verifyWebhook` pero diciendo POR QUÉ falla (la ruta lo
   *  registra sin filtrar nada: ver `describeRetellSignature`). */
  verifyWebhookDetailed(rawBody: string, signatureHeader: string | null, nowMs = Date.now()) {
    return verifyRetellWebhookSignature(rawBody, signatureHeader, apiKey(), nowMs);
  },

  parseEvent(rawBody: string): ParsedCallEvent | null {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    const event = json.event;
    if (event !== "call_started" && event !== "call_ended" && event !== "call_analyzed") return null;
    const call = (json.call ?? {}) as Record<string, unknown>;
    const callId = typeof call.call_id === "string" ? call.call_id : null;
    if (!callId) return null;

    const endMs = typeof call.end_timestamp === "number" ? call.end_timestamp : null;
    const startMs = typeof call.start_timestamp === "number" ? call.start_timestamp : null;
    const eventMs = endMs ?? startMs;
    const analysis =
      typeof call.call_analysis === "object" && call.call_analysis !== null
        ? ((call.call_analysis as Record<string, unknown>).custom_analysis_data as
            | Record<string, unknown>
            | undefined) ?? (call.call_analysis as Record<string, unknown>)
        : null;

    return {
      type: event as ParsedCallEventType,
      providerCallId: callId,
      agentVersion: call.agent_version !== undefined && call.agent_version !== null ? String(call.agent_version) : null,
      eventAt: eventMs !== null ? Math.floor(eventMs / 1000) : null,
      providerStatus: typeof call.call_status === "string" ? call.call_status : null,
      disconnectionReason:
        typeof call.disconnection_reason === "string" ? call.disconnection_reason : null,
      durationMs: endMs !== null && startMs !== null ? endMs - startMs : null,
      analysis: analysis ?? null,
    };
  },
};
