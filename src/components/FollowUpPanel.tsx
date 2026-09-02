"use client";

// ============================================================
// SEGUIMIENTO (§8): herramienta operativa orientada al PEDIDO.
// Buckets por lo que hay que hacer, antigüedad desde el último contacto,
// y línea temporal por pedido en un drawer. No es WhatsApp Web.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { DockView } from "./NavRail";
import { Card, Chip, EmptyState, ErrorState, GhostButton, PrimaryButton, SectionTitle, SkeletonRows, StatusDot, formatEuro, timeAgo, type UiStatus } from "./ui";

type Bucket = "awaiting_reply" | "confirmed" | "corrections" | "delivery_notes" | "needs_call" | "errors";

interface Item {
  id: number;
  orderNumber: string;
  customer: string | null;
  phoneMasked: string;
  product: string;
  totalPrice: string;
  status: string;
  bucket: Bucket;
  lastContactAt: number | null;
  ageSeconds: number | null;
  proposedAddress: string | null;
  deliveryNote: string | null;
  cancellationRequested: boolean;
}

interface Overview {
  ok: boolean;
  counts: Record<Bucket, number>;
  items: Item[];
}

interface TimelineEvent {
  at: number;
  kind: string;
  label: string;
  detail: string | null;
}

const BUCKETS: Array<{ id: Bucket; label: string; status: UiStatus; next: string }> = [
  { id: "awaiting_reply", label: "Pendientes de respuesta", status: "info", next: "Esperar; si pasa el plazo, se escala solo" },
  { id: "needs_call", label: "Necesitan llamada", status: "warn", next: "Llamar (botón en la ficha) o reenviar" },
  { id: "corrections", label: "Correcciones abiertas", status: "warn", next: "Revisar la dirección propuesta y confirmar" },
  { id: "delivery_notes", label: "Notas del repartidor", status: "info", next: "El cliente está escribiendo la nota" },
  { id: "errors", label: "Errores", status: "error", next: "Falta teléfono o datos: corregir en Shopify" },
  { id: "confirmed", label: "Confirmados (48 h)", status: "ok", next: "Enviar a Beeping desde Pedidos" },
];

const KIND_STATUS: Record<string, UiStatus> = {
  order_received: "muted",
  whatsapp_prepared: "muted",
  message_sent: "info",
  reminder_sent: "info",
  reply_received: "ok",
  address_corrected: "warn",
  note_added: "info",
  confirmed: "ok",
  escalated: "warn",
  call: "warn",
  call_result: "ok",
  status: "muted",
};

