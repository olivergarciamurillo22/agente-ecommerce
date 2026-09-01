"use client";

// ============================================================
// PEDIDOS v2 (§21-22) — la mesa de trabajo de Pedro.
//
// Un pedido tiene DOS decisiones distintas que aquí no se confunden:
//   1. ¿El CLIENTE lo ha confirmado?  (status = confirmed)
//   2. ¿Está LIBERADO a Beeping?      (beeping_sync_status = released)
// La ficha enseña un CTA contextual grande: primero "Confirmar pedido",
// después "Enviar a Beeping" (con el gate explicando qué falta si algo
// bloquea). Nunca ocho botones del mismo nivel.
//
// Conserva TODAS las acciones existentes (incluida "Avisar retraso" del
// recovery del NAS, con su misma condición ultras/gafa), sustituyendo
// window.confirm/alert por modales propios.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  Chip,
  EmptyState,
  formatEuro,
  GhostButton,
  ModalShell,
  OrderStateBadge,
  PrimaryButton,
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

type Filter = "all" | "waiting" | "needs_call" | "correction" | "confirmed" | "ready_beeping" | "in_fulfillment" | "incident" | "closed";

const FILTERS: Array<{ key: Filter; label: string; critical?: boolean }> = [
  { key: "all", label: "Todos" },
  { key: "waiting", label: "Esperando cliente" },
  { key: "needs_call", label: "Necesitan llamada", critical: true },
  { key: "correction", label: "Corrección" },
  { key: "ready_beeping", label: "Listo Beeping" },
  { key: "in_fulfillment", label: "Preparando/Enviado" },
  { key: "incident", label: "Incidencias" },
  { key: "closed", label: "Cerrados" },
];

