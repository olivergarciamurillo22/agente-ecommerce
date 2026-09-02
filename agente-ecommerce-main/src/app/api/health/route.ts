import { NextResponse } from "next/server";
import { getConnectionState } from "@/lib/db";

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
        phone: conn.phone ?? null,
        time: new Date().toISOString(),
      },
      { status: connected ? 200 : 503 }
    );
  } catch {
    return NextResponse.json({ ok: false, status: "error" }, { status: 500 });
  }
}
