"use client";

// ============================================================
// SEGUIMIENTO · Vista general (§8): herramienta operativa orientada al
// PEDIDO. Resumen compacto, toolbar, lista densa ordenada por urgencia y
// drawer con la línea temporal. No es WhatsApp Web.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DockView } from "./NavRail";
import {
  Badge,
  Card,
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  GhostButton,
  MetricCell,
  MetricGroup,
  ModalShell,
  PageHeader,
  PrimaryButton,
  SearchInput,
  SectionTitle,
  SelectInput,
  SkeletonRows,
  StatusDot,
  formatEuro,
  timeAgo,
  type UiStatus,
} from "./ui";

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

/** Orden de urgencia (0 = más urgente) y vocabulario de cada grupo. */
const BUCKETS: Array<{ id: Bucket; label: string; short: string; status: UiStatus; urgency: number; next: string; action: string; urgent: boolean }> = [
  { id: "errors", label: "Errores", short: "Errores", status: "error", urgency: 0, next: "Falta teléfono o datos: corregir en Shopify", action: "Corregir en Shopify", urgent: true },
  { id: "corrections", label: "Correcciones abiertas", short: "Correcciones", status: "warn", urgency: 1, next: "Revisar la dirección propuesta y confirmar", action: "Revisar dirección", urgent: true },
  { id: "needs_call", label: "Necesitan llamada", short: "Llamar", status: "warn", urgency: 2, next: "Llamar (botón en la ficha) o reenviar", action: "Llamar", urgent: true },
  { id: "awaiting_reply", label: "Sin respuesta", short: "Sin respuesta", status: "info", urgency: 3, next: "Esperar; si pasa el plazo, se escala solo", action: "Ver conversación", urgent: false },
  { id: "delivery_notes", label: "Notas del repartidor", short: "Notas", status: "info", urgency: 4, next: "El cliente está escribiendo la nota", action: "Ver nota", urgent: false },
  { id: "confirmed", label: "Confirmados (48 h)", short: "Confirmados", status: "ok", urgency: 5, next: "Enviar a Beeping desde Pedidos", action: "Enviar a Beeping", urgent: false },
];
const BY_ID = Object.fromEntries(BUCKETS.map((b) => [b.id, b])) as Record<Bucket, (typeof BUCKETS)[number]>;

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

const DAY = 86400;

/** Antigüedad como frase operativa: "Sin resolver · 12 días" cuando es alarma. */
function ageInfo(s: number | null): { text: string; status: UiStatus; alarm: boolean } {
  if (s === null) return { text: "Sin contacto todavía", status: "muted", alarm: false };
  if (s < 3600) return { text: `hace ${Math.max(1, Math.floor(s / 60))} min`, status: "muted", alarm: false };
  if (s < 6 * 3600) return { text: `hace ${Math.floor(s / 3600)} h`, status: "muted", alarm: false };
  if (s < DAY) return { text: `Sin resolver · ${Math.floor(s / 3600)} h`, status: "warn", alarm: true };
  const d = Math.floor(s / DAY);
  return { text: `Sin resolver · ${d} ${d === 1 ? "día" : "días"}`, status: "error", alarm: true };
}

type AgeFilter = "all" | "6h" | "24h" | "3d";
type Sort = "urgency" | "oldest" | "newest" | "amount";

function passesAge(s: number | null, f: AgeFilter): boolean {
  if (f === "all") return true;
  if (s === null) return false;
  return s >= (f === "6h" ? 6 * 3600 : f === "24h" ? DAY : 3 * DAY);
}

