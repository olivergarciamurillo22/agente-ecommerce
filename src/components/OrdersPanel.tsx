"use client";

// ============================================================
// PEDIDOS v3 (§21-22, §40-41) — la mesa de trabajo de Pedro.
//
// Un pedido tiene DOS decisiones distintas que aquí no se confunden:
//   1. ¿El CLIENTE lo ha confirmado?  (status = confirmed)
//   2. ¿Está LIBERADO a Beeping?      (beeping_sync_status = released)
// La ficha enseña un CTA contextual grande: primero "Confirmar pedido",
// después "Enviar a Beeping" (con el gate explicando qué falta si algo
// bloquea). Nunca ocho botones del mismo nivel.
//
// v3: la ficha es un drawer lateral derecho en escritorio (bottom sheet en
// móvil) con secciones planas separadas por hairlines y el CTA fijo abajo.
// Conserva TODAS las acciones existentes (incluida "Avisar retraso" del
// recovery del NAS, con su misma condición ultras/gafa), sin
// window.confirm/alert.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Card,
  Chip,
  EmptyState,
  formatEuro,
  GhostButton,
  ModalShell,
  OrderStateBadge,
  PageHeader,
  PrimaryButton,
  SearchInput,
  SelectInput,
  SkeletonRows,
  StatusDot,
  timeAgo,
  type OrderUiState,
} from "./ui";

export interface OrderItem {
  id: number;
  shopify_order_id: string;
  shopify_order_number: string;
  customer_name: string | null;
  phone: string;
  email: string | null;
  product_summary: string;
  total_price: string;
  currency: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country: string | null;
  status: string;
  proposed_address: string | null;
  delivery_note: string | null;
  customer_note: string | null;
  pilot_authorized: number;
  deferred_until: number | null;
  possible_duplicate: number;
  cancellation_requested_at: number | null;
  supplier_platform: string | null;
  supplier_sync_status: string;
  supplier_external_order_id: string | null;
  supplier_last_error: string | null;
  supplier_status_normalized: string;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  tracking_last_checked_at: number | null;
  tracking_notification_sent_at: number | null;
  out_for_delivery_notification_sent_at: number | null;
  delivered_notification_sent_at: number | null;
  supplier_pilot_approved: number;
  supplier_create_phase: string;
  supplier_delivery_note_status: string;
  last_error: string | null;
  shopify_tagged: number;
  whatsapp_sent_at: number | null;
  reminder_sent_at: number | null;
  customer_replied_at: number | null;
  confirmed_at: number | null;
  needs_call_at: number | null;
  created_at: number;
  updated_at: number;
  ordered_at?: number | null;
  closure_status: string;
  beeping_sync_status: string;
  beeping_order_status: number | null;
  beeping_external_id: string | null;
  beeping_released_at: number | null;
  beeping_last_error: string | null;
  dispatch_note: string | null;
}

interface Counts {
  today: number;
  confirmedToday: number;
  awaiting: number;
  correction: number;
  needsCall: number;
  error: number;
}

interface BeepingGateInfo {
  gate: { ok: boolean; reasons: string[] };
  cutoff: { shipsToday: boolean; minutesLeft: number | null; message: string };
  beeping: {
    syncStatus: string;
    orderStatus: number | null;
    externalId: string | null;
    releasedAt: number | null;
    lastError: string | null;
  };
  dispatchNote: string | null;
}

// --- Estado UNIFICADO del pedido (§21): un solo vocabulario visual ---

export function orderUiState(o: OrderItem): OrderUiState {
  if (o.closure_status === "cancelled" || o.status === "cancelled") return "cancelled";
  if (o.closure_status === "delivered") return "delivered";
  if (o.supplier_status_normalized === "incident" || o.supplier_status_normalized === "returned" || o.supplier_sync_status === "manual_review")
    return "incident";
  if (["shipped", "in_transit", "out_for_delivery", "delivery_attempted", "at_pickup_point"].includes(o.supplier_status_normalized))
    return "shipped";
  if (o.beeping_sync_status === "released" || ["created", "processing"].includes(o.supplier_status_normalized) || (o.beeping_order_status !== null && [1, 2, 3].includes(o.beeping_order_status)))
    return o.status === "confirmed" || o.beeping_sync_status === "released" ? "preparing" : "waiting_customer";
  if (o.status === "confirmed") return "ready_beeping";
  if (o.status === "needs_call") return "needs_call";
  if (["pending_send", "awaiting_reply", "reminder_sent", "awaiting_delivery_note", "needs_correction"].includes(o.status))
    return "waiting_customer";
  return "other";
}

type Filter = "all" | "attention" | "waiting" | "needs_call" | "correction" | "confirmed" | "ready_beeping" | "in_fulfillment" | "incident" | "closed";

/** `primary` = visible en la fila de estados; el resto vive en "Más filtros". */
const FILTERS: Array<{ key: Filter; label: string; critical?: boolean; primary?: boolean }> = [
  { key: "all", label: "Todos", primary: true },
  { key: "attention", label: "Necesita atención", critical: true, primary: true },
  { key: "waiting", label: "Esperando cliente", primary: true },
  { key: "needs_call", label: "Necesitan llamada", critical: true, primary: true },
  { key: "correction", label: "Corrección", primary: true },
  { key: "ready_beeping", label: "Listo Beeping", primary: true },
  { key: "in_fulfillment", label: "Preparando/Enviado" },
  { key: "incident", label: "Incidencias" },
  { key: "closed", label: "Cerrados" },
];