function ageLabel(s: number | null): string {
  if (s === null) return "sin contacto aún";
  if (s < 3600) return `hace ${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

function ageStatus(s: number | null): UiStatus {
  if (s === null) return "muted";
  if (s > 24 * 3600) return "error";
  if (s > 6 * 3600) return "warn";
  return "ok";
}

export default function FollowUpPanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket | "all">("all");
  const [open, setOpen] = useState<Item | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/followup", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Overview;
      if (!j.ok) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudo cargar el seguimiento.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    setTimeline(null);
    let vivo = true;
    fetch(`/api/followup?orderId=${open.id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok: boolean; events?: TimelineEvent[] }) => {
        if (vivo) setTimeline(j.ok ? (j.events ?? []) : []);
      })
      .catch(() => vivo && setTimeline([]));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      vivo = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visible = (data?.items ?? []).filter((i) => bucket === "all" || i.bucket === bucket);
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-6xl mx-auto space-y-5">
        <div>
          <h1 className="font-display text-2xl font-semibold text-brand-text">Seguimiento</h1>
          <p className="mt-1 text-sm text-brand-muted">Dónde está cada pedido en la conversación, y qué toca ahora.</p>
        </div>

        {error && !data ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap pb-1 [scrollbar-width:none]" role="tablist" aria-label="Filtrar seguimiento">
              <Chip active={bucket === "all"} onClick={() => setBucket("all")} count={total}>Todos</Chip>
              {BUCKETS.map((b) => (
                <Chip key={b.id} active={bucket === b.id} onClick={() => setBucket(b.id)} count={data.counts[b.id]}>
                  {b.label}
                </Chip>
              ))}
            </div>

            {visible.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<StatusDot status="ok" />}
                  title={total === 0 ? "No hay conversaciones abiertas." : "Nada en este grupo."}
                  hint={total === 0 ? "Cuando un pedido espere respuesta, llamada o corrección, aparecerá aquí con su antigüedad." : undefined}
                />
              </Card>
            ) : (
              <Card className="divide-y divide-brand-border">
                {visible.map((i) => {
                  const b = BUCKETS.find((x) => x.id === i.bucket)!;
                  return (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => setOpen(i)}
                      className="w-full text-left px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/50 first:rounded-t-2xl last:rounded-b-2xl"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-semibold text-brand-text">#{i.orderNumber}</span>
                          <span className="text-sm text-brand-text truncate">{i.customer ?? "—"}</span>
                          <span className="text-xs text-brand-muted">{i.phoneMasked}</span>
                          {i.cancellationRequested && <span className="text-[10px] font-semibold uppercase text-red-600">pide cancelar</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-brand-muted truncate">{i.product.replace(/\n/g, " · ")}</div>
                      </div>
                      <div className="flex items-center gap-3 sm:gap-5 text-xs">
                        <span className="inline-flex items-center gap-1.5 text-brand-muted">
                          <StatusDot status={b.status} /> {b.label}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-brand-muted tabular-nums">
                          <StatusDot status={ageStatus(i.ageSeconds)} /> {ageLabel(i.ageSeconds)}
                        </span>
                        <span className="font-medium text-brand-text tabular-nums">{formatEuro(parseFloat(i.totalPrice))}</span>
                      </div>
                    </button>
                  );
                })}
              </Card>
            )}
          </>
        )}
      </div>

      {/* Drawer: línea temporal del pedido */}
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal aria-label={`Seguimiento del pedido ${open.orderNumber}`}>
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(null)} aria-hidden />
          <div className="relative h-full w-full sm:w-[480px] bg-brand-surface border-l border-brand-border shadow-[var(--shadow-float)] flex flex-col anim-slide-right">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-brand-border">
              <div>
                <div className="font-mono text-sm font-semibold text-brand-text">#{open.orderNumber}</div>
                <div className="text-sm text-brand-text">{open.customer ?? "—"} · {open.phoneMasked}</div>
                <div className="text-xs text-brand-muted mt-0.5">{BUCKETS.find((b) => b.id === open.bucket)?.next}</div>
              </div>
              <button type="button" onClick={() => setOpen(null)} aria-label="Cerrar" className="h-11 w-11 -mr-2 rounded-xl text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <SectionTitle>Línea temporal</SectionTitle>
              {timeline === null ? (
                <SkeletonRows rows={5} />
              ) : timeline.length === 0 ? (
                <EmptyState title="Sin eventos con fecha todavía." />
              ) : (
                <ol className="relative border-l border-brand-border ml-2 space-y-4">
                  {timeline.map((e, idx) => (
                    <li key={idx} className="pl-5 relative">
                      <span className="absolute -left-[5px] top-1.5"><StatusDot status={KIND_STATUS[e.kind] ?? "muted"} /></span>
                      <div className="text-sm text-brand-text">{e.label}</div>
                      {e.detail && <div className="text-xs text-brand-muted whitespace-pre-line">{e.detail}</div>}
                      <div className="text-[11px] text-brand-muted tabular-nums">{new Date(e.at * 1000).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {timeAgo(e.at)}</div>
                    </li>
                  ))}
                </ol>
              )}
              {(open.proposedAddress || open.deliveryNote) && (
                <div className="mt-6 space-y-3">
                  {open.proposedAddress && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                      <div className="text-[10px] uppercase tracking-wider text-amber-700">Dirección propuesta</div>
                      <div className="text-sm whitespace-pre-line mt-1">{open.proposedAddress}</div>
                    </div>
                  )}
                  {open.deliveryNote && (
                    <div className="rounded-xl border border-brand-border bg-brand-surface-2 p-3">
                      <div className="text-[10px] uppercase tracking-wider text-brand-muted">Nota para el repartidor</div>
                      <div className="text-sm whitespace-pre-line mt-1">{open.deliveryNote}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="shrink-0 px-5 py-3 border-t border-brand-border flex gap-2 pb-[max(env(safe-area-inset-bottom),12px)]">
              <PrimaryButton className="flex-1" onClick={() => { setOpen(null); onNavigate("orders"); }}>Abrir en Pedidos</PrimaryButton>
              <GhostButton onClick={() => { setOpen(null); onNavigate("chats"); }}>Ver chat</GhostButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
