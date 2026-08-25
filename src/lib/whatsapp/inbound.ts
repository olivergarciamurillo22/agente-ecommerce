// ============================================================
// MENSAJE ENTRANTE NORMALIZADO — el resto de la app no sabe si vino por
// Baileys o por la Cloud API.
//
// Todo lo que entra se convierte a `InboundWhatsAppMessage` ANTES de tocar
// la lógica de negocio. El handler COD interpreta payloads de botón
// (`confirm_order`), no etiquetas visibles: el texto del botón es
// presentación y puede cambiar sin romper nada.
// ============================================================

export type InboundKind = "text" | "button_reply" | "list_reply" | "audio" | "image" | "unknown";

export interface InboundWhatsAppMessage {
  provider: "baileys" | "cloud_api";
  /** Teléfono en dígitos internacionales sin '+' (formato del sistema). */
  phone: string;
  /** Id del mensaje en el proveedor (dedupe + markAsRead). */
  messageId: string;
  /** Epoch segundos. */
  timestamp: number;
  kind: InboundKind;
  /** Texto del mensaje, o título visible del botón/fila (solo informativo). */
  text: string | null;
  /** Payload determinista del botón o fila. SOLO en button_reply/list_reply. */
  payload: string | null;
  /** Nombre del perfil, si el proveedor lo da. */
  profileName: string | null;
  /** Id del mensaje al que responde, si es una respuesta. */
  replyToMessageId: string | null;
}

/** Estado de un mensaje SALIENTE, reportado por el webhook de Meta. */
export interface OutboundStatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: number;
  recipientPhone: string;
  /** Solo en failed. */
  errorDetail: string | null;
}

export interface ParsedMetaWebhook {
  messages: InboundWhatsAppMessage[];
  statuses: OutboundStatusUpdate[];
}

/* Forma del webhook de la Cloud API (subconjunto que usamos):
   entry[].changes[].value.{messages[], statuses[], contacts[]}            */
interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        messages?: Array<Record<string, unknown>>;
        statuses?: Array<Record<string, unknown>>;
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
      };
    }>;
  }>;
}

function toEpoch(v: unknown): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000);
}

/**
 * Convierte el body crudo del webhook de Meta en mensajes y estados
 * normalizados. Lo que no se reconoce sale como kind "unknown" — visible,
 * nunca descartado en silencio ni interpretado a ciegas.
 */
export function parseMetaWebhookPayload(body: unknown): ParsedMetaWebhook {
  const out: ParsedMetaWebhook = { messages: [], statuses: [] };
  const parsed = body as MetaWebhookBody;
  if (parsed?.object !== "whatsapp_business_account") return out;

  for (const entry of parsed.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const nombrePorWaId = new Map(
        (value.contacts ?? []).map((c) => [String(c.wa_id ?? ""), c.profile?.name ?? null])
      );

      for (const m of value.messages ?? []) {
        const phone = String(m.from ?? "").replace(/\D/g, "");
        const messageId = String(m.id ?? "");
        if (!phone || !messageId) continue;
        const base = {
          provider: "cloud_api" as const,
          phone,
          messageId,
          timestamp: toEpoch(m.timestamp),
          profileName: nombrePorWaId.get(phone) ?? null,
          replyToMessageId:
            typeof (m.context as { id?: string } | undefined)?.id === "string"
              ? ((m.context as { id: string }).id)
              : null,
        };
        const type = String(m.type ?? "");
        if (type === "text") {
          out.messages.push({
            ...base,
            kind: "text",
            text: String((m.text as { body?: string })?.body ?? ""),
            payload: null,
          });
        } else if (type === "interactive") {
          const inter = m.interactive as
            | { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }
            | undefined;
          if (inter?.type === "button_reply" && inter.button_reply?.id) {
            out.messages.push({
              ...base,
              kind: "button_reply",
              text: inter.button_reply.title ?? null,
              payload: inter.button_reply.id,
            });
          } else if (inter?.type === "list_reply" && inter.list_reply?.id) {
            out.messages.push({
              ...base,
              kind: "list_reply",
              text: inter.list_reply.title ?? null,
              payload: inter.list_reply.id,
            });
          } else {
            out.messages.push({ ...base, kind: "unknown", text: null, payload: null });
          }
        } else if (type === "button") {
          // Respuesta a botón de PLANTILLA (forma distinta del interactivo).
          const btn = m.button as { payload?: string; text?: string } | undefined;
          out.messages.push({
            ...base,
            kind: "button_reply",
            text: btn?.text ?? null,
            payload: btn?.payload ?? null,
          });
        } else if (type === "audio") {
          out.messages.push({ ...base, kind: "audio", text: null, payload: null });
        } else if (type === "image") {
          const img = m.image as { caption?: string } | undefined;
          out.messages.push({ ...base, kind: "image", text: img?.caption ?? null, payload: null });
        } else {
          out.messages.push({ ...base, kind: "unknown", text: null, payload: null });
        }
      }

      for (const st of value.statuses ?? []) {
        const status = String(st.status ?? "");
        if (!["sent", "delivered", "read", "failed"].includes(status)) continue;
        const errores = st.errors as Array<{ code?: number; title?: string; message?: string }> | undefined;
        out.statuses.push({
          providerMessageId: String(st.id ?? ""),
          status: status as OutboundStatusUpdate["status"],
          timestamp: toEpoch(st.timestamp),
          recipientPhone: String(st.recipient_id ?? "").replace(/\D/g, ""),
          errorDetail: errores?.length
            ? `${errores[0].code ?? "?"}: ${errores[0].title ?? errores[0].message ?? "error"}`
            : null,
        });
      }
    }
  }
  return out;
}
