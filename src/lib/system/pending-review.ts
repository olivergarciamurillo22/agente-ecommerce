// ============================================================
// RESUMEN OPERATIVO · incidencias que esperan a una persona (07-09-2026)
// docs/deploy/RESUMEN-OPERATIVO.md
//
// POR QUÉ EXISTE: con ALERTA_DIRECCION, auto-cancelación por IA y despachos
// retenidos, aparecen cosas que solo se ven entrando al panel y mirando en
// tres sitios distintos. Esto las junta con su ANTIGÜEDAD, que es el dato que
// convierte "hay incidencias" en "esta lleva tres días sin tocar".
//
// NO duplica `action-center.ts` ni `business-alerts.ts`: ninguno de los dos
// lee address_alerts, ai_cancellations ni dispatch_cooldowns (comprobado).
// Esto es la capa que faltaba, y es de solo lectura.
//
// EL RELOJ: todos los sellos de estas tablas son `unixepoch()` (UTC). La
// antigüedad se mide en tiempo TRANSCURRIDO (segundos / 3600), no en días
// naturales, así que no depende de la zona horaria ni del cambio de hora.
//
// PUNTO CIEGO CONOCIDO: la retención (`src/lib/system/retention.ts`) no purga
// ninguna de estas tablas, así que una incidencia vieja del backfill puede
// aparecer con una antigüedad enorme. Por eso el resumen trae `staleDays`.
// ============================================================

import { systemDbHandle } from "../db";
import { AI_CANCEL_WORK_ITEM_REASON } from "../orders/ai-cancellation";

export type PendingKind = "ALERTA_DIRECCION" | "CANCELACION_IA" | "DESPACHO_RETENIDO" | "ESCALADA_SOLO_PROPIETARIO";

export interface PendingItem {
  kind: PendingKind;
  orderId: number | null;
  orderNumber: string | null;
  customer: string | null;
  phone: string | null;
  /** Momento en que la incidencia quedó abierta (unixepoch UTC). */
  since: number;
  ageHours: number;
  /** Qué pasó, en cristiano. */
  detail: string;
  /** Qué tiene que hacer una persona. */
  whatToDo: string;
}

export interface PendingReview {
  generatedAt: number;
  items: PendingItem[];
  totals: Record<PendingKind, number>;
  /** Antigüedad de la incidencia más vieja, en días. 0 si no hay ninguna. */
  staleDays: number;
  /** Cuántas llevan más de 24 h sin atenderse. */
  olderThan24h: number;
}

const KINDS: PendingKind[] = ["ALERTA_DIRECCION", "CANCELACION_IA", "DESPACHO_RETENIDO", "ESCALADA_SOLO_PROPIETARIO"];

function horas(nowSec: number, since: number): number {
  return Math.round(Math.max(0, nowSec - since) / 360) / 10;
}

interface Fila {
  order_id: number | null;
  order_number: string | null;
  customer: string | null;
  phone: string | null;
  since: number;
  extra: string | null;
  extra2: string | null;
}

/**
 * Lee las cuatro fuentes de incidencia abierta. Solo SELECT: se puede llamar
 * desde una ruta API, desde un script o desde un cron sin efectos.
 */
