import { NextResponse, type NextRequest } from "next/server";
import { processSupplierWebhook } from "@/lib/suppliers/webhook";

// La firma se calcula sobre el cuerpo CRUDO: hay que leerlo tal cual llega.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const headers: Record<string, string | null> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const result = processSupplierWebhook("dropea", rawBody, headers);
  return NextResponse.json(result.body, { status: result.status });
}