function matchesFilter(o: OrderItem, f: Filter): boolean {
  const ui = orderUiState(o);
  switch (f) {
    case "all":
      return o.status !== "ignored_old";
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

function KpiCard({ label, value, tone }: { label: string; value: number; tone?: "gold" | "green" | "red" | "sky" }) {
  const valueCls =
    tone === "red" && value > 0 ? "text-red-300" : tone === "green" ? "text-emerald-300" : tone === "sky" ? "text-sky-300" : "text-brand-text";
  return (
    <Card className={`px-4 py-3 ${tone === "red" && value > 0 ? "border-red-500/50 bg-red-500/10" : ""}`}>
      <div className="text-[11px] uppercase tracking-wider text-brand-muted">{label}</div>
      <div className={`font-display text-3xl font-bold mt-1 ${valueCls}`}>{value}</div>
    </Card>
  );
}

type ActionName = "confirm" | "call_now" | "needs_call" | "resend" | "notify_delay" | "cancel" | "authorize_pilot" | "revoke_pilot";

export default function OrdersPanel() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<OrderItem | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

  const visible = orders.filter((o) => matchesFilter(o, filter));
  const countBy = (f: Filter) => orders.filter((o) => matchesFilter(o, f)).length;

  // El CTA contextual de la ficha (§22): UNO grande, no ocho iguales.
  function primaryCta(o: OrderItem) {
    const ui = orderUiState(o);
    if (ui === "cancelled" || ui === "delivered") return null;
    if (o.status !== "confirmed" && !["cancelled", "ignored_old"].includes(o.status)) {
      return (
        <PrimaryButton busy={busy === o.id} onClick={() => doAction(o, "confirm")} className="w-full sm:w-auto">
          Confirmar pedido
        </PrimaryButton>
      );
    }
    if (o.status === "confirmed" && ["not_released", "release_failed"].includes(o.beeping_sync_status)) {
      const gateOk = beepingInfo?.gate.ok ?? false;
      return (
        <PrimaryButton busy={busy === o.id} disabled={!gateOk} onClick={() => releaseToBeeping(o)} className="w-full sm:w-auto">
          Enviar a Beeping
        </PrimaryButton>
      );
    }
    return null;
  }

  return (
    <div className="h-full overflow-y-auto px-4 md:px-6 py-5 pb-24 md:pb-8">
      {/* KPIs — lo que Pedro necesita ver en 5 segundos */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <KpiCard label="Pedidos hoy" value={counts?.today ?? 0} tone="gold" />
        <KpiCard label="Confirmados hoy" value={counts?.confirmedToday ?? 0} tone="green" />
        <KpiCard label="Esperando respuesta" value={counts?.awaiting ?? 0} />
        <KpiCard label="Corrección" value={counts?.correction ?? 0} tone="sky" />
        <KpiCard label="Necesitan llamada" value={counts?.needsCall ?? 0} tone="red" />
      </div>

      {/* Filtros como chips (§21) */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => (
          <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)} count={f.key === "all" ? undefined : countBy(f.key)}>
            {f.label}
          </Chip>
        ))}
      </div>

      {!loaded ? (
        <SkeletonRows rows={6} />
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            title={orders.length === 0 ? "Sin pedidos todavía" : "Ningún pedido en este filtro"}
            hint={orders.length === 0 ? "Cuando llegue un pedido contra reembolso de Shopify aparecerá aquí." : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Tabla (md+) */}
          <Card className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
                    <th className="px-3 py-3">Pedido</th>
                    <th className="px-3 py-3">Cliente</th>
                    <th className="px-3 py-3">Producto</th>
                    <th className="px-3 py-3">Importe</th>
                    <th className="px-3 py-3">Estado</th>
                    <th className="px-3 py-3">WhatsApp</th>
                    <th className="px-3 py-3">Beeping</th>
                    <th className="px-3 py-3">Envío</th>
                    <th className="px-3 py-3 text-right">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => {
                    const wa = whatsappCell(o);
                    const bp = beepingCell(o);
                    return (
                      <tr
                        key={o.id}
                        className="border-b border-brand-border/50 last:border-0 hover:bg-brand-surface-2/60 cursor-pointer"
                        onClick={() => openDetail(o)}
                      >
                        <td className="px-3 py-3 font-mono font-semibold text-brand-gold whitespace-nowrap">
                          #{o.shopify_order_number}
                          {o.possible_duplicate === 1 && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 align-middle">
                              DUPLICADO?
                            </span>
                          )}
                          {o.cancellation_requested_at && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 align-middle">
                              PIDE CANCELAR
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 max-w-[150px]">
                          <div className="truncate" title={o.customer_name ?? ""}>{o.customer_name ?? "—"}</div>
                          <div className="text-[11px] text-brand-muted truncate">{o.city ?? ""}</div>
                        </td>
                        <td className="px-3 py-3 max-w-[180px] truncate text-brand-muted" title={o.product_summary.replace(/\n/g, " · ")}>
                          {o.product_summary.replace(/\n/g, " · ")}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">{fmtMoney(o.total_price, o.currency)}</td>
                        <td className="px-3 py-3">
                          <OrderStateBadge state={orderUiState(o)} />
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <StatusDot status={wa.status} />
                            <span className="text-brand-muted">{wa.text}</span>
                          </span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <StatusDot status={bp.status} />
                            <span className="text-brand-muted">{bp.text}</span>
                          </span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap text-xs text-brand-muted">
                          {ENVIO_META[o.supplier_status_normalized] ?? o.supplier_status_normalized}
                          {o.tracking_number && <span className="block font-mono text-[10px]">{o.tracking_number}</span>}
                        </td>
                        <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          {o.status !== "confirmed" && !["cancelled", "ignored_old"].includes(o.status) ? (
                            <button
                              disabled={busy === o.id}
                              onClick={() => doAction(o, "confirm")}
                              className="px-2.5 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-xs font-semibold disabled:opacity-50"
                            >
                              Confirmar
                            </button>
                          ) : o.status === "confirmed" && ["not_released", "release_failed"].includes(o.beeping_sync_status) ? (
                            <button
                              onClick={() => openDetail(o)}
                              className="px-2.5 py-1.5 rounded-lg border border-brand-gold/50 text-brand-gold hover:bg-brand-gold/10 text-xs font-semibold"
                            >
                              Enviar a Beeping
                            </button>
                          ) : (
                            <button
                              onClick={() => openDetail(o)}
                              className="px-2.5 py-1.5 rounded-lg border border-brand-border text-brand-muted hover:text-brand-text text-xs"
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

          {/* Cards (móvil) */}
          <div className="md:hidden space-y-2.5">
            {visible.map((o) => {
              const bp = beepingCell(o);
              return (
                <Card key={o.id} className="px-4 py-3 active:bg-brand-surface-2" >
                  <button type="button" className="w-full text-left" onClick={() => openDetail(o)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-brand-gold">#{o.shopify_order_number}</span>
                      <OrderStateBadge state={orderUiState(o)} />
                    </div>
                    <div className="mt-1 text-sm text-brand-text truncate">{o.customer_name ?? "—"} · {fmtMoney(o.total_price, o.currency)}</div>
                    <div className="text-xs text-brand-muted truncate">{o.product_summary.replace(/\n/g, " · ")}</div>
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-brand-muted">
                      <span className="inline-flex items-center gap-1"><StatusDot status={bp.status} /> Beeping: {bp.text}</span>
                      {o.cancellation_requested_at && <span className="text-rose-300 font-semibold">PIDE CANCELAR</span>}
                    </div>
                  </button>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* ══ FICHA DE PEDIDO (§22): 4 bloques + CTA contextual ══ */}
      {detail && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-6" onClick={() => setDetail(null)}>
          <div
            className="w-full sm:max-w-3xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Cabecera */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="font-display text-xl font-bold text-brand-text">
                  Pedido <span className="text-brand-gold">#{detail.shopify_order_number}</span>
                </div>
                <div className="text-xs text-brand-muted mt-1">
                  Shopify {detail.shopify_order_id} · creado {fmtTime(detail.created_at)}
                  {detail.shopify_tagged === 1 && <span className="ml-2 text-emerald-300">· WA_CONFIRMED ✓</span>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <OrderStateBadge state={orderUiState(detail)} />
                  {detail.possible_duplicate === 1 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">POSIBLE DUPLICADO</span>
                  )}
                  {detail.pilot_authorized === 1 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-500/15 text-violet-300 border border-violet-500/30">PILOTO AUTORIZADO</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setDetail(null)}
                aria-label="Cerrar"
                className="px-2.5 py-1.5 rounded-lg border border-brand-border text-brand-muted hover:text-brand-text text-sm"
              >
                ✕
              </button>
            </div>

            {/* Cliente pide cancelar → decisión humana, nunca botón rojo directo */}
            {detail.cancellation_requested_at && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-rose-200">
                  <strong>El cliente solicita cancelar</strong> ({fmtTime(detail.cancellation_requested_at)}). Tú decides.
                </div>
                <GhostButton onClick={() => setCancelBox(true)}>Gestionar cancelación</GhostButton>
              </div>
            )}

            {/* CTA CONTEXTUAL GRANDE */}
            {(primaryCta(detail) !== null || (detail.status === "confirmed" && ["not_released", "release_failed"].includes(detail.beeping_sync_status))) && (
              <div className="rounded-2xl border border-brand-gold/30 bg-brand-gold/5 p-4 mb-4">
                {detail.status === "confirmed" && ["not_released", "release_failed"].includes(detail.beeping_sync_status) ? (
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
                          <li key={r} className="text-xs text-amber-300 flex gap-1.5">
                            <span aria-hidden>·</span> {r}
                          </li>
                        ))}
                      </ul>
                    )}
                    {detail.beeping_last_error && detail.beeping_sync_status === "release_failed" && (
                      <div className="text-xs text-red-300 mb-2">Último intento: {detail.beeping_last_error}</div>
                    )}
                  </>
                ) : null}
                <div className="flex flex-wrap gap-2">{primaryCta(detail)}</div>
              </div>
            )}

            {detail.beeping_sync_status === "released" && (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3.5 mb-4 text-sm text-emerald-200">
                Liberado a Beeping {detail.beeping_released_at ? timeAgo(detail.beeping_released_at) : ""} — el almacén ya lo está preparando.
              </div>
            )}
            {detail.beeping_sync_status === "release_unknown" && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3.5 mb-4 text-sm text-red-200">
                Liberación en estado <strong>AMBIGUO</strong>: Beeping no respondió. No se reintenta a ciegas — resuélvelo desde Envíos ("Resolver consultando").
              </div>
            )}

            {actionError && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 mb-4 text-sm text-red-300">{actionError}</div>
            )}

            {/* ── Bloques CLIENTE / PEDIDO ── */}
            <div className="grid sm:grid-cols-2 gap-3 mb-3">
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3.5">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">Cliente</div>
                <div className="text-sm text-brand-text">{detail.customer_name ?? "—"}</div>
                <div className="font-mono text-xs text-brand-muted mt-0.5">{detail.phone ? `+${detail.phone}` : "sin teléfono"}</div>
                {detail.email && <div className="text-xs text-brand-muted">{detail.email}</div>}
                <div className="text-xs text-brand-muted mt-2 whitespace-pre-line">{addressBlock(detail) || "—"}</div>
                {detail.proposed_address && (
                  <div className="mt-2 rounded-lg border border-sky-500/40 bg-sky-500/5 p-2">
                    <div className="text-[10px] uppercase tracking-wider text-sky-300">Dirección propuesta por el cliente</div>
                    <div className="text-xs whitespace-pre-line mt-1">{detail.proposed_address}</div>
                    <div className="text-[10px] text-brand-muted mt-1">No se aplica sola: actualízala en Shopify y confirma.</div>
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3.5">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">Pedido</div>
                <div className="text-sm whitespace-pre-line text-brand-text">{detail.product_summary}</div>
                <div className="font-semibold mt-1.5 text-brand-text">{fmtMoney(detail.total_price, detail.currency)} <span className="text-xs text-brand-muted font-normal">contra reembolso</span></div>
                {detail.delivery_note && (
                  <div className="mt-2 rounded-lg border border-violet-500/40 bg-violet-500/5 p-2">
                    <div className="text-[10px] uppercase tracking-wider text-violet-300">Nota para el repartidor (cliente)</div>
                    <div className="text-xs whitespace-pre-line mt-1">{detail.delivery_note}</div>
                  </div>
                )}
                {detail.customer_note && (
                  <div className="text-xs text-brand-muted mt-2 whitespace-pre-line">{detail.customer_note}</div>
                )}
              </div>
            </div>

            {/* ── Bloques COMUNICACIÓN / FULFILLMENT ── */}
            <div className="grid sm:grid-cols-2 gap-3 mb-4">
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3.5">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">Comunicación</div>
                <div className="text-xs text-brand-muted space-y-1">
                  <div>WhatsApp enviado: {fmtTime(detail.whatsapp_sent_at)}</div>
                  <div>Recordatorio: {fmtTime(detail.reminder_sent_at)}</div>
                  <div>Respuesta del cliente: {fmtTime(detail.customer_replied_at)}</div>
                  <div>Confirmado: {fmtTime(detail.confirmed_at)}</div>
                  <div>Marcado para llamar: {fmtTime(detail.needs_call_at)}</div>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
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
              </div>
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3.5">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">Fulfillment</div>
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
                        <a href={detail.tracking_url} target="_blank" rel="noreferrer" className="underline text-sky-300">
                          {detail.tracking_number}
                        </a>
                      ) : (
                        <span className="font-mono">{detail.tracking_number}</span>
                      )}
                    </div>
                  )}
                  {detail.supplier_last_error && <div className="text-amber-300">{detail.supplier_last_error}</div>}
                </div>

                {/* Nota de expedición (§12): INTERNA hasta tener contrato de Beeping */}
                <div className="mt-2.5">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-brand-muted">
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
                        className="flex-1 rounded-lg border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-xs text-brand-text placeholder:text-brand-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
                      />
                      <GhostButton disabled={noteSaving || noteDraft === (detail.dispatch_note ?? "")} onClick={() => void saveDispatchNote(detail)} className="!px-2.5 !py-1.5 text-xs">
                        {noteSaving ? "Guardando…" : "Guardar"}
                      </GhostButton>
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-brand-text">{detail.dispatch_note || "—"} <span className="text-brand-muted">(congelada al liberar)</span></div>
                  )}
                </div>
              </div>
            </div>

            {detail.last_error && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 mb-4 text-sm text-red-300">{detail.last_error}</div>
            )}
            {detail.deferred_until && detail.status === "pending_send" && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 mb-4 text-sm text-amber-200">
                En espera por horario: el mensaje saldrá hacia las {new Date(detail.deferred_until * 1000).toLocaleString("es-ES")}.
              </div>
            )}

            {/* Acciones secundarias, deliberadamente pequeñas */}
            <div className="flex flex-wrap gap-2 justify-end border-t border-brand-border pt-3">
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
            className="w-full text-left rounded-xl border border-red-500/40 bg-red-500/5 hover:bg-red-500/10 p-3 text-sm disabled:opacity-50"
          >
            <div className="font-semibold text-red-300">Cancelar en Beeping</div>
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
            className="w-full text-left rounded-xl border border-brand-border hover:bg-brand-surface-2 p-3 text-sm"
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