export function getPendingReview(nowSec = Math.floor(Date.now() / 1000)): PendingReview {
  const db = systemDbHandle();
  const items: PendingItem[] = [];

  // 1 · ALERTA_DIRECCION abierta (capa 1 o capa 2 de validación de direcciones).
  const alertas = db
    .prepare(
      `SELECT a.order_id AS order_id, o.shopify_order_number AS order_number, o.customer_name AS customer, o.phone AS phone,
              a.opened_at AS since, a.verdict AS extra, a.problems_json AS extra2
         FROM address_alerts a LEFT JOIN orders o ON o.id = a.order_id
        WHERE a.resolved_at IS NULL
        ORDER BY a.opened_at ASC`
    )
    .all() as Fila[];
  for (const r of alertas) {
    let problemas = "";
    try {
      problemas = (JSON.parse(r.extra2 ?? "[]") as string[]).slice(0, 3).join(", ");
    } catch {
      problemas = "";
    }
    items.push({
      kind: "ALERTA_DIRECCION",
      orderId: r.order_id,
      orderNumber: r.order_number,
      customer: r.customer,
      phone: r.phone,
      since: r.since,
      ageHours: horas(nowSec, r.since),
      detail: `dirección ${r.extra ?? "dudosa"}${problemas ? `: ${problemas}` : ""}`,
      whatToDo: "revisar la dirección en la ficha y pulsar «Cerrar alerta» (libera el despacho retenido)",
    });
  }

  // 2 · Cancelaciones automáticas por IA sin revertir NI resolver.
  const cancelaciones = db
    .prepare(
      `SELECT c.order_id AS order_id, o.shopify_order_number AS order_number, o.customer_name AS customer, c.phone AS phone,
              c.cancelled_at AS since, CAST(c.confidence AS TEXT) AS extra, c.message AS extra2
         FROM ai_cancellations c LEFT JOIN orders o ON o.id = c.order_id
        WHERE c.reverted_at IS NULL
          AND EXISTS (SELECT 1 FROM work_items w WHERE w.order_id = c.order_id AND w.reason = ? AND w.resolved_at IS NULL)
        ORDER BY c.cancelled_at ASC`
    )
    .all(AI_CANCEL_WORK_ITEM_REASON) as Fila[];
  for (const r of cancelaciones) {
    items.push({
      kind: "CANCELACION_IA",
      orderId: r.order_id,
      orderNumber: r.order_number,
      customer: r.customer,
      phone: r.phone,
      since: r.since,
      ageHours: horas(nowSec, r.since),
      detail: `la IA canceló el pedido sola (confianza ${r.extra ?? "?"}) por: «${(r.extra2 ?? "").slice(0, 80)}»`,
      whatToDo: "confirmar que la cancelación es correcta, o pulsar «Revertir cancelación» en la ficha",
    });
  }

  // 3 · Despachos retenidos.
  const retenidos = db
    .prepare(
      `SELECT d.order_id AS order_id, o.shopify_order_number AS order_number, o.customer_name AS customer, o.phone AS phone,
              COALESCE(d.evaluated_at, d.due_at, d.scheduled_at) AS since, d.blocked_reason AS extra, d.channel AS extra2
         FROM dispatch_cooldowns d LEFT JOIN orders o ON o.id = d.order_id
        WHERE d.status = 'blocked'
        ORDER BY since ASC`
    )
    .all() as Fila[];
  for (const r of retenidos) {
    items.push({
      kind: "DESPACHO_RETENIDO",
      orderId: r.order_id,
      orderNumber: r.order_number,
      customer: r.customer,
      phone: r.phone,
      since: r.since,
      ageHours: horas(nowSec, r.since),
      detail: `${r.extra ?? "retenido"}${r.extra2 ? ` (canal ${r.extra2})` : ""}`,
      whatToDo: "resolver la causa y pulsar «Despachar ahora» en la ficha",
    });
  }

  // 4 · Escaladas SOLO PARA EL PROPIETARIO: invisibles en la bandeja /trabajo
  //     (la filtra) pero SÍ retienen el auto-despacho. Es justo la incidencia
  //     que nadie ve, y por eso entra en este resumen.
  const soloDuenio = db
    .prepare(
      `SELECT w.order_id AS order_id, o.shopify_order_number AS order_number, o.customer_name AS customer, o.phone AS phone,
              w.created_at AS since, w.reason AS extra, NULL AS extra2
         FROM work_items w LEFT JOIN orders o ON o.id = w.order_id
        WHERE w.resolved_at IS NULL AND w.owner_only = 1
        ORDER BY w.created_at ASC`
    )
    .all() as Fila[];
  for (const r of soloDuenio) {
    items.push({
      kind: "ESCALADA_SOLO_PROPIETARIO",
      orderId: r.order_id,
      orderNumber: r.order_number,
      customer: r.customer,
      phone: r.phone,
      since: r.since,
      ageHours: horas(nowSec, r.since),
      detail: `${r.extra ?? "escalada"} — no aparece en la bandeja de atención, pero retiene el despacho`,
      whatToDo: "resolverla desde la ficha del pedido (solo el propietario la ve)",
    });
  }

  items.sort((a, b) => a.since - b.since);
  const totals = Object.fromEntries(KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<PendingKind, number>;
  const oldest = items.length ? items[0].since : nowSec;
  return {
    generatedAt: nowSec,
    items,
    totals,
    staleDays: items.length ? Math.floor(Math.max(0, nowSec - oldest) / 86400) : 0,
    olderThan24h: items.filter((i) => i.ageHours >= 24).length,
  };
}

/** Texto plano listo para un log, un correo o un WhatsApp al dueño. */
export function renderPendingReview(review: PendingReview): string {
  const l: string[] = [];
  const total = review.items.length;
  if (total === 0) return "Casamable · sin incidencias pendientes de revisión humana.";
  l.push(`Casamable · ${total} incidencia(s) esperando a una persona (${review.olderThan24h} con más de 24 h):`);
  for (const k of KINDS) {
    if (review.totals[k] > 0) l.push(`  · ${k.replace(/_/g, " ").toLowerCase()}: ${review.totals[k]}`);
  }
  l.push("");
  for (const i of review.items.slice(0, 20)) {
    const edad = i.ageHours >= 48 ? `${Math.floor(i.ageHours / 24)} d` : `${i.ageHours} h`;
    l.push(`  [${edad.padStart(5)}] ${i.kind.padEnd(26)} #${i.orderNumber ?? "?"} ${i.customer ?? ""} — ${i.detail}`);
  }
  if (total > 20) l.push(`  … y ${total - 20} más`);
  if (review.staleDays >= 3) l.push(`\n  La más antigua lleva ${review.staleDays} días sin tocarse.`);
  return l.join("\n");
}