export default function FollowUpPanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket | "all">("all");
  const [q, setQ] = useState("");
  const [age, setAge] = useState<AgeFilter>("all");
  const [sort, setSort] = useState<Sort>("urgency");
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
    return () => {
      vivo = false;
    };
  }, [open]);

  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const needAttention = counts ? counts.errors + counts.corrections + counts.needs_call : 0;

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (data?.items ?? []).filter((i) => {
      if (bucket !== "all" && i.bucket !== bucket) return false;
      if (!passesAge(i.ageSeconds, age)) return false;
      if (!term) return true;
      return `${i.orderNumber} ${i.customer ?? ""} ${i.phoneMasked} ${i.product}`.toLowerCase().includes(term);
    });
    const ageOf = (i: Item) => i.ageSeconds ?? -1;
    return [...list].sort((a, b) => {
      if (sort === "oldest") return ageOf(b) - ageOf(a);
      if (sort === "newest") return ageOf(a) - ageOf(b);
      if (sort === "amount") return parseFloat(b.totalPrice) - parseFloat(a.totalPrice);
      const u = BY_ID[a.bucket].urgency - BY_ID[b.bucket].urgency;
      return u !== 0 ? u : ageOf(b) - ageOf(a);
    });
  }, [data, bucket, q, age, sort]);

  const filtersActive = bucket !== "all" || q.trim() !== "" || age !== "all" || sort !== "urgency";
  const clear = () => {
    setBucket("all");
    setQ("");
    setAge("all");
    setSort("urgency");
  };

  const [sheet, setSheet] = useState(false);
  const selectors = (
    <>
      <SelectInput
        value={age}
        onChange={(v) => setAge(v as AgeFilter)}
        label="Antigüedad"
        className="w-full sm:w-auto"
        options={[
          { value: "all", label: "Cualquier antigüedad" },
          { value: "6h", label: "Más de 6 h" },
          { value: "24h", label: "Más de 24 h" },
          { value: "3d", label: "Más de 3 días" },
        ]}
      />
      <SelectInput
        value={sort}
        onChange={(v) => setSort(v as Sort)}
        label="Orden"
        className="w-full sm:w-auto"
        options={[
          { value: "urgency", label: "Por urgencia" },
          { value: "oldest", label: "Más antiguos primero" },
          { value: "newest", label: "Más recientes primero" },
          { value: "amount", label: "Mayor importe" },
        ]}
      />
    </>
  );

  const rowAction = (i: Item) => {
    const b = BY_ID[i.bucket];
    if (b.id === "confirmed") return { label: b.action, go: () => onNavigate("orders") };
    if (b.id === "awaiting_reply" || b.id === "delivery_notes") return { label: b.action, go: () => onNavigate("chats") };
    return { label: b.action, go: () => setOpen(i) };
  };

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-6 md:py-7 pb-24 md:pb-10">
      <div className="space-y-6">
        <PageHeader
          title="Seguimiento"
          description="Pedidos que están esperando una respuesta o una acción."
          actions={needAttention > 0 ? <PrimaryButton onClick={() => { setBucket("all"); setSort("urgency"); }}>{needAttention} {needAttention === 1 ? "pedido requiere" : "pedidos requieren"} atención</PrimaryButton> : undefined}
        />

        {error && !data ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data || !counts ? (
          <SkeletonRows rows={6} />
        ) : (
          <>
            <MetricGroup cols={4}>
              <MetricCell label="Necesitan atención" value={needAttention} status={needAttention > 0 ? "warn" : undefined} support="errores, correcciones y llamadas" onClick={() => setBucket(needAttention > 0 ? (counts.errors > 0 ? "errors" : counts.corrections > 0 ? "corrections" : "needs_call") : "all")} active={false} />
              <MetricCell label="Sin respuesta" value={counts.awaiting_reply} support="esperando al cliente" onClick={() => setBucket("awaiting_reply")} active={bucket === "awaiting_reply"} />
              <MetricCell label="Correcciones abiertas" value={counts.corrections} status={counts.corrections > 0 ? "warn" : undefined} support="direcciones por revisar" onClick={() => setBucket("corrections")} active={bucket === "corrections"} />
              <MetricCell label="Necesitan llamada" value={counts.needs_call} status={counts.needs_call > 0 ? "warn" : undefined} support="sin respuesta al WhatsApp" onClick={() => setBucket("needs_call")} active={bucket === "needs_call"} />
            </MetricGroup>

            {/* Toolbar: búsqueda + antigüedad + orden (en móvil, dentro de un
                bottom sheet); debajo, la fila compacta de estados */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput value={q} onChange={setQ} placeholder="Pedido, cliente o teléfono" label="Buscar en seguimiento" className="flex-1 min-w-0 sm:flex-none sm:w-[260px]" />
                <div className="hidden sm:contents">{selectors}</div>
                <GhostButton className="sm:hidden" onClick={() => setSheet(true)}>Filtros{age !== "all" || sort !== "urgency" ? " · 1" : ""}</GhostButton>
                {filtersActive ? (
                  <button type="button" onClick={clear} className="h-9 px-2 text-[13px] font-medium text-brand-muted hover:text-brand-text rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/20">
                    Limpiar
                  </button>
                ) : null}
                <span className="ml-auto text-[13px] text-brand-tertiary tabular-nums">{visible.length} de {total}</span>
              </div>
              <div className="flex gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 [scrollbar-width:none]" role="group" aria-label="Filtrar por estado">
                <Chip active={bucket === "all"} onClick={() => setBucket("all")} count={total}>Todos</Chip>
                {BUCKETS.map((b) => (
                  <Chip key={b.id} active={bucket === b.id} onClick={() => setBucket(b.id)} count={counts[b.id]}>
                    {b.short}
                  </Chip>
                ))}
              </div>
            </div>

            <ModalShell open={sheet} onClose={() => setSheet(false)} title="Filtros">
              <div className="space-y-3">
                <label className="block text-[13px] text-brand-muted">Antigüedad</label>
                {selectors}
                <div className="flex gap-2 pt-2">
                  <PrimaryButton className="flex-1" onClick={() => setSheet(false)}>Aplicar</PrimaryButton>
                  <GhostButton onClick={() => { clear(); setSheet(false); }}>Limpiar</GhostButton>
                </div>
              </div>
            </ModalShell>

            {visible.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<StatusDot status="ok" />}
                  title={total === 0 ? "No hay conversaciones abiertas." : "Nada con estos filtros."}
                  hint={total === 0 ? "Cuando un pedido espere respuesta, llamada o corrección, aparecerá aquí con su antigüedad." : "Prueba a limpiar los filtros o a cambiar de estado."}
                />
              </Card>
            ) : (
              <>
                {/* Escritorio: lista operativa con columnas */}
                <Card className="hidden md:block overflow-hidden">
                  {visible.length >= 3 && (
                    <div className="grid grid-cols-[minmax(0,1fr)_120px_90px_140px] xl:grid-cols-[minmax(0,2.6fr)_minmax(0,2.4fr)_140px_170px_96px_150px] gap-4 items-center px-5 h-10 bg-brand-surface-subtle border-b border-brand-border text-[11px] font-medium uppercase tracking-[0.06em] text-brand-tertiary">
                      <div>Pedido / cliente</div>
                      <div className="hidden xl:block">Producto</div>
                      <div>Estado</div>
                      <div className="hidden xl:block">Última actividad</div>
                      <div className="text-right">Importe</div>
                      <div className="text-right">Acción</div>
                    </div>
                  )}
                  <ul className="divide-y divide-brand-border">
                    {visible.map((i) => {
                      const b = BY_ID[i.bucket];
                      const a = ageInfo(i.ageSeconds);
                      const urgent = b.urgent || a.alarm || i.cancellationRequested;
                      const act = rowAction(i);
                      return (
                        <li key={i.id} className="group relative grid grid-cols-[minmax(0,1fr)_120px_90px_140px] xl:grid-cols-[minmax(0,2.6fr)_minmax(0,2.4fr)_140px_170px_96px_150px] gap-4 items-center px-5 min-h-[64px] py-2.5 hover:bg-brand-surface-subtle transition-colors">
                          <button type="button" onClick={() => setOpen(i)} className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-text/30" aria-label={`Abrir pedido ${i.orderNumber}`} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              {urgent && <span className="h-1.5 w-1.5 rounded-full bg-brand-text shrink-0" aria-hidden />}
                              <span className="text-[14px] font-semibold text-brand-text tabular-nums">#{i.orderNumber}</span>
                              <span className="text-[14px] text-brand-text truncate">{i.customer ?? "—"}</span>
                            </div>
                            <div className="mt-0.5 text-[12px] text-brand-tertiary tabular-nums truncate">
                              {i.phoneMasked}
                              <span className={`xl:hidden ${a.alarm ? `font-medium ${a.status === "error" ? "text-red-600" : "text-amber-600"}` : ""}`}> · {a.text}</span>
                              <span className="xl:hidden"> · {i.product.replace(/\n/g, " · ")}</span>
                              {i.cancellationRequested && <span className="ml-2 font-medium text-red-600">Pide cancelar</span>}
                            </div>
                          </div>
                          <div className="hidden xl:block min-w-0 text-[13px] text-brand-muted truncate" title={i.product.replace(/\n/g, " · ")}>{i.product.replace(/\n/g, " · ")}</div>
                          <div><Badge status={b.status}>{b.short}</Badge></div>
                          <div className={`hidden xl:block text-[13px] tabular-nums ${a.alarm ? `font-medium ${a.status === "error" ? "text-red-600" : "text-amber-600"}` : "text-brand-muted"}`}>{a.text}</div>
                          <div className="text-right text-[14px] font-semibold text-brand-text tabular-nums">{formatEuro(parseFloat(i.totalPrice))}</div>
                          <div className="relative text-right">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); act.go(); }}
                              className={`inline-flex items-center h-8 px-2.5 rounded-lg text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 focus-visible:opacity-100 ${urgent ? "bg-brand-text text-white hover:bg-brand-gold-soft" : "text-brand-text opacity-0 group-hover:opacity-100 hover:bg-brand-surface-2"}`}
                            >
                              {act.label}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Card>

                {/* Móvil: tarjeta operativa por pedido */}
                <ul className="md:hidden space-y-3">
                  {visible.map((i) => {
                    const b = BY_ID[i.bucket];
                    const a = ageInfo(i.ageSeconds);
                    const urgent = b.urgent || a.alarm || i.cancellationRequested;
                    const act = rowAction(i);
                    return (
                      <li key={i.id}>
                        <Card className="p-4">
                          <button type="button" onClick={() => setOpen(i)} className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 rounded-lg">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2">
                                {urgent && <span className="h-1.5 w-1.5 rounded-full bg-brand-text" aria-hidden />}
                                <span className="text-[15px] font-semibold text-brand-text tabular-nums">#{i.orderNumber}</span>
                              </div>
                              <span className="text-[15px] font-semibold text-brand-text tabular-nums">{formatEuro(parseFloat(i.totalPrice))}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <Badge status={b.status}>{b.short}</Badge>
                              <span className={`text-[12px] tabular-nums ${a.alarm ? `font-medium ${a.status === "error" ? "text-red-600" : "text-amber-600"}` : "text-brand-tertiary"}`}>{a.text}</span>
                            </div>
                            <div className="mt-3 text-[14px] text-brand-text truncate">{i.customer ?? "—"} <span className="text-brand-tertiary text-[12px] tabular-nums">{i.phoneMasked}</span></div>
                            <div className="mt-0.5 text-[13px] text-brand-muted truncate">{i.product.replace(/\n/g, " · ")}</div>
                            {i.cancellationRequested && <div className="mt-1 text-[12px] font-medium text-red-600">Pide cancelar el pedido</div>}
                          </button>
                          {urgent ? (
                            <PrimaryButton className="mt-3 w-full" onClick={act.go}>{act.label}</PrimaryButton>
                          ) : (
                            <div className="mt-3 text-[13px] text-brand-muted">Siguiente paso: {b.next}</div>
                          )}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      {/* Drawer: línea temporal del pedido */}
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        label={open ? `Seguimiento del pedido ${open.orderNumber}` : "Seguimiento"}
        title={open ? <>#{open.orderNumber} <span className="font-medium text-brand-muted">· {open.customer ?? "—"}</span></> : ""}
        subtitle={open ? <span className="tabular-nums">{open.phoneMasked} · {formatEuro(parseFloat(open.totalPrice))}</span> : undefined}
        meta={open ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge status={BY_ID[open.bucket].status}>{BY_ID[open.bucket].label}</Badge>
            <span className="text-[13px] text-brand-muted">{BY_ID[open.bucket].next}</span>
          </div>
        ) : undefined}
        footer={
          <>
            <PrimaryButton className="flex-1" onClick={() => { setOpen(null); onNavigate("orders"); }}>Abrir en Pedidos</PrimaryButton>
            <GhostButton onClick={() => { setOpen(null); onNavigate("chats"); }}>Ver conversación</GhostButton>
          </>
        }
      >
        {open && (
          <>
            <SectionTitle>Línea temporal</SectionTitle>
            {timeline === null ? (
              <SkeletonRows rows={5} />
            ) : timeline.length === 0 ? (
              <EmptyState title="Sin eventos con fecha todavía." />
            ) : (
              <ol className="relative border-l border-brand-border ml-1.5 space-y-4">
                {timeline.map((e, idx) => (
                  <li key={idx} className="pl-5 relative">
                    <span className="absolute -left-[5px] top-1.5"><StatusDot status={KIND_STATUS[e.kind] ?? "muted"} /></span>
                    <div className="text-[14px] text-brand-text">{e.label}</div>
                    {e.detail && <div className="text-[13px] text-brand-muted whitespace-pre-line">{e.detail}</div>}
                    <div className="text-[12px] text-brand-tertiary tabular-nums">{new Date(e.at * 1000).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {timeAgo(e.at)}</div>
                  </li>
                ))}
              </ol>
            )}
            {(open.proposedAddress || open.deliveryNote) && (
              <div className="mt-6 space-y-3">
                {open.proposedAddress && (
                  <div className="rounded-xl border border-amber-600/30 bg-amber-600/[0.06] p-3">
                    <div className="text-[12px] font-medium text-amber-700">Dirección propuesta por el cliente</div>
                    <div className="text-[14px] whitespace-pre-line mt-1">{open.proposedAddress}</div>
                  </div>
                )}
                {open.deliveryNote && (
                  <div className="rounded-xl border border-brand-border bg-brand-surface-subtle p-3">
                    <div className="text-[12px] font-medium text-brand-muted">Nota para el repartidor</div>
                    <div className="text-[14px] whitespace-pre-line mt-1">{open.deliveryNote}</div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}
