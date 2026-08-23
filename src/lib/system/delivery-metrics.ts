// ============================================================
// Métricas de ENTREGA. READ-ONLY sobre `orders` + `order_status_history`.
//
// Esta es la métrica que decide si el negocio gana o pierde (break-even
// 62,9 % de entrega). Hasta ahora era un número escrito a mano; aquí se
// CUENTA a partir de transiciones reales de estado, nunca se estima.
//
// FÓRMULA (documentada en docs/BUSINESS-METRICS.md):
//
//   enviados   = pedidos con alguna transición a un estado de envío
//                (shipped, in_transit, out_for_delivery, delivery_attempted,
//                at_pickup_point, delivered, returned) en el histórico.
//                Se asignan a la ventana por la fecha de su PRIMERA de esas
//                transiciones (`shipped_at`).
//   entregados = enviados cuyo estado actual es `delivered`
//   devueltos  = enviados cuyo estado actual es `returned`
//   resueltos  = entregados + devueltos
//   tasa       = entregados / resueltos          (null si resueltos = 0)
//
//   Los envíos aún en curso, con incidencia abierta o cancelados NO entran
//   en el denominador: meterlos distorsionaría la tasa a la baja mientras
//   el paquete sigue en camino. Se enseñan aparte como "pendientes".
// ============================================================

import { systemDbHandle } from "../db";
import { lineItemsFromPayload } from "../orders/line-items";

const SHIPPED_STATES = [
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivery_attempted",
  "at_pickup_point",
  "delivered",
  "returned",
];

export interface DeliveryBucket {
  key: string;
  shipped: number;
  delivered: number;
  returned: number;
  /** Enviados sin resultado terminal todavía (en curso / incidencia). */
  pending: number;
  incidents: number;
  /** entregados / (entregados + devueltos); null sin datos. */
  deliveryRate: number | null;
}

export interface DeliveryWindow extends DeliveryBucket {
  /** Pedidos creados en la ventana (todos, enviados o no). */
  created: number;
  cancelled: number;
  /** Horas medias desde el primer estado de envío hasta entregado. */
  avgHoursToDeliver: number | null;
  byProduct: DeliveryBucket[];
  bySupplier: DeliveryBucket[];
  byCarrier: DeliveryBucket[];
}

export interface DeliveryMetrics {
  generatedAt: number;
  today: DeliveryWindow;
  last7d: DeliveryWindow;
  last30d: DeliveryWindow;
  /** Tamaño mínimo de muestra para que la tasa se considere fiable. */
  minSample: number;
}

interface ShippedRow {
  id: number;
  supplier_platform: string | null;
  carrier: string | null;
  status: string;
  raw_payload: string | null;
  product_summary: string;
  shipped_at: number;
  delivered_at: number | null;
}

function emptyBucket(key: string): DeliveryBucket {
  return { key, shipped: 0, delivered: 0, returned: 0, pending: 0, incidents: 0, deliveryRate: null };
}

function addToBucket(b: DeliveryBucket, r: ShippedRow): void {
  b.shipped++;
  if (r.status === "delivered") b.delivered++;
  else if (r.status === "returned") b.returned++;
  else {
    b.pending++;
    if (r.status === "incident") b.incidents++;
  }
}

export function computeDeliveryRate(delivered: number, returned: number): number | null {
  const resolved = delivered + returned;
  return resolved > 0 ? Math.round((delivered / resolved) * 1000) / 10 : null;
}

function finishBucket(b: DeliveryBucket): DeliveryBucket {
  b.deliveryRate = computeDeliveryRate(b.delivered, b.returned);
  return b;
}

/** Producto "principal" del pedido: primera línea de producto (no servicio). */
function primaryProduct(r: ShippedRow): string {
  if (r.raw_payload) {
    try {
      const items = lineItemsFromPayload(JSON.parse(r.raw_payload)).filter((i) => !i.isService);
      if (items[0]) return items[0].sku ? `${items[0].sku} · ${items[0].title}` : items[0].title;
    } catch {
      /* payload ilegible: cae al resumen */
    }
  }
  const primera = (r.product_summary ?? "").split("\n")[0]?.trim() ?? "";
  return primera.replace(/^\d+x\s+/i, "") || "(sin producto)";
}

