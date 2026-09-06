import { NextResponse, type NextRequest } from "next/server";
import { processBeepingWebhook } from "@/lib/beeping/webhook";

// Receptor de los webhooks del panel de Beeping (order.created,
// order.status_changed, order.logistics_status_changed, order.updated).
//
// ⚠️ Beeping NO documenta sus webhooks: mientras no esté declarado en el
// entorno cómo autentica (BEEPING_WEBHOOK_AUTH_MODE + _SECRET), este endpoint
// responde 503 WEBHOOK_AUTH_NOT_CONFIGURED y no produce ningún efecto.
// El razonamiento completo está en src/lib/beeping/webhook.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // BYTES CRUDOS primero: si Beeping firma el cuerpo, la firma se verifica
  // sobre lo que llegó de verdad, nunca sobre un JSON reserializado.
  const rawBody = await req.text();

  const headers: Record<string, string | null> = {};
  req.headers.forEach((valor, nombre) => {
    headers[nombre.toLowerCase()] = valor;
  });

  const result = processBeepingWebhook(rawBody, headers);
  return NextResponse.json(result.body, { status: result.status });
}
