// ============================================================
// ABSTRACCIÓN DE PROVEEDOR DE WHATSAPP.
//
// Dos implementaciones, UNA activa (WHATSAPP_PROVIDER, default baileys):
//
//   baileys    → lo que corre hoy en producción: WhatsApp Web + QR.
//   cloud_api  → la API oficial de Meta (WhatsApp Business Platform).
//
// El negocio no sabe cuál está activa: escribe en el OUTBOX igual que
// siempre (src/lib/whatsapp.ts sigue siendo el chokepoint) y el loop de
// entrega del proveedor activo se encarga del resto. NUNCA se entregan
// mensajes por los dos a la vez: el lease LEASE_OUTBOX ya garantiza un
// único drenador aunque alguien arrancara los dos por error.
//
// Rollback = cambiar WHATSAPP_PROVIDER y reiniciar. Cero cambios de negocio.
// ============================================================

export type WhatsAppProviderName = "baileys" | "cloud_api";

/** Proveedor activo. Default baileys: la Cloud API se estrena por opt-in. */
export function whatsappProviderName(): WhatsAppProviderName {
  return process.env.WHATSAPP_PROVIDER === "cloud_api" ? "cloud_api" : "baileys";
}

/** Un botón de respuesta rápida. El `id` es el payload determinista que
 *  vuelve en el webhook — el texto visible es SOLO presentación. */
export interface ReplyButton {
  /** Payload estable: confirm_order, change_address… NUNCA se parsea el título. */
  id: string;
  /** Máx. 20 caracteres (límite de Meta para reply buttons). */
  title: string;
}

export interface ListRow {
  id: string;
  /** Máx. 24 caracteres. */
  title: string;
  /** Máx. 72 caracteres. */
  description?: string;
}

/** Mensaje saliente, en el vocabulario NUESTRO (no el de ningún proveedor). */
export type OutboundWhatsAppMessage =
  | { kind: "text"; text: string }
  | { kind: "interactive_buttons"; body: string; buttons: ReplyButton[]; footer?: string }
  | { kind: "interactive_list"; body: string; buttonLabel: string; rows: ListRow[]; footer?: string }
  | { kind: "template"; templateName: string; language: string; bodyParams: string[] };

export interface SendResult {
  ok: boolean;
  /** Id del mensaje en el proveedor (Meta lo devuelve; Baileys también). */
  providerMessageId: string | null;
  /** Solo si !ok. */
  error?: string;
  /** true = merece reintento (red, 5xx, rate limit); false = terminal. */
  retryable?: boolean;
}

export interface ProviderHealth {
  provider: WhatsAppProviderName;
  configured: boolean;
  /** Para baileys: sesión conectada. Para cloud: credenciales presentes. */
  available: boolean;
  detail: string;
}

export interface WhatsAppProvider {
  readonly name: WhatsAppProviderName;
  isConfigured(): boolean;
  send(phone: string, message: OutboundWhatsAppMessage): Promise<SendResult>;
  /** Marcar un mensaje entrante como leído (doble check azul). Best-effort. */
  markAsRead(providerMessageId: string): Promise<void>;
  getHealth(): ProviderHealth;
}
