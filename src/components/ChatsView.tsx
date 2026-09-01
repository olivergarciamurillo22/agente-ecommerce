"use client";

// ============================================================
// CHATS (§23) — bandeja profesional de conversaciones.
//
//   lg+:   [lista 300px | chat | contexto del pedido 320px]
//   md:    [lista 280px | chat]                (contexto oculto)
//   móvil: drill-down (lista → chat con barra de volver; el contexto
//          del pedido se abre en un modal desde esa barra).
//
// La lista y el chat REUTILIZAN ConversationList y ConversationPanel tal
// cual. Lo nuevo es la columna de contexto: los pedidos cuyo teléfono
// coincide con el de la conversación, con su estado y acciones rápidas.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { ConversationItem } from "./Dashboard";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";
import {
  Card,
  EmptyState,
  formatEuro,
  GhostButton,
  ModalShell,
  OrderStateBadge,
  PrimaryButton,
  SkeletonRows,
  timeAgo,
  type OrderUiState,
} from "./ui";

interface ChatsViewProps {
  conversations: ConversationItem[];
  selected: ConversationItem | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRefresh: () => void;
}

/** Lo que usamos de cada fila de /api/orders (viene el OrderRow entero sin raw_payload). */
interface OrderApiItem {
  id: number;
  shopify_order_number: string;
  customer_name: string | null;
  phone: string;
  status: string;
  total_price: string;
  product_summary: string;
  closure_status: string;
  beeping_sync_status: string;
  confirmed_at: number | null;
  city: string | null;
  customer_replied_at: number | null;
  whatsapp_sent_at: number | null;
  dispatch_note: string | null;
}

const soloDigitos = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/** Estado visual único (§21) derivado de los tres ejes del pedido. */
function deriveState(o: OrderApiItem): OrderUiState {
  if (o.closure_status === "delivered") return "delivered";
  if (o.closure_status === "cancelled" || o.status === "cancelled") return "cancelled";
  if (o.beeping_sync_status === "released") return "preparing";
  if (o.status === "confirmed") return "confirmed";
  if (o.status === "needs_call") return "needs_call";
  if (["pending_send", "awaiting_reply", "reminder_sent", "awaiting_delivery_note"].includes(o.status))
    return "waiting_customer";
  return "other";
}

const smallBtn = "px-2.5 py-1.5 text-xs";

/** Columna/modal de contexto: los pedidos del teléfono seleccionado. */
function OrderContext({
  selected,
  orders,
  loaded,
  onChanged,
}: {
  selected: ConversationItem | null;
  orders: OrderApiItem[] | null;
  loaded: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null); // "orderId:action"
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [noteModal, setNoteModal] = useState<{ orderId: number; orderNumber: string } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);

  const doAction = useCallback(
    async (orderId: number, action: "confirm" | "needs_call" | "resend") => {
      setBusy(`${orderId}:${action}`);
      try {
        const res = await fetch(`/api/orders/${orderId}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
          cache: "no-store",
        });
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !j.ok) {
          setErrors((e) => ({ ...e, [orderId]: j.error ?? `no se pudo completar (HTTP ${res.status})` }));
        } else {
          setErrors((e) => ({ ...e, [orderId]: "" }));
          onChanged();
        }
      } catch {
        setErrors((e) => ({ ...e, [orderId]: "sin conexión con el panel; reintenta" }));
      } finally {
        setBusy(null);
      }
    },
    [onChanged]
  );

  const saveNote = useCallback(async () => {
    if (!noteModal) return;
    setNoteSaving(true);
    setNoteError(null);
    try {
      const res = await fetch(`/api/orders/${noteModal.orderId}/beeping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dispatch_note", note: noteText }),
        cache: "no-store",
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setNoteError(j.error ?? `no se pudo guardar (HTTP ${res.status})`);
      } else {
        setNoteModal(null);
        onChanged();
      }
    } catch {
      setNoteError("sin conexión con el panel; reintenta");
    } finally {
      setNoteSaving(false);
    }
  }, [noteModal, noteText, onChanged]);

  const telefono = soloDigitos(selected?.phone);
  const vinculados =
    telefono && orders ? orders.filter((o) => soloDigitos(o.phone) === telefono) : [];

  return (
    <div className="h-full overflow-y-auto px-3 py-3 space-y-3">
      <h3 className="text-[11px] uppercase tracking-[0.18em] text-brand-muted font-semibold px-1">
        Pedido del cliente
      </h3>

      {!selected ? (
        <EmptyState title="Sin conversación seleccionada" />
      ) : !loaded ? (
        <SkeletonRows rows={3} />
      ) : vinculados.length === 0 ? (
        <EmptyState title="Sin pedido vinculado a este teléfono" hint="Ningún pedido en el agente coincide con este número." />
      ) : (
        vinculados.map((o) => {
          const state = deriveState(o);
          const err = errors[o.id];
          return (
            <Card key={o.id} className="px-3.5 py-3 space-y-2.5">
              <div className="text-sm font-semibold text-brand-text leading-snug">
                #{o.shopify_order_number}
                <span className="font-normal text-brand-muted"> · {o.product_summary}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <OrderStateBadge state={state} />
                <span className="text-sm font-semibold text-brand-text">
                  {formatEuro(parseFloat(o.total_price))}
                </span>
              </div>
              <div className="text-xs text-brand-muted space-y-0.5">
                {o.city ? <div>{o.city}</div> : null}
                <div>Último contacto: {timeAgo(o.customer_replied_at ?? o.whatsapp_sent_at)}</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {o.status !== "confirmed" ? (
                  <GhostButton
                    className={smallBtn}
                    disabled={busy === `${o.id}:confirm`}
                    onClick={() => doAction(o.id, "confirm")}
                  >
                    Confirmar
                  </GhostButton>
                ) : null}
                <GhostButton
                  className={smallBtn}
                  disabled={busy === `${o.id}:resend`}
                  onClick={() => doAction(o.id, "resend")}
                >
                  Reenviar
                </GhostButton>
                <GhostButton
                  className={smallBtn}
                  disabled={busy === `${o.id}:needs_call`}
                  onClick={() => doAction(o.id, "needs_call")}
                >
                  A llamadas
                </GhostButton>
                <GhostButton
                  className={smallBtn}
                  onClick={() => {
                    setNoteText(o.dispatch_note ?? "");
                    setNoteError(null);
                    setNoteModal({ orderId: o.id, orderNumber: o.shopify_order_number });
                  }}
                >
                  Nota expedición
                </GhostButton>
                <GhostButton
                  className={smallBtn}
                  onClick={() => {
                    window.location.hash = "#pedidos";
                  }}
                >
                  Ver pedido →
                </GhostButton>
              </div>
              {err ? <div className="text-xs text-red-400 leading-snug">{err}</div> : null}
            </Card>
          );
        })
      )}

      <ModalShell
        open={noteModal !== null}
        onClose={() => setNoteModal(null)}
        title={noteModal ? `Nota de expedición · #${noteModal.orderNumber}` : undefined}
      >
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={4}
          placeholder="Nota interna para la expedición (no viaja a Beeping)…"
          className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-brand-gold/60 text-brand-text placeholder:text-brand-muted"
        />
        {noteError ? <div className="mt-2 text-xs text-red-400 leading-snug">{noteError}</div> : null}
        <div className="mt-3 flex justify-end gap-2">
          <GhostButton onClick={() => setNoteModal(null)}>Cancelar</GhostButton>
          <PrimaryButton busy={noteSaving} onClick={saveNote}>
            Guardar nota
          </PrimaryButton>
        </div>
      </ModalShell>
    </div>
  );
}

