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
import { startOfBusinessDay, endOfBusinessDay, lastBusinessDays } from "../time";
import { computeClosureDeliveryRate } from "../orders/closure";
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
  /** Eje de CIERRE (fuente de verdad de negocio). `deliveryRate` de la
   *  ventana sale de aquí, no de los contadores logísticos de abajo. */
  closure: ClosureBreakdown;
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
    // Placeholder: getDeliveryWindow() lo sustituye por el desglose real del
    // eje de cierre. buildWindow solo sabe de logística, a propósito.
    closure: emptyClosure(),
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

/**
 * Inicio del día de NEGOCIO (medianoche de Madrid), epoch s.
 *
 * Antes era `new Date().setHours(0,0,0,0)`: medianoche del huso del PROCESO.
 * Con el host del NAS en Europe/Brussels o un script sin TZ, la ventana "hoy"
 * se desplazaba y los pedidos de la noche contaban en el día equivocado.
 */
export function startOfLocalDay(nowMs = Date.now()): number {
  return startOfBusinessDay(nowMs);
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


// ============================================================
// CIERRE DE NEGOCIO — eje 4 (`orders.closure_status`).
//
// FUENTE DE VERDAD de la tasa de entrega desde el 25-08-2026. Antes esta
// métrica se calculaba sobre `supplier_status_normalized`, que es el eje
// LOGÍSTICO: el resultado era que todo lo que E5/E8 escribían en el eje de
// cierre no aparecía por ninguna parte, y la tarjeta seguía diciendo "sin
// datos" aunque hubiera entregas confirmadas. Los dos ejes nunca se cruzaban.
//
// FÓRMULA (acordada, no negociable sin volver a acordarla):
//
//     tasa de entrega = delivered / (delivered + refused)
//
// `unknown`, `in_progress` y `cancelled` NO entran ni en el numerador ni en
// el denominador. Un pedido cancelado no es una entrega fallida: nunca se
// llegó a intentar entregarlo, y meterlo en el denominador hundiría la tasa
// por razones ajenas a la logística.
//
// La ventana se mide por `closure_at` — la fecha del EVENTO en la fuente, no
// la de proceso — para que "entregados esta semana" signifique lo que dice.
// ============================================================

export interface ClosureBreakdown {
  delivered: number;
  refused: number;
  inProgress: number;
  cancelled: number;
  unknown: number;
  /** delivered + refused: los únicos que cuentan para la tasa. */
  resolved: number;
  /** delivered / (delivered + refused). `null` si no hay ninguno resuelto. */
  deliveryRate: number | null;
}

function emptyClosure(): ClosureBreakdown {
  return {
    delivered: 0,
    refused: 0,
    inProgress: 0,
    cancelled: 0,
    unknown: 0,
    resolved: 0,
    deliveryRate: null,
  };
}

/**
 * Desglose del eje de cierre en una ventana, por `closure_at`.
 *
 * Los `unknown` se cuentan por `created_at`: por definición no tienen
 * `closure_at`, y aun así hay que poder verlos — son los pedidos de los que
 * el sistema todavía no sabe nada, y su número es en sí mismo una alerta.
 */
export function getClosureBreakdown(fromTs: number, toTs: number): ClosureBreakdown {
  const db = systemDbHandle();
  const out = emptyClosure();

  const filas = db
    .prepare(
      `SELECT closure_status AS s, COUNT(*) AS n FROM orders
        WHERE closure_status != 'unknown' AND closure_at >= ? AND closure_at < ?
        GROUP BY closure_status`
    )
    .all(fromTs, toTs) as Array<{ s: string; n: number }>;
  for (const f of filas) {
    if (f.s === "delivered") out.delivered = f.n;
    else if (f.s === "refused") out.refused = f.n;
    else if (f.s === "in_progress") out.inProgress = f.n;
    else if (f.s === "cancelled") out.cancelled = f.n;
  }

  out.unknown = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
          WHERE closure_status = 'unknown' AND created_at >= ? AND created_at < ?`
      )
      .get(fromTs, toTs) as { n: number }
  ).n;

  out.resolved = out.delivered + out.refused;
  out.deliveryRate = computeClosureDeliveryRate(out.delivered, out.refused);
  return out;
}

export function getDeliveryWindow(fromTs: number, toTs: number): DeliveryWindow {
  const rows = listShippedRows(fromTs, toTs);
  const { created, cancelled } = countOrders(fromTs, toTs);
  const ventana = buildWindow(rows, created, cancelled);
  const closure = getClosureBreakdown(fromTs, toTs);
  return {
    ...ventana,
    closure,
    // La tasa de la ventana SALE DEL EJE DE CIERRE. Los buckets por producto,
    // proveedor y transportista siguen siendo logísticos a propósito: ahí lo
    // que interesa es el comportamiento del envío, no el desenlace económico.
    deliveryRate: closure.deliveryRate,
  };
}

export function getDeliveryMetrics(nowMs = Date.now()): DeliveryMetrics {
  const now = Math.floor(nowMs / 1000);
  // Ventanas alineadas a MEDIANOCHE DE MADRID, no a "ahora menos N×86400":
  // así "últimos 7 días" son siete días naturales completos y el resultado no
  // depende de a qué hora se mire el panel. `lastBusinessDays` sobrevive
  // además a los días de 23 h y 25 h de los cambios de hora.
  const hoy = { from: startOfBusinessDay(nowMs), to: endOfBusinessDay(nowMs) };
  const w7 = lastBusinessDays(7, nowMs);
  const w30 = lastBusinessDays(30, nowMs);
  return {
    generatedAt: now,
    today: getDeliveryWindow(hoy.from, hoy.to),
    last7d: getDeliveryWindow(w7.from, w7.to),
    last30d: getDeliveryWindow(w30.from, w30.to),
    minSample: deliveryRateMinSample(),
  };
}
