import { NextResponse, type NextRequest } from "next/server";
import { listOrders, getOrderCounts, ORDER_STATUSES, type OrderStatus } from "@/lib/db";
import { isConfirmationEligible } from "@/lib/orders/eligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lista de pedidos + contadores para el panel. ?status= filtra por estado. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const statusParam = req.nextUrl.searchParams.get("status");
  const status =
    statusParam && (ORDER_STATUSES as string[]).includes(statusParam)
      ? (statusParam as OrderStatus)
      : undefined;

  // El raw_payload puede pesar: fuera de la respuesta del listado. Cada fila
  // lleva su veredicto de elegibilidad (la MISMA verdad que usan los
  // schedulers) para que el panel nunca enseñe un "pendiente" falso.
  const orders = listOrders(status).map(({ raw_payload: _raw, ...rest }) => {
    const elig = isConfirmationEligible({ ...rest, raw_payload: null });
    return { ...rest, confirmation_eligible: elig.eligible, confirmation_reason: elig.detail };
  });
  return NextResponse.json({ counts: getOrderCounts(), orders });
}
