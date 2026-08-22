import { NextResponse, type NextRequest } from "next/server";
import { processDropiWebhook } from "@/lib/suppliers/dropi/webhook";

// Dropi envía las actualizaciones de pedido por POST a esta URL.
// Ver docs/DROPI-API-CONTRACT.md para la estructura confirmada del cuerpo.
//
// ⚠️ El receptor está DESHABILITADO por defecto (responde 503) hasta saber
// cómo autentica Dropi sus notificaciones: aceptar POSTs sin verificar
// dejaría que cualquiera inventara estados de envío y disparara WhatsApps.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const result = processDropiWebhook(rawBody);
  return NextResponse.json(result.body, { status: result.status });
}
