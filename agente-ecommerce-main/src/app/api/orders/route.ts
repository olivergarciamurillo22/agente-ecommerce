import { NextResponse, type NextRequest } from "next/server";
import { listOrders, getOrderCounts, ORDER_STATUSES, type OrderStatus } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lista de pedidos + contadores para el panel. ?status= filtra por estado. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const statusParam = req.nextUrl.searchParams.get("status");
  const status =
    statusParam && (ORDER_STATUSES as string[]).includes(statusParam)
      ? (statusParam as OrderStatus)
      : undefined;

  // El raw_payload puede pesar: fuera de la respuesta del listado.
  const orders = listOrders(status).map(({ raw_payload: _raw, ...rest }) => rest);
  return NextResponse.json({ counts: getOrderCounts(), orders });
}
