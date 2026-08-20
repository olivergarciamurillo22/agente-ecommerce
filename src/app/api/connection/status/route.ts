import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getConnectionState } from "@/lib/db";

// Esta ruta lee de SQLite. No se debe evaluar en build time.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
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
      qrPng,
      phone: state.phone,
      updatedAt: state.updated_at,
    });
  }

  return NextResponse.json({
    status: state.status,
    phone: state.phone,
    updatedAt: state.updated_at,
  });
}
