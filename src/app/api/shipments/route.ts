// ============================================================
// Envíos (§25): la foto logística de todos los pedidos que ya están
// (o deberían estar) en manos de un proveedor: Beeping o Dropea.
//
//   GET → { ok, cutoff, counts, shipments }
//
// Una sola consulta SQL, columnas explícitas: NUNCA raw_payload ni el
// teléfono completo. El `bucket` se calcula aquí (servidor) para que el
// panel no reinterprete estados.
// ============================================================

import { NextResponse } from "next/server";
import { systemDbHandle } from "@/lib/db";
import { beepingCutoff } from "@/lib/beeping/cutoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ShipmentBucket =
  | "ambiguous"
  | "to_confirm"
  | "incident"
  | "returned"
  | "delivered"
  | "transit"
  | "preparing"
  | "other";

export type ShipmentSupplier = "beeping" | "dropea" | null;

export interface ShipmentItem {
  id: number;
  orderNumber: string;
  customer: string | null;
  city: string | null;
  totalPrice: string;
  supplierPlatform: string | null;
  /** Proveedor efectivo para filtrar/contar: beeping | dropea | null. */
  supplier: ShipmentSupplier;
  /** Estado logístico normalizado (TrackingStatus). */
  logistics: string;
  rawStatus: string | null;
  supplierSyncStatus: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  closure: string;
  beepingSyncStatus: string;
  beepingOrderStatus: number | null;
  beepingLastError: string | null;
  dispatchNote: string | null;
  updatedAt: number;
  confirmedAt: number | null;
  bucket: ShipmentBucket;
}

interface ShipmentSqlRow {
  id: number;
  shopify_order_number: string;
  customer_name: string | null;
  city: string | null;
  total_price: string;
  status: string;
  supplier_platform: string | null;
  supplier_sync_status: string;
  supplier_external_order_id: string | null;
  supplier_status_normalized: string;
  supplier_status_raw: string | null;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  closure_status: string;
  beeping_sync_status: string;
  beeping_order_status: number | null;
  beeping_external_id: string | null;
  beeping_last_error: string | null;
  dispatch_note: string | null;
  updated_at: number;
  confirmed_at: number | null;
}

const TRANSIT_STATES = new Set([
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivery_attempted",
  "at_pickup_point",
]);

const PREPARING_STATES = new Set(["created", "processing"]);
const PREPARING_BEEPING_CODES = new Set([1, 2, 3]);

/** Cubo del envío. El ORDEN de las reglas importa: la primera que aplica gana. */
function computeBucket(r: ShipmentSqlRow): ShipmentBucket {
  const logistics = r.supplier_status_normalized;
  if (r.beeping_sync_status === "release_unknown") return "ambiguous";
  if (
    r.beeping_order_status === 6 ||
    (r.status === "confirmed" &&
      (r.beeping_sync_status === "not_released" || r.beeping_sync_status === "release_failed") &&
      (logistics === "unknown" || logistics === "created"))
  ) {
    return "to_confirm";
  }
  if (logistics === "incident" || r.supplier_sync_status === "manual_review") return "incident";
  if (logistics === "returned" || r.closure_status === "refused") return "returned";
  if (r.closure_status === "delivered" || logistics === "delivered") return "delivered";
  if (TRANSIT_STATES.has(logistics)) return "transit";
  if (
    PREPARING_STATES.has(logistics) ||
    (r.beeping_order_status !== null && PREPARING_BEEPING_CODES.has(r.beeping_order_status))
  ) {
    return "preparing";
  }
  return "other";
}

function computeSupplier(r: ShipmentSqlRow): ShipmentSupplier {
  if (r.beeping_external_id !== null || r.beeping_sync_status !== "not_released") return "beeping";
  if (r.supplier_platform === "dropea") return "dropea";
  return null;
}

export async function GET() {
  try {
    const db = systemDbHandle();
    const rows = db
      .prepare(
        `SELECT id, shopify_order_number, customer_name, city, total_price, status,
                supplier_platform, supplier_sync_status, supplier_external_order_id,
                supplier_status_normalized, supplier_status_raw, carrier,
                tracking_number, tracking_url, closure_status,
                beeping_sync_status, beeping_order_status, beeping_external_id,
                beeping_last_error, dispatch_note, updated_at, confirmed_at
           FROM orders
          WHERE status != 'ignored_old'
            AND (
              supplier_external_order_id IS NOT NULL
              OR beeping_external_id IS NOT NULL
              OR beeping_sync_status != 'not_released'
              OR supplier_status_normalized != 'unknown'
              OR (status = 'confirmed' AND closure_status IN ('unknown', 'in_progress'))
            )
          ORDER BY updated_at DESC
          LIMIT 500`
      )
      .all() as ShipmentSqlRow[];

    const buckets: Record<ShipmentBucket, number> = {
      ambiguous: 0,
      to_confirm: 0,
      incident: 0,
      returned: 0,
      delivered: 0,
      transit: 0,
      preparing: 0,
      other: 0,
    };
    const supplier = { beeping: 0, dropea: 0 };

    const shipments: ShipmentItem[] = rows.map((r) => {
      const bucket = computeBucket(r);
      const sup = computeSupplier(r);
      buckets[bucket]++;
      // Los contadores por proveedor no son excluyentes con la definición de
      // arriba, pero sí en la práctica: un pedido con eje Beeping cuenta como
      // Beeping; si no, como Dropea cuando el router lo mandó allí.
      if (sup === "beeping") supplier.beeping++;
      else if (sup === "dropea") supplier.dropea++;
      return {
        id: r.id,
        orderNumber: r.shopify_order_number,
        customer: r.customer_name,
        city: r.city,
        totalPrice: r.total_price,
        supplierPlatform: r.supplier_platform,
        supplier: sup,
        logistics: r.supplier_status_normalized,
        rawStatus: r.supplier_status_raw,
        supplierSyncStatus: r.supplier_sync_status,
        carrier: r.carrier,
        trackingNumber: r.tracking_number,
        trackingUrl: r.tracking_url,
        closure: r.closure_status,
        beepingSyncStatus: r.beeping_sync_status,
        beepingOrderStatus: r.beeping_order_status,
        beepingLastError: r.beeping_last_error,
        dispatchNote: r.dispatch_note,
        updatedAt: r.updated_at,
        confirmedAt: r.confirmed_at,
        bucket,
      };
    });

    return NextResponse.json({
      ok: true,
      cutoff: beepingCutoff(),
      counts: { total: shipments.length, buckets, supplier },
      shipments,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error interno" },
      { status: 500 }
    );
  }
}
