// ============================================================
// API del mapping de productos ↔ proveedor.
//
// LO QUE ESTA RUTA NO HACE, A PROPÓSITO:
//   · No crea pedidos.
//   · No llama a la API de ningún proveedor. "Validar" aquí es comprobar la
//     FORMA de la fila; comprobar que el producto existe en Dropea exige red
//     y credenciales, y no puede pasar por accidente desde un botón.
//   · No borra: desactiva. Un mapping borrado pierde la evidencia de por qué
//     un pedido se enrutó como se enrutó.
// ============================================================

import { NextResponse } from "next/server";
import {
  listSupplierProductMappings,
  setSupplierProductMappingActive,
  upsertSupplierProductMapping,
} from "@/lib/db";
import { validateMapping, mappingIsSavable } from "@/lib/suppliers/mapping-validation";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const filas = listSupplierProductMappings();
    return NextResponse.json({
      ok: true,
      mappings: filas.map((m) => ({
        ...m,
        active: m.active === 1,
        // Cada fila viaja con sus avisos de forma: así el panel puede marcar
        // en rojo la que está mal sin que nadie tenga que pulsar nada.
        issues: validateMapping({
          supplier_platform: m.supplier_platform,
          shopify_product_id: m.shopify_product_id,
          shopify_variant_id: m.shopify_variant_id,
          shopify_sku: m.shopify_sku,
          shopify_title: m.shopify_title,
          supplier_product_id: m.supplier_product_id,
          supplier_variant_id: m.supplier_variant_id,
          supplier_unit_price: m.supplier_unit_price,
        }),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error leyendo los mappings" },
      { status: 500 }
    );
  }
}

/** Crear o actualizar un mapping. Rechaza los que tienen errores de forma. */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const candidato = {
      supplier_platform: String(body.supplier_platform ?? "dropea"),
      shopify_product_id: (body.shopify_product_id as string) ?? null,
      shopify_variant_id: (body.shopify_variant_id as string) ?? null,
      shopify_sku: (body.shopify_sku as string) ?? null,
      shopify_title: (body.shopify_title as string) ?? null,
      supplier_product_id: (body.supplier_product_id as string) ?? null,
      supplier_variant_id: String(body.supplier_variant_id ?? "").trim(),
      supplier_unit_price:
        body.supplier_unit_price === null || body.supplier_unit_price === undefined
          ? null
          : Number(body.supplier_unit_price),
    };

    const issues = validateMapping(candidato);
    if (!mappingIsSavable(issues)) {
      return NextResponse.json({ ok: false, issues }, { status: 400 });
    }

    const id = upsertSupplierProductMapping({
      ...candidato,
      active: body.active === undefined ? true : Boolean(body.active),
    });
    return NextResponse.json({ ok: true, id, issues });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error guardando" },
      { status: 500 }
    );
  }
}

/** Activar o desactivar. NUNCA borra. */
export async function PATCH(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json()) as { id?: number; active?: boolean };
    if (typeof body.id !== "number" || typeof body.active !== "boolean") {
      return NextResponse.json({ ok: false, error: "hacen falta `id` y `active`" }, { status: 400 });
    }
    const cambiado = setSupplierProductMappingActive(body.id, body.active);
    return NextResponse.json({ ok: cambiado, id: body.id, active: body.active });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error" },
      { status: 500 }
    );
  }
}
