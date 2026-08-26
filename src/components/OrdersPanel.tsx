"use client";

// Panel principal del MVP de Pedro: pedidos COD y su estado de confirmación.
// Objetivo: entender en 5 segundos qué está confirmado y A QUIÉN HAY QUE LLAMAR.

import { useCallback, useEffect, useState } from "react";

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
}

interface Counts {
  today: number;
  confirmedToday: number;
  awaiting: number;
  correction: number;
  needsCall: number;
  error: number;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending_send: { label: "EN COLA", cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
  awaiting_reply: { label: "ESPERANDO RESPUESTA", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  reminder_sent: { label: "RECORDATORIO ENVIADO", cls: "bg-amber-500/15 text-amber-200 border-amber-500/40" },
  awaiting_delivery_note: { label: "NOTA PENDIENTE", cls: "bg-violet-500/15 text-violet-300 border-violet-500/30" },
  confirmed: { label: "CONFIRMADO", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  needs_correction: { label: "CORRECCIÓN", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  needs_call: { label: "LLAMAR", cls: "bg-red-500/20 text-red-300 border-red-500/40" },
  cancelled: { label: "CANCELADO", cls: "bg-zinc-600/15 text-zinc-400 border-zinc-600/30" },
  ignored_old: { label: "ANTIGUO (SIN ACCIÓN)", cls: "bg-zinc-600/15 text-zinc-400 border-zinc-600/30" },
  error: { label: "ERROR", cls: "bg-red-500/10 text-red-400 border-red-500/50" },
};

type Filter = "all" | "needs_call" | "awaiting" | "needs_correction" | "confirmed" | "problem";

const FILTERS: Array<{ key: Filter; label: string; critical?: boolean }> = [
  { key: "all", label: "Todos" },
  { key: "needs_call", label: "📞 Necesitan llamada", critical: true },
  { key: "awaiting", label: "Esperando" },
  { key: "needs_correction", label: "Corrección" },
  { key: "confirmed", label: "Confirmados" },
  { key: "problem", label: "Errores" },
];

function matchesFilter(o: OrderItem, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "needs_call":
      return o.status === "needs_call";
    case "awaiting":
      return ["pending_send", "awaiting_reply", "reminder_sent", "awaiting_delivery_note"].includes(o.status);
    case "needs_correction":
      return o.status === "needs_correction";
    case "confirmed":
      return o.status === "confirmed";
    case "problem":
      return o.status === "error" || o.status === "cancelled" || o.status === "ignored_old";
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

function addressOneLine(o: OrderItem): string {
  return [o.address_line1, o.address_line2, [o.postal_code, o.city].filter(Boolean).join(" "), o.province]
    .filter(Boolean)
    .join(", ");
}

/** "39,97 €" con la moneda del pedido (duplicado a propósito: messages.ts es
 *  código de servidor y arrastraría better-sqlite3 al bundle del navegador). */
function fmtMoney(amount: string, currency: string): string {
  const value = parseFloat(String(amount).replace(",", "."));
  const code = (currency || "EUR").trim().toUpperCase();
  if (!Number.isFinite(value)) return `${amount} ${code}`.trim();
  try {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

// Estado de la sincronización con el proveedor (Dropi/Dropea).
// Hoy todo es simulación: no hay ninguna acción de escritura en el panel.
/** Estado del ENVÍO (distinto del estado de sincronización). */
const ENVIO_META: Record<string, string> = {
  unknown: "sin información",
  created: "creado",
  processing: "preparando",
  shipped: "enviado",
  in_transit: "en tránsito",
  out_for_delivery: "EN REPARTO",
  delivered: "entregado",
  incident: "INCIDENCIA",
  returned: "devuelto",
  cancelled: "cancelado",
};

const SUPPLIER_META: Record<string, { label: string; cls: string }> = {
  not_ready: { label: "—", cls: "text-brand-muted" },
  manual_review: { label: "REVISIÓN MANUAL", cls: "text-amber-300" },
  blocked_address: { label: "BLOQUEADO DIRECCIÓN", cls: "text-red-300" },
  ready: { label: "LISTO", cls: "text-sky-300" },
  simulated: { label: "SIMULADO", cls: "text-violet-300" },
  syncing: { label: "SINCRONIZANDO", cls: "text-amber-300" },
  synced: { label: "SINCRONIZADO", cls: "text-emerald-300" },
  failed: { label: "ERROR", cls: "text-red-300" },
  cancelled: { label: "CANCELADO", cls: "text-zinc-400" },
};

function supplierLabel(o: OrderItem): { label: string; cls: string; title: string } {
  const meta = SUPPLIER_META[o.supplier_sync_status] ?? {
    label: o.supplier_sync_status.toUpperCase(),
    cls: "text-brand-muted",
  };
  const plataforma =
    o.supplier_platform && o.supplier_platform !== "unknown" ? o.supplier_platform : null;
  return {
    label: plataforma ? `${plataforma} · ${meta.label}` : meta.label,
    cls: meta.cls,
    title: o.supplier_last_error ?? meta.label,
  };
}

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status.toUpperCase(), cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide whitespace-nowrap ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

function KpiCard({ label, value, tone }: { label: string; value: number; tone?: "gold" | "green" | "red" | "sky" }) {
  const toneCls =
    tone === "red"
      ? value > 0
        ? "border-red-500/50 bg-red-500/10"
        : "border-brand-border bg-brand-surface"
      : tone === "green"
        ? "border-emerald-500/25 bg-brand-surface"
        : tone === "sky"
          ? "border-sky-500/25 bg-brand-surface"
          : "border-brand-border bg-brand-surface";
  const valueCls =
    tone === "red" && value > 0
      ? "text-red-300"
      : tone === "green"
        ? "text-emerald-300"
        : tone === "sky"
          ? "text-sky-300"
          : "text-brand-text";
  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneCls}`}>
      <div className="text-[11px] uppercase tracking-wider text-brand-muted">{label}</div>
      <div className={`font-display text-3xl font-bold mt-1 ${valueCls}`}>{value}</div>
    </div>
  );
}

export default function OrdersPanel() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<OrderItem | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/orders", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { counts: Counts; orders: OrderItem[] };
      setOrders(data.orders);
      setCounts(data.counts);
      // Mantener el detalle abierto con datos frescos.
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

  async function doAction(
    order: OrderItem,
    action: "confirm" | "needs_call" | "resend" | "cancel" | "authorize_pilot" | "revoke_pilot"
  ) {
    if (busy !== null) return; // anti doble-click: una acción externa a la vez
    const confirmations: Record<string, string> = {
      confirm: `¿Marcar el pedido #${order.shopify_order_number} como CONFIRMADO? Se añadirá el tag WA_CONFIRMED en Shopify (si las escrituras están habilitadas).`,
      cancel: `¿Descartar el pedido #${order.shopify_order_number} de este flujo? (No cambia nada en Shopify)`,
      // Acción externa sensible: confirmación explícita con todos los datos.
      authorize_pilot:
        `AUTORIZAR PILOTO para este pedido:\n\n` +
        `Cliente: ${order.customer_name ?? "—"}\n` +
        `Teléfono: +${order.phone}\n` +
        `Pedido: #${order.shopify_order_number}\n\n` +
        `Este cliente NO está en la lista de pruebas. Al autorizar, ESTE pedido ` +
        `(y solo este) podrá recibir WhatsApps, recordatorios y el tag WA_CONFIRMED.\n\n` +
        `No autoriza otros pedidos suyos ni a ningún otro cliente.\n\n¿Continuar?`,
      revoke_pilot: `¿Retirar la autorización de piloto del pedido #${order.shopify_order_number}? Dejará de recibir nada.`,
      resend:
        `Vas a enviar un WhatsApp REAL a:\n\n` +
        `Cliente: ${order.customer_name ?? "—"}\n` +
        `Teléfono: +${order.phone}\n` +
        `Pedido: #${order.shopify_order_number}\n\n` +
        `(Si el sistema está en SAFE MODE o el teléfono no está autorizado, se quedará bloqueado y solo se registrará en el log.)\n\n` +
        `¿Confirmar envío?`,
    };
    if (confirmations[action] && !window.confirm(confirmations[action])) return;
    setBusy(order.id);
    try {
      const res = await fetch(`/api/orders/${order.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        window.alert(data.error ?? `La acción falló (HTTP ${res.status}). Revisa el log.`);
      }
      await refresh();
    } catch {
      window.alert("No se pudo contactar con el servidor. ¿Está arrancado npm run dev:all?");
    } finally {
      setBusy(null);
    }
  }

  const visible = orders.filter((o) => matchesFilter(o, filter));

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      {/* KPIs — lo que Pedro necesita ver en 5 segundos */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <KpiCard label="Pedidos hoy" value={counts?.today ?? 0} tone="gold" />
        <KpiCard label="Confirmados hoy" value={counts?.confirmedToday ?? 0} tone="green" />
        <KpiCard label="Esperando respuesta" value={counts?.awaiting ?? 0} />
        <KpiCard label="Corrección" value={counts?.correction ?? 0} tone="sky" />
        <KpiCard label="Necesitan llamada" value={counts?.needsCall ?? 0} tone="red" />
      </div>

      {/* Filtros — el de LLAMAR es el crítico */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                active
                  ? f.critical
                    ? "bg-red-500/20 border-red-500/60 text-red-200"
                    : "bg-brand-gold text-black border-brand-gold"
                  : f.critical
                    ? "border-red-500/40 text-red-300 hover:bg-red-500/10"
                    : "border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-gold/40"
              }`}
            >
              {f.label}
              {f.key === "needs_call" && (counts?.needsCall ?? 0) > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-red-500/30 text-red-100">{counts?.needsCall}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tabla de pedidos */}
      <div className="rounded-2xl border border-brand-border bg-brand-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
                <th className="px-3 py-3">Pedido</th>
                <th className="px-3 py-3">Cliente</th>
                <th className="px-3 py-3">Teléfono</th>
                <th className="px-3 py-3">Productos</th>
                <th className="px-3 py-3">Total</th>
                <th className="px-3 py-3">Dirección</th>
                <th className="px-3 py-3">Nota repartidor</th>
                <th className="px-3 py-3">Proveedor</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3">Hora</th>
                <th className="px-3 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-brand-muted">
                    {orders.length === 0
                      ? "Sin pedidos todavía. Cuando llegue un pedido COD de Shopify aparecerá aquí."
                      : "Ningún pedido en este filtro."}
                  </td>
                </tr>
              )}
              {visible.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-brand-border/50 last:border-0 hover:bg-brand-surface-2/60 cursor-pointer"
                  onClick={() => setDetail(o)}
                >
                  <td className="px-3 py-3 font-mono font-semibold text-brand-gold whitespace-nowrap">
                    #{o.shopify_order_number}
                    {o.pilot_authorized === 1 && (
                      <span title="Autorizado a mano para el piloto" className="ml-1">
                        🔓
                      </span>
                    )}
                    {o.deferred_until && o.status === "pending_send" && (
                      <span title="En espera hasta la ventana horaria de envío" className="ml-1">
                        🕘
                      </span>
                    )}
                    {o.possible_duplicate === 1 && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 align-middle">
                        POSIBLE DUPLICADO
                      </span>
                    )}
                    {o.cancellation_requested_at && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 align-middle">
                        PIDE CANCELAR
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 max-w-[140px] truncate" title={o.customer_name ?? ""}>
                    {o.customer_name ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs whitespace-nowrap">{o.phone ? `+${o.phone}` : "—"}</td>
                  <td
                    className="px-3 py-3 max-w-[190px] truncate text-brand-muted"
                    title={o.product_summary.replace(/\n/g, " · ")}
                  >
                    {o.product_summary.replace(/\n/g, " · ")}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">{fmtMoney(o.total_price, o.currency)}</td>
                  <td className="px-3 py-3 max-w-[210px] truncate text-brand-muted" title={addressOneLine(o)}>
                    {addressOneLine(o) || "—"}
                    {o.proposed_address && (
                      <span className="ml-1.5 text-sky-300 text-[10px] font-bold">(nueva ✍️)</span>
                    )}
                  </td>
                  <td className="px-3 py-3 max-w-[150px] truncate text-brand-muted" title={o.delivery_note ?? ""}>
                    {o.delivery_note ? `📝 ${o.delivery_note.replace(/\n/g, " ")}` : "—"}
                  </td>
                  <td className="px-3 py-3 max-w-[170px] truncate text-xs" title={supplierLabel(o).title}>
                    <span className={supplierLabel(o).cls}>{supplierLabel(o).label}</span>
                    {o.tracking_number && (
                      <span className="block text-[10px] text-brand-muted font-mono">
                        📦 {o.tracking_number}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill status={o.status} />
                  </td>
                  <td className="px-3 py-3 text-brand-muted whitespace-nowrap">{fmtTime(o.created_at)}</td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="Ver detalle"
                        onClick={() => setDetail(o)}
                        className="px-2 py-1 rounded-md border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-gold/40 text-xs"
                      >
                        Ver
                      </button>
                      {!["confirmed", "cancelled", "ignored_old"].includes(o.status) &&
                        o.pilot_authorized !== 1 && (
                          <button
                            title="Autorizar este pedido para el piloto"
                            disabled={busy === o.id}
                            onClick={() => doAction(o, "authorize_pilot")}
                            className="px-2 py-1 rounded-md border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 text-xs disabled:opacity-50"
                          >
                            🔓
                          </button>
                        )}
                      {!["confirmed", "cancelled", "ignored_old"].includes(o.status) && (
                        <>
                          <button
                            title="Marcar confirmado"
                            disabled={busy === o.id}
                            onClick={() => doAction(o, "confirm")}
                            className="px-2 py-1 rounded-md border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 text-xs disabled:opacity-50"
                          >
                            ✓
                          </button>
                          {o.status !== "needs_call" && (
                            <button
                              title="Marcar para llamar"
                              disabled={busy === o.id}
                              onClick={() => doAction(o, "needs_call")}
                              className="px-2 py-1 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs disabled:opacity-50"
                            >
                              📞
                            </button>
                          )}
                          {o.phone && (
                            <button
                              title="Reenviar WhatsApp de confirmación"
                              disabled={busy === o.id}
                              onClick={() => doAction(o, "resend")}
                              className="px-2 py-1 rounded-md border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-gold/40 text-xs disabled:opacity-50"
                            >
                              ↻
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal de detalle */}
      {detail && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl border border-brand-border bg-brand-surface p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="font-display text-xl font-bold text-brand-text">
                  Pedido <span className="text-brand-gold">#{detail.shopify_order_number}</span>
                  {detail.possible_duplicate === 1 && (
                    <span className="ml-2 px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                      POSIBLE DUPLICADO
                    </span>
                  )}
                  {detail.cancellation_requested_at && (
                    <span className="ml-2 px-2 py-0.5 rounded text-[11px] font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
                      EL CLIENTE PIDE CANCELAR
                    </span>
                  )}
                </div>
                <div className="text-xs text-brand-muted mt-1">
                  Shopify ID {detail.shopify_order_id} · creado {fmtTime(detail.created_at)}
                  {detail.shopify_tagged === 1 && <span className="ml-2 text-emerald-300">· WA_CONFIRMED en Shopify ✓</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={detail.status} />
                <button
                  onClick={() => setDetail(null)}
                  className="px-2 py-1 rounded-md border border-brand-border text-brand-muted hover:text-brand-text text-xs"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm mb-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1">Cliente</div>
                <div>{detail.customer_name ?? "—"}</div>
                <div className="font-mono text-xs text-brand-muted mt-0.5">
                  {detail.phone ? `+${detail.phone}` : "sin teléfono"}
                </div>
                {detail.email && <div className="text-xs text-brand-muted">{detail.email}</div>}
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1">Pedido</div>
                <div className="whitespace-pre-line">{detail.product_summary}</div>
                <div className="font-semibold mt-0.5">
                  💰 {fmtMoney(detail.total_price, detail.currency)} (contra reembolso)
                </div>
              </div>
            </div>

            {/* Nota para el repartidor (opción 3) */}
            {detail.delivery_note && (
              <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-3 mb-4">
                <div className="text-[11px] uppercase tracking-wider text-violet-300 mb-1.5">
                  📝 Nota para el repartidor
                </div>
                <div className="text-sm whitespace-pre-line">{detail.delivery_note}</div>
              </div>
            )}

            {/* Datos extra del formulario del pedido (p.ej. "¿A qué hora estarás en casa?") */}
            {detail.customer_note && (
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3 mb-4">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">
                  Datos del formulario del pedido
                </div>
                <div className="text-sm whitespace-pre-line text-brand-muted">{detail.customer_note}</div>
              </div>
            )}

            {/* Dirección actual vs propuesta — clave en needs_correction */}
            <div className={`grid ${detail.proposed_address ? "grid-cols-2" : "grid-cols-1"} gap-4 mb-4`}>
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">
                  Dirección actual (Shopify)
                </div>
                <div className="text-sm whitespace-pre-line">
                  {[
                    detail.address_line1,
                    detail.address_line2,
                    [detail.postal_code, detail.city].filter(Boolean).join(" "),
                    [detail.province, detail.country].filter(Boolean).join(", "),
                  ]
                    .filter(Boolean)
                    .join("\n") || "—"}
                </div>
              </div>
              {detail.proposed_address && (
                <div className="rounded-xl border border-sky-500/40 bg-sky-500/5 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-sky-300 mb-1.5">
                    ✍️ Dirección propuesta por el cliente
                  </div>
                  <div className="text-sm whitespace-pre-line">{detail.proposed_address}</div>
                  <div className="text-[11px] text-brand-muted mt-2">
                    No se aplica sola: actualízala en Shopify a mano y marca el pedido como confirmado.
                  </div>
                </div>
              )}
            </div>

            {detail.last_error && (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 mb-4 text-sm text-red-300">
                ⚠️ {detail.last_error}
              </div>
            )}

            {detail.status === "confirmed" && (
              <div className="rounded-xl border border-brand-border bg-brand-bg p-3 mb-4 text-sm">
                <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-1.5">
                  Proveedor (simulación — todavía no se envía nada)
                </div>
                <div className={supplierLabel(detail).cls}>{supplierLabel(detail).label}</div>
                {detail.supplier_last_error && (
                  <div className="text-xs text-brand-muted mt-1">{detail.supplier_last_error}</div>
                )}
                <div className="text-xs text-brand-muted mt-1">
                  Fase de creación: {detail.supplier_create_phase}
                  {detail.supplier_pilot_approved === 1 && (
                    <span className="text-violet-300"> · piloto aprobado 🔓</span>
                  )}
                </div>
                {detail.supplier_delivery_note_status === "unsupported" && (
                  <div className="text-xs text-amber-300 mt-1">
                    ⚠️ La nota del repartidor no se puede enviar a este proveedor: hay que
                    comunicarla a mano.
                  </div>
                )}
                {detail.supplier_external_order_id && (
                  <div className="text-xs mt-1">
                    Id en el proveedor:{" "}
                    <span className="font-mono">{detail.supplier_external_order_id}</span>
                  </div>
                )}
                <div className="text-xs text-brand-muted mt-1">
                  Envío: <span className="text-brand-text">{ENVIO_META[detail.supplier_status_normalized] ?? detail.supplier_status_normalized}</span>
                  {detail.tracking_last_checked_at && (
                    <> · última consulta {fmtTime(detail.tracking_last_checked_at)}</>
                  )}
                </div>
                <div className="text-xs mt-2 flex flex-wrap gap-3">
                  <span title="Confirmación del pedido">
                    {detail.confirmed_at ? "✓" : "○"} Confirmación
                  </span>
                  <span title="Aviso de número de seguimiento">
                    {detail.tracking_notification_sent_at ? "✓" : "○"} Tracking
                  </span>
                  <span title="Aviso de que está en reparto">
                    {detail.out_for_delivery_notification_sent_at ? "✓" : "○"} En reparto
                  </span>
                  <span title="Aviso de entrega">
                    {detail.delivered_notification_sent_at ? "✓" : "○"} Entregado
                  </span>
                </div>
                {detail.tracking_number && (
                  <div className="text-xs mt-1">
                    📦 {detail.carrier ? `${detail.carrier} · ` : ""}
                    {detail.tracking_url ? (
                      <a
                        href={detail.tracking_url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline text-sky-300"
                      >
                        {detail.tracking_number}
                      </a>
                    ) : (
                      <span className="font-mono">{detail.tracking_number}</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {detail.pilot_authorized === 1 && (
              <div className="rounded-xl border border-violet-500/40 bg-violet-500/5 p-3 mb-4 text-sm text-violet-200">
                🔓 <strong>Autorizado para el piloto.</strong> Este pedido puede recibir mensajes y
                el tag WA_CONFIRMED aunque su teléfono no esté en la lista de pruebas. La
                autorización vale solo para este pedido.
              </div>
            )}

            {detail.deferred_until && detail.status === "pending_send" && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 mb-4 text-sm text-amber-200">
                🕘 <strong>En espera por horario.</strong> El mensaje saldrá hacia las{" "}
                {new Date(detail.deferred_until * 1000).toLocaleString("es-ES")} (no se pierde ni
                caduca por esperar).
              </div>
            )}

            {/* Línea de tiempo */}
            <div className="rounded-xl border border-brand-border bg-brand-bg p-3 mb-5 text-xs text-brand-muted space-y-1">
              <div>WhatsApp enviado: {fmtTime(detail.whatsapp_sent_at)}</div>
              <div>Recordatorio: {fmtTime(detail.reminder_sent_at)}</div>
              <div>Respuesta del cliente: {fmtTime(detail.customer_replied_at)}</div>
              <div>Confirmado: {fmtTime(detail.confirmed_at)}</div>
              <div>Marcado para llamar: {fmtTime(detail.needs_call_at)}</div>
            </div>

            <div className="flex flex-wrap gap-2 justify-end">
              {!["cancelled", "ignored_old"].includes(detail.status) &&
                (detail.pilot_authorized === 1 ? (
                  <button
                    disabled={busy === detail.id}
                    onClick={() => doAction(detail, "revoke_pilot")}
                    className="px-3.5 py-2 rounded-lg border border-violet-500/40 text-violet-300 hover:bg-violet-500/15 text-sm disabled:opacity-50"
                  >
                    🔓 Retirar autorización
                  </button>
                ) : (
                  <button
                    disabled={busy === detail.id}
                    onClick={() => doAction(detail, "authorize_pilot")}
                    className="px-3.5 py-2 rounded-lg bg-violet-500/10 border border-violet-500/40 text-violet-300 hover:bg-violet-500/20 text-sm font-semibold disabled:opacity-50"
                  >
                    🔓 Autorizar piloto
                  </button>
                ))}
              {!["confirmed", "cancelled", "ignored_old"].includes(detail.status) && (
                <>
                  <button
                    disabled={busy === detail.id}
                    onClick={() => doAction(detail, "confirm")}
                    className="px-3.5 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 text-sm font-semibold disabled:opacity-50"
                  >
                    ✓ Marcar confirmado
                  </button>
                  {detail.status !== "needs_call" && (
                    <button
                      disabled={busy === detail.id}
                      onClick={() => doAction(detail, "needs_call")}
                      className="px-3.5 py-2 rounded-lg bg-red-500/10 border border-red-500/40 text-red-300 hover:bg-red-500/20 text-sm font-semibold disabled:opacity-50"
                    >
                      📞 Marcar para llamar
                    </button>
                  )}
                  {detail.phone && (
                    <button
                      disabled={busy === detail.id}
                      onClick={() => doAction(detail, "resend")}
                      className="px-3.5 py-2 rounded-lg border border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-gold/40 text-sm font-semibold disabled:opacity-50"
                    >
                      ↻ Reenviar WhatsApp
                    </button>
                  )}
                  <button
                    disabled={busy === detail.id}
                    onClick={() => doAction(detail, "cancel")}
                    className="px-3.5 py-2 rounded-lg border border-brand-border text-brand-muted hover:text-red-300 hover:border-red-500/40 text-sm disabled:opacity-50"
                  >
                    Descartar
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
