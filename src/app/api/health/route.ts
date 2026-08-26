import { NextResponse } from "next/server";
import { getConnectionState } from "@/lib/db";
import { whatsappProviderName } from "@/lib/whatsapp/provider";
import { getShopifyHealth, getWhatsAppHealth } from "@/lib/system/health-integrations";

// Endpoint de salud para un monitor externo (UptimeRobot, BetterStack…).
// Cubre el caso que el watchdog por WhatsApp NO puede cubrir: que el contenedor
// entero se caiga. Un ping externo que espere 200 avisa si esto no responde o
// devuelve 503 (bot desconectado).
//
// Con cloud_api activo, connection_state es la sesión de Baileys congelada
// de la última vez que corrió (o nunca se usó) — no el estado real de la
// Cloud API de Meta. Se informa según el proveedor realmente activo.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    // Toca la DB de verdad sea cual sea el proveedor: si esto lanza, la DB
    // está rota y el 500 de abajo es correcto para los dos proveedores.
    const conn = getConnectionState();
    const provider = whatsappProviderName();

    if (provider === "cloud_api") {
      const wa = getWhatsAppHealth();
      const connected = wa.status === "healthy";
      return NextResponse.json(
        {
          ok: connected,
          status: wa.connectionStatus,
          provider,
          phone: null, // cloud_api no tiene un número de sesión que enmascarar aquí
          // Mismo aviso informativo que en la rama Baileys (BUG2): un HMAC
          // rechazado no puede volver a pasar días invisible.
          shopifyWebhookBadSignature24h: getShopifyHealth().webhookBadSignature24h,
          time: new Date().toISOString(),
        },
        { status: connected ? 200 : 503 }
      );
    }

    const connected = conn.status === "connected";
    return NextResponse.json(
      {
        ok: connected,
        status: conn.status,
        provider,
        // ENMASCARADO a propósito: este endpoint es PÚBLICO (lo consultan
        // monitores externos sin credenciales) y devolvía el número de
        // WhatsApp del negocio entero. Un monitor solo necesita saber si hay
        // conexión; los últimos dígitos bastan para que Pedro distinga qué
        // número está vinculado sin publicarlo a quien pregunte.
        phone: conn.phone ? `***${String(conn.phone).slice(-4)}` : null,
        // Informativo (BUG2, 26-08): NO afecta a `ok`/al código de estado —
        // es una integración distinta a WhatsApp. Antes de esto un rechazo
        // de HMAC solo dejaba un warning en integration_events que nadie
        // miraba, y así pasaron días perdiendo cancelaciones sin enterarse.
        shopifyWebhookBadSignature24h: getShopifyHealth().webhookBadSignature24h,
        time: new Date().toISOString(),
      },
      { status: connected ? 200 : 503 }
    );
  } catch {
    return NextResponse.json({ ok: false, status: "error" }, { status: 500 });
  }
}
