import { NextResponse, type NextRequest } from "next/server";
import { processDropeaWebhook } from "@/lib/suppliers/dropea/webhook";

// Webhooks de Dropea. La firma (X-Dropea-Signature) se calcula sobre el
// cuerpo CRUDO, así que hay que leerlo tal cual llega.
// Contrato: docs/DROPEA-API-CONTRACT.md § 9
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const headers: Record<string, string | null> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const result = processDropeaWebhook(rawBody, headers);
  return NextResponse.json(result.body, { status: result.status });
}
