// ============================================================
// PROVEEDOR: WhatsApp Business Cloud API (Meta).
//
// FAIL-CLOSED: sin META_WHATSAPP_API_ENABLED=1 + credenciales, cada envío
// devuelve un error terminal y NO se toca la red. Igual que Dropi.
//
// LA REGLA DE LA VENTANA DE 24 HORAS (la diferencia grande con Baileys):
// Meta solo permite mensajes LIBRES dentro de las 24 h siguientes al último
// mensaje DEL CLIENTE. Fuera de esa ventana, un mensaje iniciado por la
// empresa exige una PLANTILLA aprobada. Baileys no tenía esta restricción,
// así que el resto del sistema no la conoce — por eso se decide AQUÍ, en la
// entrega, y no en cada sitio que encola: un texto libre fuera de ventana
// falla TERMINAL con un motivo claro en vez de intentarlo y comerse el
// error críptico de Meta (o peor: que Meta lo acepte y lo tire).
//
// Errores clasificados con la taxonomía del repo (429 → reintenta con
// backoff del loop; 401 → credencial, crítico, no se reintenta).
// ============================================================

import pino from "pino";
import { getConversationIdByPhone, getLastInboundAt } from "../db";
import { classifyHttpError } from "../system/errors";
import type {
  OutboundWhatsAppMessage,
  ProviderHealth,
  SendResult,
  WhatsAppProvider,
} from "./provider";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

export function metaCloudEnabled(): boolean {
  return process.env.META_WHATSAPP_API_ENABLED === "1";
}

function phoneNumberId(): string {
  return (process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
}
function accessToken(): string {
  return (process.env.META_WHATSAPP_ACCESS_TOKEN ?? "").trim();
}
function apiVersion(): string {
  // Configurable: Meta retira versiones viejas cada ~2 años. Verificar la
  // vigente al hacer el alta (docs/PEDRO-META-WHATSAPP-SETUP.md).
  return (process.env.META_WHATSAPP_API_VERSION ?? "").trim() || "v23.0";
}

export function metaCloudConfigured(): boolean {
  return metaCloudEnabled() && Boolean(phoneNumberId()) && Boolean(accessToken());
}

/**
 * Ventana de sesión de Meta: 24 h desde el último mensaje DEL CLIENTE.
 *
 * Fuente de verdad: `messages.role='user'` (epoch UTC de SQLite). El webhook
 * de Meta INSERTA ahí cada entrante — incluido audio/imagen como
 * placeholder — precisamente para que la ventana se abra con cualquier
 * mensaje del cliente, igual que la cuenta Meta.
 *
 * Comparación estricta `< 24h`: en el segundo exacto 24:00 ya se considera
 * FUERA (conservador: mejor una plantilla de más que un rechazo de Meta).
 * Solo lectura: comprobar la ventana no crea conversaciones.
 */
export function isWithinSessionWindow(phone: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const convoId = getConversationIdByPhone(phone);
  if (convoId === null) return false; // nunca nos escribió: plantilla sí o sí
  const lastInbound = getLastInboundAt(convoId);
  if (lastInbound === null) return false;
  return nowSec - lastInbound < 24 * 3600;
}

/** Payload del endpoint /messages para cada tipo nuestro. */
export function buildMetaPayload(phone: string, m: OutboundWhatsAppMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: phone };
  if (m.kind === "text") {
    return { ...base, type: "text", text: { preview_url: false, body: m.text } };
  }
  if (m.kind === "interactive_buttons") {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: m.body },
        ...(m.footer ? { footer: { text: m.footer } } : {}),
        action: {
          buttons: m.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
        },
      },
    };
  }
  if (m.kind === "interactive_list") {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: m.body },
        ...(m.footer ? { footer: { text: m.footer } } : {}),
        action: {
          button: m.buttonLabel,
          sections: [{ title: "Pedidos", rows: m.rows }],
        },
      },
    };
  }
  return {
    ...base,
    type: "template",
    template: {
      name: m.templateName,
      language: { code: m.language },
      components: m.bodyParams.length
        ? [{ type: "body", parameters: m.bodyParams.map((p) => ({ type: "text", text: p })) }]
        : [],
    },
  };
}

/** Valida los límites duros de Meta ANTES de gastar la llamada. */
export function validateOutbound(m: OutboundWhatsAppMessage): string | null {
  if (m.kind === "interactive_buttons") {
    if (m.buttons.length < 1 || m.buttons.length > 3) return "Meta admite entre 1 y 3 botones";
    for (const b of m.buttons) {
      if ([...b.title].length > 20) return `título de botón demasiado largo (máx. 20): "${b.title}"`;
      if (!b.id.trim()) return "botón sin payload";
    }
  }
  if (m.kind === "interactive_list") {
    if (m.rows.length < 1 || m.rows.length > 10) return "Meta admite entre 1 y 10 filas";
    for (const r of m.rows) {
      if ([...r.title].length > 24) return `título de fila demasiado largo (máx. 24): "${r.title}"`;
      if (r.description && [...r.description].length > 72) return "descripción de fila demasiado larga (máx. 72)";
    }
  }
  return null;
}

