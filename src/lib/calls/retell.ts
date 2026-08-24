// ============================================================
// Adaptador de Retell — contrato verificado contra docs.retellai.com el
// 24-08-2026:
//   POST https://api.retellai.com/v2/create-phone-call
//     Authorization: Bearer <RETELL_API_KEY>
//     body: { from_number, to_number, retell_llm_dynamic_variables,
//             metadata, override_agent_id? }  → 201 { call_id, ... }
//   Webhook: header X-Retell-Signature = "v={ts_ms},d={hex}", donde
//     d = HMAC-SHA256(raw_body + ts, api_key). Verificación en tiempo
//     constante + frescura del timestamp (5 min).
//   Eventos: call_started | call_ended | call_analyzed, con { event, call }
//     y call.call_analysis.custom_analysis_data para el análisis.
//
// Fallback defensivo de firma: si el header no trae el formato v=,d= se
// acepta también el HMAC-SHA256(raw_body) en hex (formato del SDK antiguo).
// ============================================================

import crypto from "node:crypto";
import {
  ProviderRequestError,
  type CallProvider,
  type OutboundCallAccepted,
  type OutboundCallRequest,
  type ParsedCallEvent,
  type ParsedCallEventType,
} from "./provider";

const API_BASE = "https://api.retellai.com";
const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

function apiKey(): string {
  return (process.env.RETELL_API_KEY ?? "").trim();
}
export function retellFromNumber(): string {
  return (process.env.RETELL_FROM_NUMBER ?? "").trim();
}
function agentId(): string {
  return (process.env.RETELL_AGENT_ID ?? "").trim();
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export const retellProvider: CallProvider = {
  name: "retell",

  isConfigured(): boolean {
    return Boolean(apiKey() && retellFromNumber());
  },

  async createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallAccepted> {
    if (!this.isConfigured()) {
      throw new ProviderRequestError("Retell no configurado (RETELL_API_KEY / RETELL_FROM_NUMBER)");
    }
    const body: Record<string, unknown> = {
      from_number: req.fromNumber,
      to_number: req.toNumber,
      retell_llm_dynamic_variables: req.dynamicVariables,
      metadata: req.metadata,
    };
    if (agentId()) body.override_agent_id = agentId();

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
      throw new ProviderRequestError(
        `Retell inaccesible: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      // El cuerpo de error puede llevar detalles; NUNCA se loguea la key.
      const detalle = await res.text().catch(() => "");
      throw new ProviderRequestError(`Retell HTTP ${res.status}: ${detalle.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as { call_id?: string };
    if (!json.call_id) throw new ProviderRequestError("Retell aceptó pero sin call_id en la respuesta");
    return { providerCallId: json.call_id };
  },

  verifyWebhook(rawBody: string, signatureHeader: string | null, nowMs = Date.now()): boolean {
    const key = apiKey();
    if (!key || !signatureHeader) return false;

    const m = /^v=(\d+),d=([0-9a-f]+)$/i.exec(signatureHeader.trim());
    if (m) {
      const ts = Number(m[1]);
      if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > SIGNATURE_MAX_AGE_MS) return false;
      const esperado = crypto.createHmac("sha256", key).update(rawBody + m[1]).digest("hex");
      return safeEqual(esperado, m[2].toLowerCase());
    }
    // Fallback: firma simple del cuerpo (hex), sin timestamp.
    const simple = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
    return safeEqual(simple, signatureHeader.trim().toLowerCase());
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
      eventAt: eventMs !== null ? Math.floor(eventMs / 1000) : null,
      providerStatus: typeof call.call_status === "string" ? call.call_status : null,
      disconnectionReason:
        typeof call.disconnection_reason === "string" ? call.disconnection_reason : null,
      durationMs: endMs !== null && startMs !== null ? endMs - startMs : null,
      analysis: analysis ?? null,
    };
  },
};
