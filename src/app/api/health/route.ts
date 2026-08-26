import { NextResponse } from "next/server";
import { getConnectionState } from "@/lib/db";
import { getShopifyHealth } from "@/lib/system/health-integrations";

// Endpoint de salud para un monitor externo (UptimeRobot, BetterStack…).
// Cubre el caso que el watchdog por WhatsApp NO puede cubrir: que el contenedor
// entero se caiga. Un ping externo que espere 200 avisa si esto no responde o
// devuelve 503 (bot desconectado).
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const conn = getConnectionState();
    const connected = conn.status === "connected";
    return NextResponse.json(
      {
        ok: connected,
        status: conn.status,
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
