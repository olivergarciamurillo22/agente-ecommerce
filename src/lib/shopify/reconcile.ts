// ============================================================
// Reconciliación periódica con Shopify (E5 ligera): los webhooks se pueden
// perder (despliegues, caídas). Cada X horas se piden los pedidos TOCADOS
// recientemente en Shopify (updated_at_min) y se repara la deriva del eje
// de cierre. Es reconciliación de datos: CERO efectos externos.
//
// SALVAGUARDA ESTRUCTURAL (igual que el backfill): este fichero no importa
// nada de WhatsApp/Baileys ni de proveedores — hay un test de código fuente
// que lo vigila.
//
// Reglas:
//  1. Pedido local + señal de cierre de Shopify más NUEVA que closure_at →
//     setOrderClosure (que ya respeta terminales). Más vieja → se descarta.
//  2. Pedido COD que existe en Shopify y NO localmente (orders/create
//     perdido) → se inserta con status='ignored_old' (nunca accionable) y
//     se avisa con un integration_event WARNING: un create perdido es
//     excepcional y lo tiene que ver un humano.
//  3. Conflicto (Shopify dice un terminal distinto del guardado) → evento
//     'closure_conflict' para revisión; NUNCA se pisa el terminal local.
//  4. (E4) Enlace con Dropea por el tag `dropea_id:NNNNNNN` del propio
//     payload: rellena supplier_external_order_id si está vacío. Es un
//     latch de un solo sentido y sin red — el parser vive en
//     `orders/supplier-tags.ts` justamente para no importar `suppliers/*`
//     aquí (lo vigila el test de salvaguarda estructural).
// ============================================================

import pino from "pino";
import {
  getOrderByShopifyId,
  insertOrderIfNew,
  setOrderClosure,
} from "../db";
import { isCodOrder, normalizeOrder } from "../orders/normalize";
import { linkDropeaFromShopifyTags } from "../orders/supplier-tags";
import { getAdminAccessToken, shopifyAdminConfigured } from "./admin";
import {
  planClosureFromShopify,
  type ShopifyBackfillOrder,
} from "./backfill";
import { logIntegrationEvent } from "../system/repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

