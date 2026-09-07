// Adaptador minimo para liberar en Beeping los pedidos que su app nativa de
// Shopify ya ha creado. Es independiente del flujo manual de src/lib/beeping/:
// este automatismo tiene un unico flag y queda apagado hasta resolver que
// proveedor debe hacerse cargo de cada pedido.

import { logIntegrationEvent } from "../system/repo";

const DEFAULT_BASE_URL = "https://app.gobeeping.com";
const DEFAULT_TIMEOUT_MS = 20_000;

export type BeepingMarkToSendResult =
  | { outcome: "simulated" }
  | { outcome: "sent" }
  | { outcome: "not_found" }
  | { outcome: "failed"; status?: number };

function event(eventType: string, severity: "info" | "warning", message: string, externalId: string): void {
  logIntegrationEvent("beeping", eventType, severity, message, externalId);
}

/** PUT mark-to-send. Nunca rechaza: Beeping no puede romper la confirmacion. */
export async function markOrderToSend(externalId: string | number): Promise<BeepingMarkToSendResult> {
  const id = String(externalId).trim();
  try {
    if (process.env.BEEPING_INTEGRATION_ENABLED !== "1") {
      event("beeping_mark_to_send_simulado", "info", "se habria marcado el pedido para enviar en Beeping", id);
      return { outcome: "simulated" };
    }

    const email = (process.env.BEEPING_ACCOUNT_EMAIL ?? "").trim();
    const password = process.env.BEEPING_ACCOUNT_PASSWORD ?? "";
    if (!email || !password) {
      event("beeping_mark_to_send_fallo", "warning", "integracion habilitada sin credenciales completas", id);
      return { outcome: "failed" };
    }

    const baseUrl = ((process.env.BEEPING_API_BASE_URL ?? "").trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = `${baseUrl}/api/order/mark-to-send/${encodeURIComponent(id)}`;
    const authorization = Buffer.from(`${email}:${password}`, "utf8").toString("base64");
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Basic ${authorization}`, Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (response.ok) {
      event("beeping_mark_to_send_ok", "info", "pedido marcado para enviar en Beeping", id);
      return { outcome: "sent" };
    }
    if (response.status === 404) {
      event("beeping_mark_to_send_no_encontrado", "warning", "pedido no encontrado en Beeping (HTTP 404)", id);
      return { outcome: "not_found" };
    }
    event("beeping_mark_to_send_fallo", "warning", `Beeping rechazo mark-to-send (HTTP ${response.status})`, id);
    return { outcome: "failed", status: response.status };
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    event(
      "beeping_mark_to_send_fallo",
      "warning",
      timeout ? "timeout al marcar el pedido para enviar en Beeping" : "fallo de red al marcar el pedido para enviar en Beeping",
      id
    );
    return { outcome: "failed" };
  }
}