function matchesFilter(o: OrderItem, f: Filter): boolean {
  const ui = orderUiState(o);
  switch (f) {
    case "all":
      return o.status !== "ignored_old";
    case "attention":
      // Lo que pide una decisión: cancelación, duplicado, corrección,
      // llamada, error, incidencia o confirmado sin liberar.
      return (
        o.status !== "ignored_old" &&
        (o.cancellation_requested_at !== null ||
          o.possible_duplicate === 1 ||
          ["needs_correction", "needs_call", "error"].includes(o.status) ||
          ui === "incident" ||
          ui === "ready_beeping")
      );
    case "waiting":
      return ui === "waiting_customer";
    case "needs_call":
      return ui === "needs_call";
    case "correction":
      return o.status === "needs_correction";
    case "confirmed":
      return o.status === "confirmed";
    case "ready_beeping":
      return ui === "ready_beeping";
    case "in_fulfillment":
      return ui === "preparing" || ui === "shipped";
    case "incident":
      return ui === "incident" || o.status === "error";
    case "closed":
      return ui === "delivered" || ui === "cancelled";
  }
}

/** Búsqueda en cliente (§40.1): número, cliente, teléfono o producto. */
function matchesQuery(o: OrderItem, q: string): boolean {
  if (!q) return true;
  return [o.shopify_order_number, o.customer_name ?? "", o.phone, o.product_summary]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function fmtTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

function addressBlock(o: OrderItem): string {
  return [
    o.address_line1,
    o.address_line2,
    [o.postal_code, o.city].filter(Boolean).join(" "),
    [o.province, o.country].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

function fmtMoney(amount: string, currency: string): string {
  const value = parseFloat(String(amount).replace(",", "."));
  if (!Number.isFinite(value)) return `${amount} ${currency}`.trim();
  return formatEuro(value);
}

/** Resumen del canal WhatsApp para la columna (§21). */
function whatsappCell(o: OrderItem): { text: string; status: "ok" | "warn" | "muted" } {
  if (o.customer_replied_at) return { text: `respondió ${fmtTime(o.customer_replied_at)}`, status: "ok" };
  if (o.reminder_sent_at) return { text: `recordado ${fmtTime(o.reminder_sent_at)}`, status: "warn" };
  if (o.whatsapp_sent_at) return { text: `enviado ${fmtTime(o.whatsapp_sent_at)}`, status: "muted" };
  return { text: "sin enviar", status: "muted" };
}

/** Celda Beeping (§21): en qué punto del embudo de liberación está. */
function beepingCell(o: OrderItem): { text: string; status: "ok" | "warn" | "error" | "muted" } {
  if (o.beeping_sync_status === "released") return { text: "liberado", status: "ok" };
  if (o.beeping_sync_status === "releasing") return { text: "liberando…", status: "warn" };
  if (o.beeping_sync_status === "release_failed") return { text: "fallo al liberar", status: "error" };
  if (o.beeping_sync_status === "release_unknown") return { text: "AMBIGUO", status: "error" };
  if (o.beeping_order_status === 6) return { text: "retenido (por confirmar)", status: "warn" };
  if (o.status === "confirmed") return { text: "pendiente de enviar", status: "warn" };
  return { text: "—", status: "muted" };
}

const ENVIO_META: Record<string, string> = {
  unknown: "—",
  created: "creado",
  processing: "preparando",
  shipped: "enviado",
  in_transit: "en tránsito",
  out_for_delivery: "EN REPARTO",
  delivery_attempted: "intento fallido",
  at_pickup_point: "punto de recogida",
  delivered: "entregado",
  incident: "INCIDENCIA",
  returned: "devuelto",
  cancelled: "cancelado",
};

/** Celda de KPI dentro de la franja agrupada (§40.2). */
function KpiCell({ label, value, valueCls = "text-brand-text", span2Mobile = false }: { label: string; value: number; valueCls?: string; span2Mobile?: boolean }) {
  return (
    <div className={`bg-brand-surface px-5 py-4 ${span2Mobile ? "col-span-2 md:col-span-1" : ""}`}>
      <div className="text-[13px] font-medium text-brand-muted leading-snug">{label}</div>
      <div className={`mt-1.5 font-display text-[26px] font-semibold leading-none tabular-nums ${valueCls}`}>{value}</div>
    </div>
  );
}

/** Sección plana del drawer (§41): etiqueta + contenido, separadas por hairlines. */
function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-5 py-4">
      <div className="text-[12px] font-medium text-brand-muted mb-2">{title}</div>
      {children}
    </section>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden>
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

type ActionName = "confirm" | "call_now" | "needs_call" | "resend" | "notify_delay" | "cancel" | "authorize_pilot" | "revoke_pilot";

export default function OrdersPanel() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<"all" | "today" | "7d" | "30d">("all");
  const [sort, setSort] = useState<"recent" | "oldest" | "amount">("recent");
  const [detail, setDetail] = useState<OrderItem | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Entrada del drawer: se monta cerrado y desliza en el siguiente frame (150ms).
  const [drawerIn, setDrawerIn] = useState(false);
  // Confirmación propia (sustituye a window.confirm).
  const [confirmBox, setConfirmBox] = useState<{ title: string; body: string; run: () => void } | null>(null);
  // Estado Beeping de la ficha abierta (gate + corte + nota).
  const [beepingInfo, setBeepingInfo] = useState<BeepingGateInfo | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [cancelBox, setCancelBox] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/orders", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { counts: Counts; orders: OrderItem[] };
      setOrders(data.orders);
      setCounts(data.counts);
      setLoaded(true);
      setDetail((d) => (d ? (data.orders.find((o) => o.id === d.id) ?? d) : d));
    } catch {
      // silenciar: reintenta en el siguiente ciclo
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const drawerOpen = detail !== null;
  useEffect(() => {
    if (!drawerOpen) {
      setDrawerIn(false);
      return;
    }
    // Doble rAF: garantiza un frame pintado en posición cerrada antes de deslizar.
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setDrawerIn(true));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [drawerOpen]);

  // Al abrir la ficha: traer el gate de liberación y la nota de expedición.
  const loadBeepingInfo = useCallback(async (orderId: number) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/beeping`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean } & BeepingGateInfo;
      if (data.ok) {
        setBeepingInfo(data);
        setNoteDraft(data.dispatchNote ?? "");
      }
    } catch {
      /* la ficha funciona sin el gate; se reintenta al refrescar */
    }
  }, []);

  function openDetail(o: OrderItem) {
    setDetail(o);
    setActionError(null);
    setBeepingInfo(null);
    void loadBeepingInfo(o.id);
  }

  async function doAction(order: OrderItem, action: ActionName) {
    if (busy !== null) return; // anti doble-clic: una acción externa a la vez
    const confirmations: Record<string, { title: string; body: string }> = {
      confirm: {
        title: "Confirmar pedido",
        body: `¿Marcar el pedido #${order.shopify_order_number} como CONFIRMADO? Se añadirá el tag WA_CONFIRMED en Shopify (si las escrituras están habilitadas).`,
      },
      call_now: {
        title: "Llamada real",
        body: `Vas a realizar una LLAMADA REAL ahora mismo a ${order.customer_name ?? "—"} (+${order.phone}) por el pedido #${order.shopify_order_number}. Retell llamará únicamente a este pedido; no se activan llamadas automáticas.`,
      },
      cancel: {
        title: "Descartar del flujo",
        body: `¿Descartar el pedido #${order.shopify_order_number} de este flujo? (No cambia nada en Shopify.)`,
      },
      notify_delay: {
        title: "Aviso de retraso",
        body: `¿Enviar el aviso REAL de retraso al pedido #${order.shopify_order_number}?`,
      },
      authorize_pilot: {
        title: "Autorizar piloto",
        body: `Cliente ${order.customer_name ?? "—"} (+${order.phone}), pedido #${order.shopify_order_number}. Este cliente NO está en la lista de pruebas: al autorizar, ESTE pedido (y solo este) podrá recibir WhatsApps, recordatorios y el tag WA_CONFIRMED.`,
      },
      revoke_pilot: {
        title: "Retirar autorización",
        body: `¿Retirar la autorización de piloto del pedido #${order.shopify_order_number}? Dejará de recibir nada.`,
      },
      resend: {
        title: "Enviar WhatsApp real",
        body: `Vas a enviar un WhatsApp REAL a ${order.customer_name ?? "—"} (+${order.phone}) por el pedido #${order.shopify_order_number}. Si el sistema está en SAFE MODE o el teléfono no está autorizado, quedará bloqueado y solo se registrará en el log.`,
      },
    };
    const ejecutar = async () => {
      setBusy(order.id);
      setActionError(null);
      try {
        const res = await fetch(`/api/orders/${order.id}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          setActionError(data.error ?? `La acción falló (HTTP ${res.status}). Revisa el log.`);
        }
        await refresh();
        if (detail?.id === order.id) void loadBeepingInfo(order.id);
      } catch {
        setActionError("No se pudo contactar con el servidor. ¿Está arrancado npm run dev:all?");
      } finally {
        setBusy(null);
      }
    };
    const c = confirmations[action];
    if (c) setConfirmBox({ ...c, run: () => void ejecutar() });
    else void ejecutar();
  }

  async function releaseToBeeping(order: OrderItem) {
    if (busy !== null) return;
    setConfirmBox({
      title: "Enviar a Beeping",
      body: `El pedido #${order.shopify_order_number} pasará a preparación en el almacén (mark-to-send). Esta acción no se puede deshacer desde aquí.`,
      run: () => {
        void (async () => {
          setBusy(order.id);
          setActionError(null);
          try {
            const res = await fetch(`/api/orders/${order.id}/beeping`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "release" }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              result?: { outcome?: string; reasons?: string[]; error?: string };
            };
            if (!data.ok) {
              const r = data.result;
              setActionError(
                r?.outcome === "blocked" && r.reasons?.length
                  ? `No se puede liberar todavía: ${r.reasons.join(" · ")}`
                  : r?.outcome === "ambiguous"
                    ? "Beeping no respondió: la liberación queda en estado AMBIGUO. No se reintenta a ciegas — usa 'Resolver consultando' en Envíos."
                    : r?.outcome === "claim_lost"
                      ? "Ya hay una liberación en curso o completada para este pedido."
                      : (r?.error ?? "La liberación falló.")
              );
            }
            await refresh();
            void loadBeepingInfo(order.id);
          } catch {
            setActionError("No se pudo contactar con el servidor.");
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  }

  async function saveDispatchNote(order: OrderItem) {
    setNoteSaving(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/beeping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispatch_note", note: noteDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) setActionError(data.error ?? "No se pudo guardar la nota.");
      await refresh();
      void loadBeepingInfo(order.id);
    } catch {
      setActionError("No se pudo contactar con el servidor.");
    } finally {
      setNoteSaving(false);
    }
  }

  async function cancelInBeeping(order: OrderItem) {
    setBusy(order.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/beeping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel_in_beeping" }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { reason?: string; error?: string } };
      if (!data.ok) setActionError(data.result?.reason ?? data.result?.error ?? "No se pudo cancelar en Beeping.");
      await refresh();
      void loadBeepingInfo(order.id);
    } catch {
      setActionError("No se pudo contactar con el servidor.");
    } finally {
      setBusy(null);
      setCancelBox(false);
    }
  }

  const q = query.trim().toLowerCase();
  const nowS = Math.floor(Date.now() / 1000);
  const desde = range === "today" ? nowS - 86400 : range === "7d" ? nowS - 7 * 86400 : range === "30d" ? nowS - 30 * 86400 : 0;
  const fecha = (o: OrderItem) => o.ordered_at ?? o.created_at;
  const visible = orders
    .filter((o) => matchesFilter(o, filter) && matchesQuery(o, q) && fecha(o) >= desde)
    .sort((a, b) =>
      sort === "amount"
        ? (parseFloat(b.total_price) || 0) - (parseFloat(a.total_price) || 0)
        : sort === "oldest"
          ? fecha(a) - fecha(b)
          : fecha(b) - fecha(a)
    );
  const countBy = (f: Filter) => orders.filter((o) => matchesFilter(o, f)).length;

  // El CTA contextual de la ficha (§22): UNO grande, no ocho iguales.
  function primaryCta(o: OrderItem) {
    const ui = orderUiState(o);
    if (ui === "cancelled" || ui === "delivered") return null;
    if (o.status !== "confirmed" && !["cancelled", "ignored_old"].includes(o.status)) {
      return (
        <PrimaryButton busy={busy === o.id} onClick={() => doAction(o, "confirm")} className="w-full">
          Confirmar pedido
        </PrimaryButton>
      );
    }
    if (o.status === "confirmed" && ["not_released", "release_failed"].includes(o.beeping_sync_status)) {
      const gateOk = beepingInfo?.gate.ok ?? false;
      return (
        <PrimaryButton busy={busy === o.id} disabled={!gateOk} onClick={() => releaseToBeeping(o)} className="w-full">
          Enviar a Beeping
        </PrimaryButton>
      );
    }
    return null;
  }

  // ¿Hay algo que anclar abajo en el drawer? (mismo criterio que el bloque CTA v2)
  const detailAwaitsBeeping = detail !== null && detail.status === "confirmed" && ["not_released", "release_failed"].includes(detail.beeping_sync_status);
  const detailCta = detail ? primaryCta(detail) : null;
  const showCtaFooter = detail !== null && (detailCta !== null || detailAwaitsBeeping);

  const timeline: Array<[string, number | null]> = detail
    ? [
        ["WhatsApp enviado", detail.whatsapp_sent_at],
        ["Recordatorio", detail.reminder_sent_at],
        ["Respuesta del cliente", detail.customer_replied_at],
        ["Confirmado", detail.confirmed_at],
        ["Marcado para llamar", detail.needs_call_at],
      ]
    : [];

  return (
    <div className="h-full overflow-y-auto px-4 md:px-6 py-5 pb-8">
      <PageHeader title="Pedidos" description="Confirmar, corregir y liberar pedidos contra reembolso." />

      {/* KPIs — una sola superficie agrupada con divisiones finas (§40.2, §39) */}
      <Card className="overflow-hidden mt-6 mb-5">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-brand-border">
          <KpiCell label="Pedidos hoy" value={counts?.today ?? 0} />
          <KpiCell label="Confirmados hoy" value={counts?.confirmedToday ?? 0} valueCls="text-emerald-600" />
          <KpiCell label="Esperando respuesta" value={counts?.awaiting ?? 0} />
          <KpiCell label="Corrección" value={counts?.correction ?? 0} valueCls={(counts?.correction ?? 0) > 0 ? "text-amber-600" : "text-brand-text"} />
          <KpiCell
            label="Necesitan llamada"
            value={counts?.needsCall ?? 0}
            valueCls={(counts?.needsCall ?? 0) > 0 ? "text-amber-600" : "text-brand-text"}
            span2Mobile
          />
        </div>
      </Card>

      {/* Toolbar: búsqueda + fecha + orden; debajo, la fila compacta de estados */}
      <div className="space-y-3 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Pedido, cliente o teléfono" label="Buscar pedidos" className="w-full sm:w-[260px]" />
          <SelectInput
            value={range}
            onChange={(v) => setRange(v as typeof range)}
            label="Fecha"
            options={[
              { value: "all", label: "Cualquier fecha" },
              { value: "today", label: "Últimas 24 h" },
              { value: "7d", label: "Últimos 7 días" },
              { value: "30d", label: "Últimos 30 días" },
            ]}
          />
          <SelectInput
            value={sort}
            onChange={(v) => setSort(v as typeof sort)}
            label="Ordenar pedidos"
            options={[
              { value: "recent", label: "Más recientes" },
              { value: "oldest", label: "Más antiguos" },
              { value: "amount", label: "Mayor importe" },
            ]}
          />
          {(filter !== "all" || range !== "all" || sort !== "recent" || query.trim() !== "") && (
            <button type="button" onClick={() => { setFilter("all"); setRange("all"); setSort("recent"); setQuery(""); }} className="h-9 px-2 text-[13px] font-medium text-brand-muted hover:text-brand-text rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/20">
              Limpiar
            </button>
          )}
          <span className="ml-auto text-[13px] text-brand-tertiary tabular-nums">{visible.length} pedidos</span>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 no-scrollbar" role="group" aria-label="Filtrar por estado">
          {FILTERS.filter((f) => f.primary).map((f) => (
            <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)} count={f.key === "all" ? undefined : countBy(f.key)}>
              {f.label}
            </Chip>
          ))}
          <select
            value={FILTERS.find((f) => f.key === filter && !f.primary) ? filter : ""}
            onChange={(e) => e.target.value && setFilter(e.target.value as Filter)}
            aria-label="Más filtros"
            className={`h-8 w-auto max-w-[200px] rounded-lg border-0 bg-transparent pl-2 pr-7 text-[13px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/20 ${FILTERS.find((f) => f.key === filter && !f.primary) ? "text-brand-text" : "text-brand-muted"}`}
          >
            <option value="">Más filtros</option>
            {FILTERS.filter((f) => !f.primary).map((f) => (
              <option key={f.key} value={f.key}>{f.label} · {countBy(f.key)}</option>
            ))}
          </select>
        </div>
      </div>

      {!loaded ? (
        <SkeletonRows rows={6} />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={
              orders.length === 0
                ? "Aún no hay pedidos"
                : q
                  ? "Nada coincide con la búsqueda"
                  : "No hay pedidos en este estado"
            }
            hint={
              orders.length === 0
                ? "Cuando entre un pedido contra reembolso desde Shopify aparecerá aquí automáticamente."
                : q
                  ? "Prueba con el número de pedido, el nombre del cliente o el teléfono."
                  : "Todo lo demás está en otros filtros. Cambia de pestaña para verlo."
            }
          />
        </Card>
      ) : (
        <>
          {/* Tabla (md+) — filas ~52px, hairlines suaves, hover discreto (§40.4) */}
          <Card className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.06em] text-brand-tertiary bg-brand-surface-subtle border-b border-brand-border">
                    <th className="px-3 h-10 font-medium">Pedido</th>
                    <th className="px-3 h-10 font-medium">Cliente</th>
                    <th className="px-3 h-10 font-medium">Producto</th>
                    <th className="px-3 h-10 font-medium text-right">Importe</th>
                    <th className="px-3 h-10 font-medium">Estado</th>
                    <th className="px-3 h-10 font-medium">WhatsApp</th>
                    <th className="px-3 h-10 font-medium">Beeping</th>
                    <th className="px-3 h-10 font-medium">Envío</th>
                    <th className="px-3 h-10 font-medium text-right">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => {
                    const wa = whatsappCell(o);
                    const bp = beepingCell(o);
                    return (
                      <tr
                        key={o.id}
                        className="h-[60px] border-b border-brand-border last:border-0 hover:bg-brand-surface-subtle transition-colors duration-150 cursor-pointer"
                        onClick={() => openDetail(o)}
                      >
                        <td className="px-3 py-2.5 font-mono font-medium text-brand-text whitespace-nowrap tabular-nums">
                          <span className="text-brand-muted">#</span>
                          {o.shopify_order_number}
                          {o.possible_duplicate === 1 && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600 border border-amber-500/30 align-middle">
                              DUPLICADO?
                            </span>
                          )}
                          {o.cancellation_requested_at && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-600 border border-rose-500/30 align-middle">
                              PIDE CANCELAR
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 max-w-[150px]">
                          <div className="truncate leading-snug" title={o.customer_name ?? ""}>{o.customer_name ?? "—"}</div>
                          <div className="text-[11px] text-brand-muted truncate leading-snug">{o.city ?? ""}</div>
                        </td>
                        <td className="px-3 py-2.5 max-w-[240px] truncate text-brand-muted" title={o.product_summary.replace(/\n/g, " · ")}>
                          {o.product_summary.replace(/\n/g, " · ")}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right tabular-nums">{fmtMoney(o.total_price, o.currency)}</td>
                        <td className="px-3 py-2.5">
                          <OrderStateBadge state={orderUiState(o)} />
                          <div className="mt-0.5 text-[10px] text-brand-muted/80 whitespace-nowrap">{timeAgo(o.updated_at)}</div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <StatusDot status={wa.status} />
                            <span className="text-brand-muted">{wa.text}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <StatusDot status={bp.status} />
                            <span className="text-brand-muted">{bp.text}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-brand-muted">
                          {ENVIO_META[o.supplier_status_normalized] ?? o.supplier_status_normalized}
                          {o.tracking_number && <span className="block font-mono text-[10px]">{o.tracking_number}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                          {o.status !== "confirmed" && !["cancelled", "ignored_old"].includes(o.status) ? (
                            <button
                              disabled={busy === o.id}
                              onClick={() => doAction(o, "confirm")}
                              className="px-2.5 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 transition-colors duration-150 text-xs font-semibold disabled:opacity-50"
                            >
                              Confirmar
                            </button>
                          ) : o.status === "confirmed" && ["not_released", "release_failed"].includes(o.beeping_sync_status) ? (
                            <button
                              onClick={() => openDetail(o)}
                              className="px-2.5 py-1.5 rounded-lg border border-brand-border-strong text-brand-gold hover:bg-brand-surface-2 transition-colors duration-150 text-xs font-semibold"
                            >
                              Enviar a Beeping
                            </button>
                          ) : (
                            <button
                              onClick={() => openDetail(o)}
                              className="px-2.5 py-1.5 rounded-lg border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-muted/60 transition-colors duration-150 text-xs"
                            >
                              Ver
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Cards (móvil) — objetivos táctiles amplios (§40.6) */}
          <div className="md:hidden space-y-2.5">
            {visible.map((o) => {
              const bp = beepingCell(o);
              return (
                <Card key={o.id} className="active:bg-brand-surface-2 transition-colors duration-150">
                  <button type="button" className="w-full text-left px-4 py-3.5" onClick={() => openDetail(o)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-medium text-brand-text tabular-nums">
                        <span className="text-brand-muted">#</span>
                        {o.shopify_order_number}
                      </span>
                      <OrderStateBadge state={orderUiState(o)} />
                    </div>
                    <div className="mt-1.5 text-sm text-brand-text truncate">{o.customer_name ?? "—"} · {fmtMoney(o.total_price, o.currency)}</div>
                    <div className="mt-0.5 text-xs text-brand-muted truncate">{o.product_summary.replace(/\n/g, " · ")}</div>
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-brand-muted">
                      <span className="inline-flex items-center gap-1"><StatusDot status={bp.status} /> Beeping: {bp.text}</span>
                      <span className="text-brand-muted/80">{timeAgo(o.updated_at)}</span>
                      {o.cancellation_requested_at && <span className="text-rose-600 font-semibold">PIDE CANCELAR</span>}
                    </div>
                  </button>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* ══ FICHA DE PEDIDO (§41): drawer lateral en md+, bottom sheet en móvil ══ */}
      {detail && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal>
          <div
            className={`absolute inset-0 bg-black/50 transition-opacity duration-150 ${drawerIn ? "opacity-100" : "opacity-0"}`}
            onClick={() => setDetail(null)}
            aria-hidden
          />
          <div
            className={`absolute inset-x-0 bottom-0 max-h-[92vh] rounded-t-2xl border-t md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:h-full md:max-h-full md:w-[480px] md:max-w-full md:rounded-none md:border-t-0 md:border-l border-brand-border bg-brand-surface shadow-2xl flex flex-col transition-transform duration-150 ease-out ${
              drawerIn ? "translate-y-0 md:translate-x-0" : "translate-y-full md:translate-y-0 md:translate-x-full"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Cabecera del drawer */}
            <div className="shrink-0 px-5 pt-5 pb-4 border-b border-brand-border/60 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-display text-xl font-semibold text-brand-text">
                  Pedido <span className="text-brand-gold">#{detail.shopify_order_number}</span>
                </div>
                <div className="text-xs text-brand-muted mt-1 truncate">
                  Shopify {detail.shopify_order_id} · creado {fmtTime(detail.created_at)}
                  {detail.shopify_tagged === 1 && <span className="ml-2 text-emerald-600">· WA_CONFIRMED ✓</span>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <OrderStateBadge state={orderUiState(detail)} />
                  {detail.possible_duplicate === 1 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 border border-amber-500/30">POSIBLE DUPLICADO</span>
                  )}
                  {detail.pilot_authorized === 1 && (
                    <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-brand-surface-2 text-brand-muted">Piloto autorizado</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setDetail(null)}
                aria-label="Cerrar"
                className="shrink-0 p-2 rounded-lg border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-muted/60 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30"
              >
                <CloseIcon />
              </button>
            </div>

            {/* Cuerpo con scroll: avisos + secciones planas con hairlines */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {/* Cliente pide cancelar → decisión humana, nunca botón rojo directo */}
              {detail.cancellation_requested_at && (
                <div className="mx-5 mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-rose-600">
                    <strong>El cliente solicita cancelar</strong> ({fmtTime(detail.cancellation_requested_at)}). Tú decides.
                  </div>
                  <GhostButton onClick={() => setCancelBox(true)}>Gestionar cancelación</GhostButton>
                </div>
              )}

              {detail.beeping_sync_status === "released" && (
                <div className="mx-5 mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5 text-sm text-emerald-600">
                  Liberado a Beeping {detail.beeping_released_at ? timeAgo(detail.beeping_released_at) : ""} — el almacén ya lo está preparando.
                </div>
              )}
              {detail.beeping_sync_status === "release_unknown" && (
                <div className="mx-5 mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3.5 text-sm text-red-600">
                  Liberación en estado <strong>AMBIGUO</strong>: Beeping no respondió. No se reintenta a ciegas — resuélvelo desde Envíos ("Resolver consultando").
                </div>
              )}

              {actionError && (
                <div className="mx-5 mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600">{actionError}</div>
              )}

              <div className="divide-y divide-brand-border/50">
                {/* ── CLIENTE ── */}
                <DrawerSection title="Cliente">
                  <div className="text-sm text-brand-text">{detail.customer_name ?? "—"}</div>
                  <div className="font-mono text-xs text-brand-muted mt-0.5">{detail.phone ? `+${detail.phone}` : "sin teléfono"}</div>
                  {detail.email && <div className="text-xs text-brand-muted">{detail.email}</div>}
                  <div className="text-xs text-brand-muted mt-2 whitespace-pre-line leading-relaxed">{addressBlock(detail) || "—"}</div>
                  {detail.proposed_address && (
                    <div className="mt-2.5 rounded-lg border border-sky-500/40 bg-sky-500/5 p-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-sky-600">Dirección propuesta por el cliente</div>
                      <div className="text-xs whitespace-pre-line mt-1">{detail.proposed_address}</div>
                      <div className="text-[10px] text-brand-muted mt-1">No se aplica sola: actualízala en Shopify y confirma.</div>
                    </div>
                  )}
                </DrawerSection>

                {/* ── PEDIDO ── */}
                <DrawerSection title="Pedido">
                  <div className="text-sm whitespace-pre-line text-brand-text leading-relaxed">{detail.product_summary}</div>
                  <div className="font-semibold mt-1.5 text-brand-text tabular-nums">
                    {fmtMoney(detail.total_price, detail.currency)} <span className="text-xs text-brand-muted font-normal">contra reembolso</span>
                  </div>
                  {detail.delivery_note && (
                    <div className="mt-2.5 rounded-lg border border-brand-border bg-brand-surface-subtle p-2.5">
                      <div className="text-[12px] font-medium text-brand-muted">Nota para el repartidor (cliente)</div>
                      <div className="text-xs whitespace-pre-line mt-1">{detail.delivery_note}</div>
                    </div>
                  )}
                  {detail.customer_note && (
                    <div className="text-xs text-brand-muted mt-2 whitespace-pre-line">{detail.customer_note}</div>
                  )}
                </DrawerSection>

                {/* ── COMUNICACIÓN: timeline compacto + acciones de canal ── */}
                <DrawerSection title="Comunicación">
                  <div className="space-y-1.5">
                    {timeline.map(([label, ts]) => (
                      <div key={label} className="flex items-center gap-2.5 text-xs">
                        <StatusDot status={ts ? "ok" : "muted"} />
                        <span className="flex-1 text-brand-muted">{label}</span>
                        <span className={`tabular-nums ${ts ? "text-brand-text" : "text-brand-muted/60"}`}>{fmtTime(ts)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {!["confirmed", "cancelled", "ignored_old"].includes(detail.status) && detail.phone && (
                      <>
                        <GhostButton disabled={busy === detail.id} onClick={() => doAction(detail, "resend")} className="!px-2.5 !py-1.5 text-xs">
                          Reenviar WhatsApp
                        </GhostButton>
                        <GhostButton disabled={busy === detail.id} onClick={() => doAction(detail, "call_now")} className="!px-2.5 !py-1.5 text-xs">
                          Llamar ahora
                        </GhostButton>
                      </>
                    )}
                    {detail.status === "confirmed" &&
                      detail.phone &&
                      ((detail.product_summary ?? "").toLowerCase().includes("ultras") ||
                        (detail.product_summary ?? "").toLowerCase().includes("gafa")) && (
                        <GhostButton disabled={busy === detail.id} onClick={() => doAction(detail, "notify_delay")} className="!px-2.5 !py-1.5 text-xs">
                          Avisar retraso
                        </GhostButton>
                      )}
                  </div>
                </DrawerSection>

                {/* ── FULFILLMENT ── */}
                <DrawerSection title="Fulfillment">
                  <div className="text-xs text-brand-muted space-y-1">
                    <div>
                      Beeping:{" "}
                      <span className="text-brand-text">
                        {beepingCell(detail).text}
                        {detail.beeping_order_status !== null && ` (status ${detail.beeping_order_status})`}
                      </span>
                    </div>
                    {detail.supplier_platform && detail.supplier_platform !== "unknown" && (
                      <div>Proveedor: <span className="text-brand-text">{detail.supplier_platform}</span> · {detail.supplier_sync_status}</div>
                    )}
                    <div>
                      Envío: <span className="text-brand-text">{ENVIO_META[detail.supplier_status_normalized] ?? detail.supplier_status_normalized}</span>
                    </div>
                    {detail.tracking_number && (
                      <div>
                        Tracking: {detail.carrier ? `${detail.carrier} · ` : ""}
                        {detail.tracking_url ? (
                          <a href={detail.tracking_url} target="_blank" rel="noreferrer" className="underline text-sky-600">
                            {detail.tracking_number}
                          </a>
                        ) : (
                          <span className="font-mono">{detail.tracking_number}</span>
                        )}
                      </div>
                    )}
                    {detail.supplier_last_error && <div className="text-amber-600">{detail.supplier_last_error}</div>}
                  </div>

                  {/* Nota de expedición (§12): INTERNA hasta tener contrato de Beeping */}
                  <div className="mt-3">
                    <div className="flex items-center gap-2 text-[12px] font-medium text-brand-muted">
                      Nota de expedición
                      <span className="px-1.5 py-0.5 rounded bg-brand-surface-2 border border-brand-border text-[9px] normal-case tracking-normal">
                        Nota interna — todavía no se envía a Beeping
                      </span>
                    </div>
                    {["not_released", "release_failed"].includes(detail.beeping_sync_status) ? (
                      <div className="mt-1.5 flex gap-2">
                        <input
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          placeholder='p.ej. "Llamar antes de entregar"'
                          maxLength={500}
                          className="flex-1 rounded-lg border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-xs text-brand-text placeholder:text-brand-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30"
                        />
                        <GhostButton disabled={noteSaving || noteDraft === (detail.dispatch_note ?? "")} onClick={() => void saveDispatchNote(detail)} className="!px-2.5 !py-1.5 text-xs">
                          {noteSaving ? "Guardando…" : "Guardar"}
                        </GhostButton>
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-brand-text">{detail.dispatch_note || "—"} <span className="text-brand-muted">(congelada al liberar)</span></div>
                    )}
                  </div>
                </DrawerSection>
              </div>

              {detail.last_error && (
                <div className="mx-5 mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600">{detail.last_error}</div>
              )}
              {detail.deferred_until && detail.status === "pending_send" && (
                <div className="mx-5 mb-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-600">
                  En espera por horario: el mensaje saldrá hacia las {new Date(detail.deferred_until * 1000).toLocaleString("es-ES")}.
                </div>
              )}

              {/* Acciones secundarias, deliberadamente pequeñas — encima del CTA fijo */}
              <div className="flex flex-wrap gap-2 justify-end border-t border-brand-border/50 px-5 py-3">
                {!["cancelled", "ignored_old"].includes(detail.status) &&
                  (detail.pilot_authorized === 1 ? (
                    <GhostButton disabled={busy === detail.id} onClick={() => doAction(detail, "revoke_pilot")} className="!px-2.5 !py-1.5 text-xs">
                      Retirar autorización piloto
                    </GhostButton>
                  ) : (
                    <GhostButton disabled={busy === detail.id} onClick={() => doAction(detail, "authorize_pilot")} className="!px-2.5 !py-1.5 text-xs">
                      Autorizar piloto
                    </GhostButton>
                  ))}
                {!["confirmed", "cancelled", "ignored_old"].includes(detail.status) && (
                  <GhostButton disabled={busy === detail.id} onClick={() => doAction(detail, "cancel")} className="!px-2.5 !py-1.5 text-xs">
                    Descartar del flujo
                  </GhostButton>
                )}
              </div>
            </div>

            {/* CTA CONTEXTUAL fijo al pie del drawer (§41) */}
            {showCtaFooter && (
              <div className="shrink-0 sticky bottom-0 bg-brand-surface border-t border-brand-border p-4">
                {detailAwaitsBeeping && (
                  <>
                    <div className="flex items-center gap-2 text-sm text-brand-text mb-1">
                      <StatusDot status="ok" />
                      Confirmado · <strong>Pendiente de enviar a Beeping</strong>
                    </div>
                    {beepingInfo && (
                      <div className="text-[11px] text-brand-muted mb-2">
                        {beepingInfo.cutoff.message}
                      </div>
                    )}
                    {beepingInfo && !beepingInfo.gate.ok && (
                      <ul className="mb-3 space-y-1">
                        {beepingInfo.gate.reasons.map((r) => (
                          <li key={r} className="text-xs text-amber-600 flex gap-1.5">
                            <span aria-hidden>·</span> {r}
                          </li>
                        ))}
                      </ul>
                    )}
                    {detail.beeping_last_error && detail.beeping_sync_status === "release_failed" && (
                      <div className="text-xs text-red-600 mb-2">Último intento: {detail.beeping_last_error}</div>
                    )}
                  </>
                )}
                {detailCta}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirmación propia (sin window.confirm) */}
      <ModalShell open={confirmBox !== null} onClose={() => setConfirmBox(null)} title={confirmBox?.title}>
        <p className="text-sm text-brand-muted whitespace-pre-line mb-4">{confirmBox?.body}</p>
        <div className="flex justify-end gap-2">
          <GhostButton onClick={() => setConfirmBox(null)}>Cancelar</GhostButton>
          <PrimaryButton
            onClick={() => {
              confirmBox?.run();
              setConfirmBox(null);
            }}
          >
            Continuar
          </PrimaryButton>
        </div>
      </ModalShell>

      {/* Gestionar cancelación (§14): decisión humana con opciones claras */}
      <ModalShell open={cancelBox && detail !== null} onClose={() => setCancelBox(false)} title="Gestionar cancelación">
        <p className="text-sm text-brand-muted mb-4">
          El cliente del pedido <strong className="text-brand-text">#{detail?.shopify_order_number}</strong> ha pedido cancelar. Elige qué hacer — nada se cancela solo:
        </p>
        <div className="space-y-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => detail && void cancelInBeeping(detail)}
            className="w-full text-left rounded-xl border border-red-500/40 bg-red-500/5 hover:bg-red-500/10 transition-colors duration-150 p-3 text-sm disabled:opacity-50"
          >
            <div className="font-semibold text-red-600">Cancelar en Beeping</div>
            <div className="text-xs text-brand-muted mt-0.5">
              Solo posible si aún no está preparado (Pending / Pending Stock / To be confirmed). Se consulta el estado antes de escribir. La cancelación en Shopify se hace aparte, en Shopify.
            </div>
          </button>
          <button
            type="button"
            onClick={() => {
              setCancelBox(false);
              window.location.hash = "#acciones";
            }}
            className="w-full text-left rounded-xl border border-brand-border hover:bg-brand-surface-2 transition-colors duration-150 p-3 text-sm"
          >
            <div className="font-semibold text-brand-text">Resolver en Acciones</div>
            <div className="text-xs text-brand-muted mt-0.5">Hablar con el cliente primero, o marcar la solicitud como gestionada sin cancelar.</div>
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <GhostButton onClick={() => setCancelBox(false)}>Cerrar</GhostButton>
        </div>
      </ModalShell>
    </div>
  );
}
