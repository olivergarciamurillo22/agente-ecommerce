import { NextResponse } from "next/server";
import { deleteProductCost, listProductCosts, upsertProductCost } from "@/lib/db";

// Costes por SKU para el módulo de unit economics. Escritura LOCAL en
// SQLite (no es una acción externa: no pasa por safety gates). Queda detrás
// del Basic Auth del panel.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ costs: listProductCosts() });
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const sku = String(body.sku ?? "").trim();
    if (!sku) return NextResponse.json({ error: "sku obligatorio" }, { status: 400 });
    upsertProductCost({
      sku,
      title: typeof body.title === "string" ? body.title.slice(0, 200) : null,
      product_cost: num(body.product_cost),
      shipping_cost: num(body.shipping_cost),
      cod_fee: num(body.cod_fee),
    });
    return NextResponse.json({ ok: true, costs: listProductCosts() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "error" }, { status: 400 });
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const sku = new URL(req.url).searchParams.get("sku")?.trim();
  if (!sku) return NextResponse.json({ error: "sku obligatorio" }, { status: 400 });
  deleteProductCost(sku);
  return NextResponse.json({ ok: true, costs: listProductCosts() });
}
