// ============================================================
// Backfill del histórico de pedidos de Shopify (E3 — espejo de Shopify).
//
// Objetivo: que la base local deje de estar ciega a lo que pasó con un
// pedido DESPUÉS de crearse (el bug que originó todo esto: el panel decía
// 10 "pendientes de llamada" y la realidad en Shopify era 4 anulados, 5 en
// curso y 1 de verdad pendiente).
//
// SALVAGUARDA ESTRUCTURAL (no un flag): este fichero NO importa NI PUEDE
// importar nada de WhatsApp. No hay ningún `import` de "../whatsapp",
// "../baileys/*", "../orders/messages" ni "../orders/confirmation" aquí
// abajo — compruébalo con los ojos, y el test "E3 salvaguarda estructural"
// falla si algún día aparece uno (un `if (dryRun) return` se borra por
// accidente en un refactor; un import que no existe, no).
//
// Reglas de diseño (acordadas 23-08-2026):
//  1. Solo toca `orders` cuyo closure_status sea 'unknown' Y closure_source
//     sea NULL. Si un webhook (Dropea o el propio Shopify vía E2) ya escribió
//     algo, el backfill NUNCA lo pisa: el histórico es menos fiable que el
//     evento en vivo.
//  2. closure_at es SIEMPRE la fecha que reporta Shopify (cancelled_at o
//     updated_at), nunca la hora en la que corre el script — si no, la
//     cronología real se pierde y las métricas de tiempo-hasta-cierre nacen
//     corruptas.
//  3. Pedidos que existen en Shopify pero no localmente: SÍ se insertan
//     (con el mismo normalizeOrder() que usa el webhook orders/create), pero
//     con status = 'ignored_old' — el estado ya existente en la máquina de
//     confirmación para "no actuar nunca sobre esto" — para que no disparen
//     ninguna cola de llamadas ni de confirmaciones.
//  4. Paginación por cursor + checkpoint persistido (tabla `settings`, ya
//     genérica): un proceso interrumpido se reanuda desde la última página
//     completada, no desde el principio.
//  5. `fulfilled` en Shopify → closure_status 'in_progress', NUNCA
//     'delivered' (misma decisión que E2: la entrega real solo la sabe el
//     proveedor).
//  6. (E4) De paso, el mismo recorrido enlaza con Dropea leyendo el tag
//     `dropea_id:NNNNNNN` que su app deja en el pedido de Shopify. Es un
//     eje INDEPENDIENTE del de cierre: se decide y se cuenta aparte, y el
//     dry-run lo desglosa igual que las transiciones. Solo se considera el
//     mismo universo que el resto del backfill (pedidos COD), y solo se
//     escribe si `supplier_external_order_id` está vacío.
// ============================================================

import pino from "pino";
import {
  getOrderByShopifyId,
  getSetting,
  insertOrderIfNew,
  setOrderClosure,
  setSetting,
  type ClosureStatus,
  type OrderRow,
} from "../db";
import { isCodOrder, normalizeOrder, type ShopifyOrderPayload } from "../orders/normalize";
import {
  extractDropeaIdFromPayload,
  linkDropeaFromShopifyTags,
} from "../orders/supplier-tags";
import { getAdminAccessToken, shopifyAdminConfigured } from "./admin";
import { logIntegrationEvent } from "../system/repo";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

const CHECKPOINT_KEY = "shopify_backfill_cursor";
const LAST_RUN_KEY = "shopify_backfill_last_run_at";

// ============================================================
// Verificación de SCOPES (trampa conocida de Shopify): sin `read_all_orders`
// la API devuelve SOLO los últimos 60 días — en silencio, con 200 OK. Un
// backfill que termina "completo" sin ese scope NO ha visto el histórico.
// Por eso el informe lleva `coverage`, y nunca se afirma cobertura total
// sin haber comprobado el scope de verdad.
// ============================================================

export type BackfillCoverage = "full" | "last_60_days_only" | "unverified";

export interface ScopeCheck {
  /** true si se pudo consultar access_scopes.json. */
  verified: boolean;
  hasReadAllOrders: boolean;
  scopes: string[];
  error: string | null;
}

export type ScopeFetcher = () => Promise<string[]>;