export default function ChatsView({
  conversations,
  selected,
  selectedId,
  onSelect,
  onRefresh,
}: ChatsViewProps) {
  const [orders, setOrders] = useState<OrderApiItem[] | null>(null);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  // Móvil: la lista y el chat son pantallas distintas (drill-down).
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);

  const refreshOrders = useCallback(async () => {
    try {
      const res = await fetch("/api/orders", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { orders: OrderApiItem[] };
      setOrders(j.orders);
      setOrdersLoaded(true);
    } catch {
      // silenciar: reintenta en el siguiente ciclo
    }
  }, []);

  useEffect(() => {
    refreshOrders();
    const t = setInterval(refreshOrders, 10_000);
    return () => clearInterval(t);
  }, [refreshOrders]);

  const handleSelect = useCallback(
    (id: number) => {
      onSelect(id);
      setMobileChatOpen(true);
    },
    [onSelect]
  );

  const contexto = (
    <OrderContext selected={selected} orders={orders} loaded={ordersLoaded} onChanged={refreshOrders} />
  );

  return (
    <div className="h-full overflow-hidden">
      {/* ── md+: lista | chat (| contexto en lg+) ── */}
      <div className="hidden md:grid h-full md:grid-cols-[280px_1fr] lg:grid-cols-[300px_1fr_320px]">
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={onSelect}
          onRefresh={onRefresh}
        />
        <ConversationPanel conversation={selected} onRefresh={onRefresh} />
        <div className="hidden lg:block min-h-0 border-l border-brand-border bg-brand-bg/60">
          {contexto}
        </div>
      </div>

      {/* ── móvil: drill-down ── */}
      <div className="md:hidden h-full">
        {!mobileChatOpen || !selected ? (
          <div className="h-full grid grid-rows-1">
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={handleSelect}
              onRefresh={onRefresh}
            />
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-brand-border bg-brand-surface/70 backdrop-blur">
              <button
                type="button"
                onClick={() => setMobileChatOpen(false)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-brand-text hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
              >
                ← Conversaciones
              </button>
              <GhostButton className={smallBtn} onClick={() => setMobileContextOpen(true)}>
                Pedido
              </GhostButton>
            </div>
            <div className="flex-1 min-h-0 grid grid-rows-1">
              <ConversationPanel conversation={selected} onRefresh={onRefresh} />
            </div>
          </div>
        )}
        <ModalShell open={mobileContextOpen} onClose={() => setMobileContextOpen(false)}>
          <div className="max-h-[70vh] overflow-y-auto -mx-1 px-1">{contexto}</div>
        </ModalShell>
      </div>
    </div>
  );
}
