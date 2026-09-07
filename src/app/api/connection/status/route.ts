import { NextResponse, type NextRequest } from "next/server";
import QRCode from "qrcode";
import { getConnectionState } from "@/lib/db";
import { whatsappProviderName } from "@/lib/whatsapp/provider";
import { requireOwner } from "@/lib/auth/guard";

// Esta ruta lee de SQLite. No se debe evaluar en build time.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const provider = whatsappProviderName();
  // Cloud API (V3 §47): no hay sesión de WhatsApp Web — ni QR, ni
  // "reconectar", ni "desconectar". El panel no debe enseñar semántica de
  // Baileys cuando el proveedor es la API oficial.
  if (provider === "cloud_api") {
    return NextResponse.json({
      status: "connected",
      provider,
      phone: null,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }
  const state = getConnectionState();

  // API defensiva: mostrar el QR si existe qr_string AUNQUE el status no sea exactamente 'qr'.
  // Race condition: el bot pasa por 'qr' → 'connecting' muy rápido y el frontend nunca lo ve.
  const shouldShowQr =
    !!state.qr_string &&
    (state.status === "qr" || state.status === "connecting");

  if (shouldShowQr && state.qr_string) {
    const qrPng = await QRCode.toDataURL(state.qr_string, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    return NextResponse.json({
      status: "qr",
      provider,
      qrPng,
      phone: state.phone,
      updatedAt: state.updated_at,
    });
  }

  return NextResponse.json({
    status: state.status,
    provider,
    phone: state.phone,
    updatedAt: state.updated_at,
  });
}
