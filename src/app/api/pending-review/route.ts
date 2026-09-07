import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { getPendingReview, renderPendingReview } from "@/lib/system/pending-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resumen operativo: incidencias abiertas que esperan a una persona, con su
 * antigüedad. Solo lectura. `?formato=texto` devuelve el mismo resumen ya
 * redactado, que es lo que se enviaría por WhatsApp o correo el día que se
 * decida activar el envío (docs/deploy/RESUMEN-OPERATIVO.md).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const review = getPendingReview();
  if (req.nextUrl.searchParams.get("formato") === "texto") {
    return new NextResponse(renderPendingReview(review), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.json(review);
}