/** fetch inyectable: los tests NUNCA salen a la red. */
export type MetaFetch = (url: string, init: RequestInit) => Promise<Response>;

export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  readonly name = "cloud_api" as const;
  private fetchImpl: MetaFetch;

  constructor(fetchImpl: MetaFetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  isConfigured(): boolean {
    return metaCloudConfigured();
  }

  async send(phone: string, message: OutboundWhatsAppMessage): Promise<SendResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        providerMessageId: null,
        error: "Cloud API no configurada (META_WHATSAPP_API_ENABLED/credenciales)",
        retryable: false,
      };
    }
    const invalido = validateOutbound(message);
    if (invalido) {
      return { ok: false, providerMessageId: null, error: invalido, retryable: false };
    }
    // La regla de la ventana: solo las plantillas pueden salir fuera de ella.
    if (message.kind !== "template" && !isWithinSessionWindow(phone)) {
      return {
        ok: false,
        providerMessageId: null,
        error:
          "outside_24h_window: el cliente no ha escrito en 24 h — Meta exige plantilla para iniciar conversación",
        retryable: false,
      };
    }

    try {
      const res = await this.fetchImpl(
        `https://graph.facebook.com/${apiVersion()}/${phoneNumberId()}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildMetaPayload(phone, message)),
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (!res.ok) {
        let detalle = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { message?: string; code?: number } };
          // El código de Meta se preserva SIEMPRE (131047 = fuera de sesión,
          // 132xxx = plantilla, 100 = parámetro inválido…): es lo que permite
          // diagnosticar sin adivinar. El mensaje va recortado y sin PII.
          if (body.error?.code) detalle = `${detalle} [code ${body.error.code}]`;
          if (body.error?.message) detalle = `${detalle}: ${String(body.error.message).slice(0, 160)}`;
        } catch {
          /* cuerpo no-JSON: nos quedamos con el status */
        }
        const clasificado = classifyHttpError(res.status, new Error(detalle));
        logger.warn(`[META] envío rechazado (${clasificado.category}): ${detalle}`);
        return {
          ok: false,
          providerMessageId: null,
          error: detalle,
          retryable: clasificado.category === "retryable" || clasificado.category === "rate_limit",
        };
      }
      let json: { messages?: Array<{ id?: string }> };
      try {
        json = (await res.json()) as { messages?: Array<{ id?: string }> };
      } catch {
        // HTTP 200 con cuerpo ilegible: Meta ACEPTÓ el mensaje. Reenviar
        // duplicaría; se da por enviado sin id (los estados no correlarán,
        // que es cosmético — un duplicado al cliente no lo es).
        logger.warn("[META] 200 con respuesta malformada: enviado sin provider_message_id");
        return { ok: true, providerMessageId: null };
      }
      return { ok: true, providerMessageId: json.messages?.[0]?.id ?? null };
    } catch (err) {
      // POLÍTICA AT-MOST-ONCE ante resultado AMBIGUO: un timeout o un reset
      // pueden ocurrir DESPUÉS de que la petición llegara a Meta — reintentar
      // podría mandar el mismo WhatsApp dos veces al cliente. Solo se
      // reintenta lo que garantiza que la petición NUNCA salió (DNS caído,
      // conexión rechazada). Perder un mensaje es recuperable (recordatorios,
      // needs_call); duplicarlo no. Misma política que el loop de Baileys.
      const raw = err instanceof Error ? err.message : String(err);
      const nuncaSalio = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(raw);
      return {
        ok: false,
        providerMessageId: null,
        error: nuncaSalio ? raw : `resultado ambiguo (${raw.slice(0, 120)}): no se reintenta para no duplicar`,
        retryable: nuncaSalio,
      };
    }
  }

  async markAsRead(providerMessageId: string): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      await this.fetchImpl(`https://graph.facebook.com/${apiVersion()}/${phoneNumberId()}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: providerMessageId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best-effort: un doble check azul que no sale no rompe nada.
    }
  }

  getHealth(): ProviderHealth {
    const configured = this.isConfigured();
    return {
      provider: "cloud_api",
      configured,
      available: configured,
      detail: configured
        ? "Cloud API de Meta configurada (sin QR ni sesión: la conexión es por token)"
        : metaCloudEnabled()
          ? "faltan credenciales (META_WHATSAPP_PHONE_NUMBER_ID / META_WHATSAPP_ACCESS_TOKEN)"
          : "apagada (META_WHATSAPP_API_ENABLED=0)",
    };
  }
}
