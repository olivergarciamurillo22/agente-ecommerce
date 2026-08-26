import { NextResponse } from "next/server";
import { getConnectionState } from "@/lib/db";
import { whatsappProviderName } from "@/lib/whatsapp/provider";
import { getWhatsAppHealth } from "@/lib/system/health-integrations";

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
// El campo "whatsapp" es SOLO informativo (nunca afecta al código de
// estado), pero tiene que reflejar el proveedor REALMENTE activo: con
// cloud_api, connection_state es la sesión de Baileys de la última vez que
// corrió (o nunca se llegó a usar) — congelada, no la Cloud API de Meta.
// ============================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    // Tocar la DB de verdad: si el volumen no está montado o no hay permisos
    // de escritura, esto lanza y el contenedor se marca unhealthy. Se hace
    // SIEMPRE, sea cual sea el proveedor: la tabla connection_state existe
    // igual y esto es lo único que aquí prueba que la DB responde.
    const conn = getConnectionState();
    const provider = whatsappProviderName();

    if (provider === "cloud_api") {
      const wa = getWhatsAppHealth();
      return NextResponse.json({
        ok: true,
        db: "ok",
        provider,
        whatsapp: wa.connectionStatus, // "configured" | "not_configured" — real, no la sesión de Baileys
        phone: null, // cloud_api no tiene una sesión con número propio que enseñar aquí
        time: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      ok: true,
      db: "ok",
      provider,
      whatsapp: conn.status, // informativo: NO afecta al código de estado
      phone: conn.phone ?? null,
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
