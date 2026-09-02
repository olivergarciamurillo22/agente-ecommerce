"use client";

// ============================================================
// CHATS (§23 + §42) — bandeja seria de conversaciones.
//
//   lg+:   [lista 300px | chat | contexto del pedido 320px]
//   md:    [lista 280px | chat]                (contexto oculto)
//   móvil: drill-down (lista → chat con barra de volver; el contexto
//          del pedido se abre en un modal desde esa barra).
//
// La columna del chat REUTILIZA ConversationPanel tal cual. La lista se
// compone aquí: buscador cliente (nombre/teléfono), énfasis en lo
// reciente (<1 h) y tiempos discretos. El contexto del pedido es una
// única superficie agrupada con divisores.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationItem } from "./Dashboard";
import ConversationPanel from "./ConversationPanel";
import Avatar from "./Avatar";
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

/** "ahora", "hace 5 min"… — versión corta para la lista. */
function shortAgo(timestamp: number | null): string {
  if (!timestamp) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (diff < 60) return "ahora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return `${Math.floor(diff / 86400)} d`;
}

// ============================================================
// Lista de conversaciones (composición propia de esta vista)
// ============================================================

function ChatList({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: ConversationItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    const qDigits = q.replace(/\D/g, "");
    return conversations.filter((c) => {
      const byName = (c.name ?? "").toLowerCase().includes(q);
      const byPhone = qDigits.length > 0 && soloDigitos(c.phone).includes(qDigits);
      return byName || byPhone;
    });
  }, [conversations, query]);

  const nowS = Math.floor(Date.now() / 1000);

  return (
    <aside className="border-r border-brand-border bg-brand-bg/60 overflow-y-auto min-h-0">
      <div className="sticky top-0 z-10 bg-brand-bg/95 backdrop-blur border-b border-brand-border">
        <div className="px-4 pt-3 pb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-brand-muted">Conversaciones</h2>
          <span className="text-[11px] font-semibold text-brand-gold bg-brand-surface-2 border border-brand-border-strong rounded-full px-2 py-0.5">
            {conversations.length}
          </span>
        </div>
        <div className="px-3 pb-3">
          <div className="relative">
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.8-3.8" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre o teléfono…"
              aria-label="Buscar conversaciones"
              className="w-full rounded-xl border border-brand-border bg-brand-surface px-3 py-2 pl-9 text-xs text-brand-text placeholder:text-brand-muted focus:outline-none focus:border-brand-border-strong"
            />
          </div>
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="p-6 text-center text-sm text-brand-muted">
          Aún no hay conversaciones. Escríbele al número conectado desde otro WhatsApp para verlas aquí.
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-6 text-center text-sm text-brand-muted">
          Ninguna conversación coincide con la búsqueda.
        </div>
      ) : (
        <ul>
          {filtered.map((c) => {
            const isSelected = c.id === selectedId;
            const label = c.name ?? `+${c.phone}`;
            const recent = c.last_message_at !== null && nowS - c.last_message_at < 3600;
            return (
              <li key={c.id}>
                <button
                  onClick={() => onSelect(c.id)}
                  className={`w-full text-left px-4 py-3.5 border-b border-brand-border/40 transition-colors duration-150 flex gap-3 items-start relative focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
                    isSelected ? "bg-brand-surface-2" : "hover:bg-brand-surface"
                  }`}
                >
                  {isSelected && <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-brand-gold rounded-r" />}
                  <Avatar label={label} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <div
                        className={`text-sm truncate ${
                          recent ? "font-bold text-brand-text" : "font-medium text-brand-text/90"
                        }`}
                      >
                        {label}
                      </div>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {recent ? <span className="h-1.5 w-1.5 rounded-full bg-brand-gold" aria-hidden /> : null}
                        <span className="text-[10px] text-brand-muted/80">{shortAgo(c.last_message_at)}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold shrink-0 ${
                          c.mode === "AI" ? "bg-brand-surface-2 text-brand-text" : "bg-emerald-500/15 text-emerald-600"
                        }`}
                      >
                        {c.mode === "AI" ? "IA" : "TÚ"}
                      </span>
                      {c.last_message_preview ? (
                        <div className={`text-xs truncate ${recent ? "text-brand-text/80" : "text-brand-muted"}`}>
                          {c.last_message_preview}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

// ============================================================
// Columna/modal de contexto: los pedidos del teléfono seleccionado
// ============================================================

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
  const vinculados = telefono && orders ? orders.filter((o) => soloDigitos(o.phone) === telefono) : [];

  return (
    <div className="h-full overflow-y-auto px-3 py-3 space-y-3">
      <h3 className="text-[13px] font-medium text-brand-muted px-1">
        Pedido del cliente
      </h3>

      {!selected ? (
        <EmptyState title="Sin conversación seleccionada" />
      ) : !loaded ? (
        <SkeletonRows rows={3} />
      ) : vinculados.length === 0 ? (
        <EmptyState title="Sin pedido vinculado a este teléfono" hint="Ningún pedido en el agente coincide con este número." />
      ) : (
        <Card className="divide-y divide-brand-border">
          {vinculados.map((o) => {
            const state = deriveState(o);
            const err = errors[o.id];
            return (
              <div key={o.id} className="px-3.5 py-3.5 space-y-2.5">
                <div className="text-sm font-semibold text-brand-text leading-snug">
                  #{o.shopify_order_number}
                  <span className="font-normal text-brand-muted"> · {o.product_summary}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <OrderStateBadge state={state} />
                  <span className="text-sm font-semibold text-brand-text">{formatEuro(parseFloat(o.total_price))}</span>
                </div>
                <div className="text-xs text-brand-muted space-y-0.5">
                  {o.city ? <div>{o.city}</div> : null}
                  <div>Último contacto: {timeAgo(o.customer_replied_at ?? o.whatsapp_sent_at)}</div>
                </div>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
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
                {err ? <div className="text-xs text-red-600 leading-snug">{err}</div> : null}
              </div>
            );
          })}
        </Card>
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
          className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-brand-border-strong text-brand-text placeholder:text-brand-muted"
        />
        {noteError ? <div className="mt-2 text-xs text-red-600 leading-snug">{noteError}</div> : null}
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
        <ChatList conversations={conversations} selectedId={selectedId} onSelect={onSelect} />
        <ConversationPanel conversation={selected} onRefresh={onRefresh} />
        <div className="hidden lg:block min-h-0 border-l border-brand-border bg-brand-bg/60">
          {contexto}
        </div>
      </div>

      {/* ── móvil: drill-down ── */}
      <div className="md:hidden h-full">
        {!mobileChatOpen || !selected ? (
          <div className="h-full grid grid-rows-1">
            <ChatList conversations={conversations} selectedId={selectedId} onSelect={handleSelect} />
          </div>
        ) : (
          <div className="h-full flex flex-col">
            <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-brand-border bg-brand-surface/70 backdrop-blur">
              <button
                type="button"
                onClick={() => setMobileChatOpen(false)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-brand-text hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30"
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