/** Consulta real: GET /admin/oauth/access_scopes.json con el token. */
export const fetchShopifyAccessScopes: ScopeFetcher = async () => {
  const token = await getAdminAccessToken();
  if (!token) throw new Error("sin token de acceso de Shopify");
  const res = await fetch(`https://${storeDomain()}/admin/oauth/access_scopes.json`, {
    headers: { "X-Shopify-Access-Token": token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`access_scopes.json HTTP ${res.status}`);
  const json = (await res.json()) as { access_scopes?: Array<{ handle?: string }> };
  return (json.access_scopes ?? []).map((s) => s.handle ?? "").filter(Boolean);
};

export async function checkBackfillScopes(fetcher: ScopeFetcher = fetchShopifyAccessScopes): Promise<ScopeCheck> {
  try {
    const scopes = await fetcher();
    return {
      verified: true,
      hasReadAllOrders: scopes.includes("read_all_orders"),
      scopes,
      error: null,
    };
  } catch (err) {
    return {
      verified: false,
      hasReadAllOrders: false,
      scopes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function apiVersion(): string {
  return process.env.SHOPIFY_API_VERSION || "2026-07";
}

function storeDomain(): string {
  return (process.env.SHOPIFY_STORE_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// Campos exactos que consume ShopifyOrderPayload / normalizeOrder(): pedir
// solo estos (parámetro `fields` de la REST Admin API) evita traer PII de
// más y mantiene la página ligera.
const ORDER_FIELDS = [
  "id",
  "order_number",
  "name",
  "email",
  "phone",
  "note",
  "created_at",
  "updated_at",
  "cancelled_at",
  "currency",
  "total_price",
  "financial_status",
  "fulfillment_status",
  "gateway",
  "payment_gateway_names",
  "tags",
  "customer",
  "shipping_address",
  "billing_address",
  "line_items",
  "note_attributes",
].join(",");

/** Payload de una orden tal cual la devuelve REST orders.json, más los dos
 *  campos de cierre que normalizeOrder() no necesita pero nosotros sí. */
export type ShopifyBackfillOrder = ShopifyOrderPayload & {
  fulfillment_status?: string | null;
};

export interface BackfillPage {
  orders: ShopifyBackfillOrder[];
  /** Cursor para pedir la siguiente página. null = no hay más. */
  nextCursor: string | null;
}

export type PageFetcher = (cursor: string | null) => Promise<BackfillPage>;

/** Parsea el header Link de Shopify: `<url>; rel="next"` → el page_info de esa url. */
function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const partes = linkHeader.split(",");
  for (const p of partes) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(p.trim());
    if (m) {
      try {
        return new URL(m[1]).searchParams.get("page_info");
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetcher REAL contra la Admin API de Shopify (REST, orders.json). Respeta
 * el 429 (Retry-After) reintentando, y añade una pausa entre páginas para no
 * agotar el rate limit de entrada. Inyectable: los tests pasan uno falso.
 */
export const fetchShopifyOrdersPage: PageFetcher = async (cursor) => {
  if (!shopifyAdminConfigured()) {
    throw new Error("Admin API de Shopify no configurada (falta SHOPIFY_STORE_DOMAIN o credenciales)");
  }
  const token = await getAdminAccessToken();
  if (!token) throw new Error("No se pudo obtener un token de acceso de Shopify");

  const base = `https://${storeDomain()}/admin/api/${apiVersion()}/orders.json`;
  const params = new URLSearchParams({ status: "any", limit: "100", fields: ORDER_FIELDS });
  if (cursor) params.set("page_info", cursor);
  const url = `${base}?${params.toString()}`;

  const maxRetries = 5;
  for (let intento = 0; intento <= maxRetries; intento++) {
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 2;
      logger.warn(`[SHOPIFY BACKFILL] 429 — esperando ${retryAfter}s antes de reintentar`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`orders.json HTTP ${res.status}`);
    }
    const json = (await res.json()) as { orders?: ShopifyBackfillOrder[] };
    const nextCursor = parseNextCursor(res.headers.get("link"));
    const delayMs = Number(process.env.SHOPIFY_BACKFILL_PAGE_DELAY_MS) || 500;
    if (delayMs > 0) await sleep(delayMs);
    return { orders: json.orders ?? [], nextCursor };
  }
  throw new Error("orders.json: demasiados 429 seguidos, abandonado");
};

// --- Lógica pura: qué señal de cierre trae este pedido, y qué hacer con ella ---

export interface ClosureSignal {
  status: Extract<ClosureStatus, "cancelled" | "in_progress">;
  /** epoch segundos — SIEMPRE la fecha de Shopify, nunca now(). */
  at: number;
}

function toEpochSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * ¿Este pedido tiene ya mercancía en camino, según Shopify?
 *
 * `fulfillment_status` de un pedido REST vale `null` | `"partial"` |
 * `"fulfilled"` | `"restocked"`.
 *
 * **`partial` cuenta.** Si una sola línea se despachó, el pedido está en
 * curso. Y en Casamable es el caso NORMAL, no el raro: los pedidos llevan una
 * línea `Seguro de Envío` que no es mercancía y que el proveedor nunca
 * despacha, así que el pedido se queda en `partial` para siempre y jamás
 * llega a `fulfilled`. Mirar solo `fulfilled` dejaba esos pedidos con el
 * cierre en `unknown` — y era candidato a explicar el `in_progress = 0`
 * medido el 24-08-2026 pese a haber envíos con seguimiento real.
 *
 * `restocked` NO cuenta: significa que la mercancía volvió al almacén, que es
 * lo contrario de estar en camino.
 */
function isFulfillmentUnderway(status: string | null | undefined): boolean {
  return status === "fulfilled" || status === "partial";
}

/**
 * ¿Qué dice Shopify sobre el cierre de este pedido? `null` = ningún cierre
 * conocido todavía (sigue abierto/sin fulfillment) — NO se adivina nada.
 */
export function planClosureFromShopify(order: ShopifyBackfillOrder): ClosureSignal | null {
  const cancelledAt = toEpochSeconds(order.cancelled_at);
  if (cancelledAt !== null) return { status: "cancelled", at: cancelledAt };

  if (isFulfillmentUnderway(order.fulfillment_status)) {
    const at = toEpochSeconds(order.updated_at) ?? toEpochSeconds(order.created_at);
    if (at !== null) return { status: "in_progress", at };
  }
  return null;
}

export type BackfillActionKind =
  | "insert_cancelled"
  | "insert_in_progress"
  | "update_cancelled"
  | "update_in_progress"
  | "skip_not_cod"
  | "skip_no_signal"
  | "skip_has_own_source";

export interface BackfillAction {
  kind: BackfillActionKind;
  signal: ClosureSignal | null;
}

/** Decisión PURA: no toca la DB ni la red. Es lo que se prueba a fondo. */
export function decideBackfillAction(existing: OrderRow | null, order: ShopifyBackfillOrder): BackfillAction {
  if (!isCodOrder(order)) return { kind: "skip_not_cod", signal: null };

  const signal = planClosureFromShopify(order);
  if (!signal) return { kind: "skip_no_signal", signal: null };

  if (existing) {
    // Regla dura: si ya tiene closure_source (un webhook llegó primero), el
    // backfill nunca lo pisa, sea 'unknown' su closure_status o no.
    if (existing.closure_source !== null || existing.closure_status !== "unknown") {
      return { kind: "skip_has_own_source", signal: null };
    }
    return { kind: signal.status === "cancelled" ? "update_cancelled" : "update_in_progress", signal };
  }

  return { kind: signal.status === "cancelled" ? "insert_cancelled" : "insert_in_progress", signal };
}

// --- E4 · Eje independiente: enlace con Dropea por tag ---

export type DropeaLinkPlan =
  /** Se enlazaría ahora: hay tag válido y el pedido queda sin id externo. */
  | "link"
  /** Ya tenía id externo: no se pisa jamás. */
  | "already_linked"
  /** El pedido no lleva ningún `dropea_id:` (lo normal en los de Dropi). */
  | "no_tag"
  /** Lleva tag pero ambiguo o con formato roto: no se adivina nada. */
  | "tag_unusable"
  /** No existe localmente y este backfill tampoco lo va a insertar. */
  | "no_local_order"
  /** Fuera del universo del backfill. */
  | "not_cod";

/**
 * Decisión PURA del enlace E4: ni DB ni red. `willExistLocally` es true
 * cuando la acción de cierre va a insertar el pedido en esta misma pasada.
 */
export function decideDropeaLink(
  existing: OrderRow | null,
  order: ShopifyBackfillOrder,
  willExistLocally: boolean
): DropeaLinkPlan {
  if (!isCodOrder(order)) return "not_cod";
  const outcome = extractDropeaIdFromPayload(order);
  if (outcome.kind === "absent") return "no_tag";
  if (outcome.kind !== "found") return "tag_unusable";
  if (existing?.supplier_external_order_id) return "already_linked";
  if (!existing && !willExistLocally) return "no_local_order";
  return "link";
}

/** Aplica la acción (INSERT/UPDATE de verdad). Solo se llama fuera de dry-run. */
function applyBackfillAction(action: BackfillAction, order: ShopifyBackfillOrder, rawBody: string): void {
  if (!action.signal) return; // skip_* — nada que aplicar.

  if (action.kind === "insert_cancelled" || action.kind === "insert_in_progress") {
    const n = normalizeOrder(order);
    const { order: fila } = insertOrderIfNew({
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
      // TERMINAL a propósito: nunca debe entrar en ninguna cola de WhatsApp
      // ni de llamadas. Es historial, no un pedido nuevo que confirmar.
      status: "ignored_old",
      customer_note: n.customerNote,
      last_error: "backfilled_from_shopify: pedido histórico importado por E3, nunca activo",
      raw_payload: rawBody.slice(0, 200_000),
      ordered_at: n.orderedAt,
    });
    setOrderClosure(fila.id, action.signal.status, "shopify", action.signal.at);
    return;
  }

  // update_cancelled / update_in_progress: el pedido ya existe localmente.
  const existing = getOrderByShopifyId(String(order.id));
  if (existing) setOrderClosure(existing.id, action.signal.status, "shopify", action.signal.at);
}

export interface BackfillReport {
  pagesProcessed: number;
  ordersSeen: number;
  counts: Record<BackfillActionKind, number>;
  /** Resumen de 3 líneas que pidió Pedro: lo que aplicaría/aplicó, y lo que no cambia. */
  summary: { toCancelled: number; toInProgress: number; unchanged: number };
  /** E4: desglose del eje de enlace con Dropea (independiente del cierre). */
  dropeaLink: Record<DropeaLinkPlan, number>;
  /** E4: enlaces escritos DE VERDAD (siempre 0 en dry-run). Puede ser menor
   *  que `dropeaLink.link` si el id ya lo tenía otro pedido o hubo carrera. */
  dropeaLinked: number;
  /** true = se recorrió todo lo que la API nos deja ver. NO implica el
   *  histórico completo: eso lo dice `coverage`. */
  done: boolean;
  nextCursor: string | null;
  /** Resultado de la comprobación de scopes (read_all_orders). */
  scopeCheck: ScopeCheck;
  /** full = scope verificado con read_all_orders. last_60_days_only = scope
   *  verificado SIN read_all_orders (la API solo enseña 60 días).
   *  unverified = no se pudo comprobar: NO se puede afirmar cobertura. */
  coverage: BackfillCoverage;
}

function emptyLinkCounts(): Record<DropeaLinkPlan, number> {
  return {
    link: 0,
    already_linked: 0,
    no_tag: 0,
    tag_unusable: 0,
    no_local_order: 0,
    not_cod: 0,
  };
}

function emptyCounts(): Record<BackfillActionKind, number> {
  return {
    insert_cancelled: 0,
    insert_in_progress: 0,
    update_cancelled: 0,
    update_in_progress: 0,
    skip_not_cod: 0,
    skip_no_signal: 0,
    skip_has_own_source: 0,
  };
}

export interface RunBackfillOptions {
  /** false (por defecto) = no escribe nada, solo cuenta qué haría. */
  dryRun?: boolean;
  /** Para tests: fuente de páginas inyectada, en vez del fetch real a Shopify. */
  pageFetcher?: PageFetcher;
  /** Para tests: fuente de scopes inyectada, en vez del fetch real. */
  scopeFetcher?: ScopeFetcher;
  /** Tope de páginas en esta ejecución (por si se quiere trocear a mano). */
  maxPages?: number;
  /** Ignora el checkpoint guardado y empieza desde el principio. */
  resetCheckpoint?: boolean;
  onPage?: (n: number, ordersEnPagina: number) => void;
}

/**
 * Orquesta la paginación + el checkpoint. La fuente de páginas es
 * INYECTABLE (pageFetcher) precisamente para poder probar la reanudación y
 * el conteo sin red real — el fetcher de verdad (fetchShopifyOrdersPage) es
 * solo el valor por defecto.
 */
export async function runShopifyBackfill(opts: RunBackfillOptions = {}): Promise<BackfillReport> {
  const dryRun = opts.dryRun !== false; // por defecto SIEMPRE dry-run
  const fetchPage = opts.pageFetcher ?? fetchShopifyOrdersPage;
  const maxPages = opts.maxPages ?? Infinity;

  // Scope ANTES de recorrer nada: define qué puede afirmar el informe.
  const scopeCheck = await checkBackfillScopes(opts.scopeFetcher);
  const coverage: BackfillCoverage = !scopeCheck.verified
    ? "unverified"
    : scopeCheck.hasReadAllOrders
      ? "full"
      : "last_60_days_only";
  if (coverage !== "full") {
    logger.warn(
      `[SHOPIFY BACKFILL] cobertura ${coverage}: ` +
        (coverage === "unverified"
          ? `no se pudieron comprobar los scopes (${scopeCheck.error})`
          : "falta el scope read_all_orders — la API solo devuelve los últimos 60 días, EN SILENCIO")
    );
  }

  let cursor = opts.resetCheckpoint ? null : getSetting(CHECKPOINT_KEY) || null;
  const counts = emptyCounts();
  const dropeaLink = emptyLinkCounts();
  let dropeaLinked = 0;
  let pagesProcessed = 0;
  let ordersSeen = 0;
  let done = false;

  while (pagesProcessed < maxPages) {
    const page = await fetchPage(cursor);
    pagesProcessed++;
    ordersSeen += page.orders.length;
    opts.onPage?.(pagesProcessed, page.orders.length);

    for (const order of page.orders) {
      const existing = order.id ? getOrderByShopifyId(String(order.id)) : null;
      const action = decideBackfillAction(existing, order);
      counts[action.kind]++;

      // E4 va aparte del eje de cierre a propósito: un pedido sin señal de
      // cierre ("skip_no_signal") puede tener perfectamente su dropea_id.
      const insertara = action.kind === "insert_cancelled" || action.kind === "insert_in_progress";
      const plan = decideDropeaLink(existing, order, insertara);
      dropeaLink[plan]++;

      if (!dryRun) {
        applyBackfillAction(action, order, JSON.stringify(order));
        if (plan === "link" && order.id) {
          // Se relee: si la acción de cierre acaba de insertarlo, la fila
          // existe ahora y no antes.
          const fila = getOrderByShopifyId(String(order.id));
          if (fila && linkDropeaFromShopifyTags(fila, order, "backfill").linked) dropeaLinked++;
        }
      }
    }

    cursor = page.nextCursor;
    // Checkpoint tras cada página COMPLETA (no a mitad): si el proceso muere
    // ahora, la próxima ejecución retoma desde aquí, no desde el principio.
    // En dry-run NO se persiste: es una simulación, no debe mover el puntero
    // real del backfill.
    if (!dryRun) setSetting(CHECKPOINT_KEY, cursor ?? "");
    if (!cursor) {
      done = true;
      break;
    }
  }

  if (!dryRun && done) {
    setSetting(LAST_RUN_KEY, String(Math.floor(Date.now() / 1000)));
    logIntegrationEvent(
      "shopify",
      "backfill_completed",
      coverage === "full" ? "info" : "warning",
      `backfill recorrido (cobertura: ${coverage}): ${ordersSeen} pedido(s) vistos, ${counts.insert_cancelled + counts.update_cancelled} → cancelled, ${counts.insert_in_progress + counts.update_in_progress} → in_progress, ${dropeaLinked} enlazado(s) con Dropea por tag` +
        (coverage === "full" ? "" : " — SIN read_all_orders verificado: NO se puede afirmar histórico completo")
    );
  }

  return {
    pagesProcessed,
    ordersSeen,
    counts,
    summary: {
      toCancelled: counts.insert_cancelled + counts.update_cancelled,
      toInProgress: counts.insert_in_progress + counts.update_in_progress,
      unchanged: counts.skip_not_cod + counts.skip_no_signal + counts.skip_has_own_source,
    },
    dropeaLink,
    dropeaLinked,
    done,
    nextCursor: cursor,
    scopeCheck,
    coverage,
  };
}