function apiVersion(): string {
  return process.env.SHOPIFY_API_VERSION || "2026-07";
}
function storeDomain(): string {
  return (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export type RecentOrdersFetcher = (updatedAtMinIso: string) => Promise<ShopifyBackfillOrder[]>;

/** Fetch real: pedidos tocados desde `updated_at_min` (hasta 250, suficiente
 *  para una ventana de 48 h con decenas de pedidos; si hubiera más, la
 *  siguiente pasada los recoge por updated_at). */
export const fetchRecentShopifyOrders: RecentOrdersFetcher = async (updatedAtMinIso) => {
  const token = await getAdminAccessToken();
  if (!token) throw new Error("sin token de acceso de Shopify");
  const params = new URLSearchParams({
    status: "any",
    limit: "250",
    updated_at_min: updatedAtMinIso,
  });
  const res = await fetch(
    `https://${storeDomain()}/admin/api/${apiVersion()}/orders.json?${params.toString()}`,
    { headers: { "X-Shopify-Access-Token": token }, signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) throw new Error(`orders.json HTTP ${res.status}`);
  const json = (await res.json()) as { orders?: ShopifyBackfillOrder[] };
  return json.orders ?? [];
};

export interface ReconcileReport {
  seen: number;
  repaired: number;
  insertedMissing: number;
  conflicts: number;
  skipped: number;
  /** E4: pedidos enganchados a Dropea leyendo el tag `dropea_id:` de Shopify. */
  linkedDropea: number;
}

/**
 * Una pasada de reconciliación. Pura respecto a la red salvo el fetcher
 * (inyectable). Solo escribe el eje de cierre y, excepcionalmente, inserta
 * pedidos perdidos como ignored_old.
 */
export async function runShopifyReconcile(opts: {
  lookbackHours?: number;
  fetcher?: RecentOrdersFetcher;
  nowMs?: number;
} = {}): Promise<ReconcileReport> {
  const lookback = opts.lookbackHours ?? (Number(process.env.RECONCILE_LOOKBACK_HOURS) || 48);
  const fetcher = opts.fetcher ?? fetchRecentShopifyOrders;
  const nowMs = opts.nowMs ?? Date.now();
  const sinceIso = new Date(nowMs - lookback * 3600_000).toISOString();

  const report: ReconcileReport = {
    seen: 0,
    repaired: 0,
    insertedMissing: 0,
    conflicts: 0,
    skipped: 0,
    linkedDropea: 0,
  };
  const orders = await fetcher(sinceIso);

  for (const remote of orders) {
    report.seen++;
    if (!remote.id || !isCodOrder(remote)) {
      report.skipped++;
      continue;
    }
    const signal = planClosureFromShopify(remote);
    const local = getOrderByShopifyId(String(remote.id));

    if (!local) {
      // orders/create perdido: excepcional. Se importa SIN accionar nada.
      const n = normalizeOrder(remote);
      const { order: fila, created } = insertOrderIfNew({
        shopify_order_id: n.shopifyOrderId,
        shopify_order_number: n.orderNumber,
        customer_name: n.customerName,
        phone: n.phone,
        email: n.email,
        product_summary: n.productSummary,
        total_price: n.totalPrice,
        currency: n.currency,
        address_line1: n.addressLine1,
        address_line2: n.addressLine2,
        city: n.city,
        province: n.province,
        postal_code: n.postalCode,
        country: n.country,
        status: "ignored_old",
        customer_note: n.customerNote,
        last_error: "reconciled_from_shopify: webhook orders/create perdido — revisar a mano",
        raw_payload: JSON.stringify(remote).slice(0, 200_000),
      });
      if (created) {
        report.insertedMissing++;
        logIntegrationEvent(
          "shopify",
          "order_missed_create",
          "warning",
          "pedido existente en Shopify que nunca llegó por webhook: importado como ignored_old, revisar",
          n.orderNumber
        );
        if (signal) setOrderClosure(fila.id, signal.status, "shopify", signal.at);
        // E4: si Shopify ya sabe a qué pedido de Dropea corresponde, se
        // aprovecha ahora — el pedido es historial, pero el enlace sirve
        // para el seguimiento y para no volver a preguntárselo a nadie.
        if (linkDropeaFromShopifyTags(fila, remote, "reconcile (create perdido)").linked) {
          report.linkedDropea++;
        }
      }
      continue;
    }

    // E4: el enlace con Dropea no depende de que haya señal de cierre — un
    // pedido en curso es justo el que más falta hace enganchar. Va antes de
    // cualquier salida temprana.
    if (linkDropeaFromShopifyTags(local, remote, "reconcile").linked) {
      report.linkedDropea++;
    }

    if (!signal) {
      report.skipped++;
      continue;
    }

    // Fuera de orden: no aplicar una señal más vieja que lo ya guardado.
    if (local.closure_at !== null && signal.at <= local.closure_at) {
      report.skipped++;
      continue;
    }
    const applied = setOrderClosure(local.id, signal.status, "shopify", signal.at);
    if (applied) {
      if (local.closure_status !== signal.status) {
        report.repaired++;
        logger.info(
          `[RECONCILE] #${local.shopify_order_number}: closure ${local.closure_status} → ${signal.status} (webhook perdido reparado)`
        );
      } else {
        report.skipped++;
      }
    } else {
      // Terminal local distinto del que dice Shopify: conflicto, no se pisa.
      report.conflicts++;
      logIntegrationEvent(
        "shopify",
        "closure_conflict",
        "warning",
        `Shopify dice "${signal.status}" pero el cierre local es terminal "${local.closure_status}": revisar a mano`,
        local.shopify_order_number
      );
    }
  }

  return report;
}

// --- Scheduler ---

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function reconcileEnabled(): boolean {
  return process.env.RECONCILE_ENABLED !== "0";
}

export function startReconcileScheduler(): void {
  if (timer) return;
  if (!reconcileEnabled()) {
    logger.info("[RECONCILE] desactivado (RECONCILE_ENABLED=0)");
    return;
  }
  const horas = Number(process.env.RECONCILE_INTERVAL_HOURS) || 6;
  logger.info(`[RECONCILE] reconciliación con Shopify activa (cada ${horas} h)`);
  const tick = () => {
    if (ticking) return;
    if (!shopifyAdminConfigured()) return;
    ticking = true;
    runShopifyReconcile()
      .then((r) => {
        if (r.repaired || r.insertedMissing || r.conflicts || r.linkedDropea) {
          logger.info(
            `[RECONCILE] vistos=${r.seen} reparados=${r.repaired} importados=${r.insertedMissing} conflictos=${r.conflicts} enlazados_dropea=${r.linkedDropea}`
          );
        }
      })
      .catch((err) =>
        logger.warn(`[RECONCILE] fallo (se reintenta en el próximo ciclo): ${err instanceof Error ? err.message : err}`)
      )
      .finally(() => {
        ticking = false;
      });
  };
  timer = setInterval(tick, horas * 3600_000);
  // Primera pasada a los 2 minutos del arranque (deja que WhatsApp conecte primero).
  setTimeout(tick, 2 * 60_000);
}
