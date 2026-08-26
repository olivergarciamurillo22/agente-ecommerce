import { NextResponse } from "next/server";
import { getConnectionState } from "@/lib/db";
import { getShopifyHealth } from "@/lib/system/health-integrations";

// ============================================================
// LIVENESS para el healthcheck de Docker.
//
// Distinto a /api/health a propósito:
//   /api/health      → 503 si WhatsApp está desconectado (para monitores
//                      externos: quieres enterarte de que el bot no atiende).
//   /api/health/live → 200 mientras la APP responda y la BASE DE DATOS sea
//                      accesible, aunque WhatsApp esté caído.
//
// Por qué: una desconexión de WhatsApp es transitoria y Baileys reconecta
// solo. Si Docker reiniciara el contenedor por eso, cortaría la reconexión
// en curso y entraría en un ciclo destructivo. Solo un fallo de la DB (disco
// lleno, volumen mal montado, permisos) justifica reiniciar el contenedor.
//
// `shopifyWebhookBadSignature24h` (BUG2, 26-08): igual de informativo,
// nunca afecta al código de estado — pero antes de esto un rechazo de HMAC
// solo dejaba un warning en integration_events que nadie miraba, y así
// pasaron días perdiendo cancelaciones de Shopify sin enterarse. Aparece
// aquí para que sea imposible no verlo.
// ============================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    // Tocar la DB de verdad: si el volumen no está montado o no hay permisos
    // de escritura, esto lanza y el contenedor se marca unhealthy.
    const conn = getConnectionState();
    return NextResponse.json({
      ok: true,
      db: "ok",
      whatsapp: conn.status, // informativo: NO afecta al código de estado
      phone: conn.phone ?? null,
      shopifyWebhookBadSignature24h: getShopifyHealth().webhookBadSignature24h,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        db: "error",
        error: err instanceof Error ? err.message : "db inaccesible",
      },
      { status: 503 }
    );
  }
}