function buildWindow(rows: ShippedRow[], created: number, cancelled: number): DeliveryWindow {
  const total = emptyBucket("total");
  const porProducto = new Map<string, DeliveryBucket>();
  const porProveedor = new Map<string, DeliveryBucket>();
  const porCarrier = new Map<string, DeliveryBucket>();
  let sumaHoras = 0;
  let nEntregados = 0;

  const bucket = (m: Map<string, DeliveryBucket>, k: string) => {
    let b = m.get(k);
    if (!b) {
      b = emptyBucket(k);
      m.set(k, b);
    }
    return b;
  };

  for (const r of rows) {
    addToBucket(total, r);
    addToBucket(bucket(porProducto, primaryProduct(r)), r);
    addToBucket(bucket(porProveedor, r.supplier_platform ?? "sin proveedor"), r);
    addToBucket(bucket(porCarrier, (r.carrier ?? "").trim() || "sin transportista"), r);
    if (r.status === "delivered" && r.delivered_at && r.delivered_at >= r.shipped_at) {
      sumaHoras += (r.delivered_at - r.shipped_at) / 3600;
      nEntregados++;
    }
  }

  const ordenar = (m: Map<string, DeliveryBucket>) =>
    [...m.values()].map(finishBucket).sort((a, b) => b.shipped - a.shipped);

  return {
    ...finishBucket(total),
    created,
    cancelled,
    avgHoursToDeliver: nEntregados > 0 ? Math.round((sumaHoras / nEntregados) * 10) / 10 : null,
    byProduct: ordenar(porProducto),
    bySupplier: ordenar(porProveedor),
    byCarrier: ordenar(porCarrier),
  };
}

export function deliveryRateMinSample(): number {
  const v = parseInt(process.env.DELIVERY_RATE_MIN_SAMPLE ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 10;
}

/** Inicio del día local (epoch s). Inyectable para tests. */
export function startOfLocalDay(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Envíos con su primer estado de envío y (si hay) su entrega. */
export function listShippedRows(fromTs: number, toTs: number): ShippedRow[] {
  const db = systemDbHandle();
  const ph = SHIPPED_STATES.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT o.id, o.supplier_platform, o.carrier, o.supplier_status_normalized AS status,
              o.raw_payload, o.product_summary,
              s.shipped_at,
              (SELECT MIN(occurred_at) FROM order_status_history d
                WHERE d.order_id = o.id AND d.new_status = 'delivered') AS delivered_at
       FROM orders o
       JOIN (
         SELECT order_id, MIN(occurred_at) AS shipped_at
         FROM order_status_history
         WHERE new_status IN (${ph})
         GROUP BY order_id
       ) s ON s.order_id = o.id
       WHERE s.shipped_at >= ? AND s.shipped_at < ?`
    )
    .all(...SHIPPED_STATES, fromTs, toTs) as ShippedRow[];
}

function countOrders(fromTs: number, toTs: number): { created: number; cancelled: number } {
  const db = systemDbHandle();
  const created = (
    db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?").get(fromTs, toTs) as {
      n: number;
    }
  ).n;
  const cancelled = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND (status = 'cancelled' OR supplier_status_normalized = 'cancelled')"
      )
      .get(fromTs, toTs) as { n: number }
  ).n;
  return { created, cancelled };
}

export function getDeliveryWindow(fromTs: number, toTs: number): DeliveryWindow {
  const rows = listShippedRows(fromTs, toTs);
  const { created, cancelled } = countOrders(fromTs, toTs);
  return buildWindow(rows, created, cancelled);
}

export function getDeliveryMetrics(nowMs = Date.now()): DeliveryMetrics {
  const now = Math.floor(nowMs / 1000);
  const hoy = startOfLocalDay(nowMs);
  const fin = now + 1;
  return {
    generatedAt: now,
    today: getDeliveryWindow(hoy, fin),
    last7d: getDeliveryWindow(now - 7 * 86400, fin),
    last30d: getDeliveryWindow(now - 30 * 86400, fin),
    minSample: deliveryRateMinSample(),
  };
}
