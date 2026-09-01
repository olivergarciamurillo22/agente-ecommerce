"use client";

// ============================================================
// ENVÍOS (§25): dónde está cada pedido después de confirmarse.
//   1. Corte de Beeping + sincronización manual.
//   2. Liberaciones ambiguas (si las hay): SIEMPRE primero y en rojo.
//   3. Filtros por cubo/proveedor y la lista (tabla en md+, tarjetas en móvil).
// Todo el estado viene ya interpretado del servidor (`bucket`): aquí solo
// se pinta, no se reinterpreta.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { BEEPING_ORDER_STATUS } from "@/lib/beeping/types";
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  formatEuro,
  GhostButton,
  OrderStateBadge,
  SectionTitle,
  Skeleton,
  SkeletonRows,
  StatusDot,
  timeAgo,
  type OrderUiState,
} from "./ui";

// --- Contrato con /api/shipments (espejo local, como en HomePanel) ---

type ShipmentBucket =
  | "ambiguous"
  | "to_confirm"
  | "incident"
  | "returned"
  | "delivered"
  | "transit"
  | "preparing"
  | "other";

interface ShipmentItem {
  id: number;
  orderNumber: string;
  customer: string | null;
  city: string | null;
  totalPrice: string;
  supplierPlatform: string | null;
  supplier: "beeping" | "dropea" | null;
  logistics: string;
  rawStatus: string | null;
  supplierSyncStatus: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  closure: string;
  beepingSyncStatus: string;
  beepingOrderStatus: number | null;
  beepingLastError: string | null;
  dispatchNote: string | null;
  updatedAt: number;
  confirmedAt: number | null;
  bucket: ShipmentBucket;
}

interface ShipmentsData {
  ok: boolean;
  cutoff: { shipsToday: boolean; minutesLeft: number | null; message: string };
  counts: {
    total: number;
    buckets: Record<ShipmentBucket, number>;
    supplier: { beeping: number; dropea: number };
  };
  shipments: ShipmentItem[];
}

// --- Pestañas (orden del §25) ---

type TabId = "all" | "to_confirm" | "beeping" | "dropea" | "transit" | "incident" | "delivered" | "returned";

const TABS: { id: TabId; label: string; empty: string }[] = [
  { id: "all", label: "Todos", empty: "Sin envíos que mostrar todavía." },
  { id: "to_confirm", label: "Por confirmar", empty: "Nada por confirmar ahora mismo." },
  { id: "beeping", label: "Beeping", empty: "Sin envíos de Beeping ahora mismo." },
  { id: "dropea", label: "Dropea", empty: "Sin envíos de Dropea ahora mismo." },
  { id: "transit", label: "En tránsito", empty: "Sin envíos en tránsito ahora mismo." },
  { id: "incident", label: "Incidencias", empty: "Sin incidencias abiertas. Todo en orden." },
  { id: "delivered", label: "Entregados", empty: "Todavía no hay entregas registradas." },
  { id: "returned", label: "Devueltos", empty: "Sin devoluciones. Mejor así." },
];

function tabCount(data: ShipmentsData, id: TabId): number {
  if (id === "all") return data.counts.total;
  if (id === "beeping") return data.counts.supplier.beeping;
  if (id === "dropea") return data.counts.supplier.dropea;
  return data.counts.buckets[id];
}

function matchesTab(s: ShipmentItem, id: TabId): boolean {
  if (id === "all") return true;
  if (id === "beeping") return s.supplier === "beeping";
  if (id === "dropea") return s.supplier === "dropea";
  return s.bucket === id;
}

// --- Presentación de estados ---

const BUCKET_TO_UI: Partial<Record<ShipmentBucket, OrderUiState>> = {
  delivered: "delivered",
  transit: "shipped",
  preparing: "preparing",
  to_confirm: "ready_beeping",
  incident: "incident",
  other: "other",
};

/** Píldora custom con el mismo esqueleto visual que OrderStateBadge. */
function CustomBadge({ status, label }: { status: "error" | "warn"; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-border bg-brand-surface-2 px-2.5 py-1 text-[11px] whitespace-nowrap">
      <StatusDot status={status} />
      <span className="text-brand-text">{label}</span>
    </span>
  );
}

function ShipmentBadge({ s }: { s: ShipmentItem }) {
  if (s.bucket === "returned") return <CustomBadge status="error" label="Devuelto" />;
  if (s.bucket === "ambiguous") return <CustomBadge status="warn" label="Liberación ambigua" />;
  return <OrderStateBadge state={BUCKET_TO_UI[s.bucket] ?? "other"} />;
}

function supplierLabel(s: ShipmentItem): string {
  if (s.supplier === "beeping") return "Beeping";
  if (s.supplier === "dropea") return "Dropea";
  return "—";
}

function beepingStatusLabel(code: number | null): string | null {
  if (code === null) return null;
  return (BEEPING_ORDER_STATUS as Record<number, string>)[code] ?? `estado ${code}`;
}

function money(totalPrice: string): string {
  const n = Number.parseFloat(totalPrice);
  return formatEuro(Number.isFinite(n) ? n : null);
}

function TrackingCell({ s }: { s: ShipmentItem }) {
  if (!s.trackingNumber) return <span className="text-brand-muted">sin tracking</span>;
  if (s.trackingUrl) {
    return (
      <a
        href={s.trackingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-gold hover:underline underline-offset-2"
      >
        {s.trackingNumber}
      </a>
    );
  }
  return <span className="text-brand-muted">{s.trackingNumber}</span>;
}

// --- Panel ---

export default function ShipmentsPanel() {
  const [data, setData] = useState<ShipmentsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("all");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/shipments", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as ShipmentsData;
      if (!j.ok) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudieron cargar los envíos. Reintentando…");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/beeping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
        cache: "no-store",
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!j?.ok) setSyncError("Beeping desactivado o inaccesible");
      await refresh();
    } catch {
      setSyncError("Beeping desactivado o inaccesible");
    } finally {
      setSyncBusy(false);
    }
  }, [refresh]);

  const handleResolveAmbiguous = useCallback(
    async (id: number) => {
      setResolvingId(id);
      try {
        await fetch(`/api/orders/${id}/beeping`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resolve_ambiguous" }),
          cache: "no-store",
        });
      } catch {
        // El refetch de abajo pinta el estado real; sin alerts.
      } finally {
        await refresh();
        setResolvingId(null);
      }
    },
    [refresh]
  );

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  const ambiguous = data?.shipments.filter((s) => s.bucket === "ambiguous") ?? [];
  const visible = data?.shipments.filter((s) => matchesTab(s, tab)) ?? [];
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* ── Cabecera: corte de Beeping + sync manual ── */}
        <section>
          <SectionTitle
            right={
              <span className="inline-flex items-center gap-3">
                {data ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-muted">
                    <StatusDot status={data.cutoff.shipsToday ? "ok" : "muted"} />
                    {data.cutoff.message}
                  </span>
                ) : null}
                <GhostButton onClick={handleSync} disabled={syncBusy} className="px-3 py-1.5 text-xs">
                  {syncBusy ? (
                    <span
                      className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                      aria-hidden
                    />
                  ) : null}
                  Sincronizar Beeping
                </GhostButton>
              </span>
            }
          >
            Envíos
          </SectionTitle>
          {syncError ? <div className="mb-2 text-xs text-red-400">{syncError}</div> : null}

          {/* ── Liberaciones ambiguas: siempre lo primero ── */}
          {ambiguous.length > 0 ? (
            <Card className="ring-1 ring-red-500/40 mb-4">
              <div className="flex items-start gap-2.5 px-4 pt-3.5 pb-2">
                <span className="mt-1">
                  <StatusDot status="error" pulse />
                </span>
                <div className="text-sm text-brand-text">
                  Liberación a Beeping en estado ambiguo: consultamos Beeping antes de reintentar.
                </div>
              </div>
              <div className="divide-y divide-brand-border border-t border-brand-border">
                {ambiguous.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-sm text-brand-text font-semibold">#{s.orderNumber}</span>
                    <span className="flex-1 text-xs text-brand-muted truncate">
                      {s.customer ?? "sin nombre"}
                      {s.beepingLastError ? ` · ${s.beepingLastError}` : ""}
                    </span>
                    <GhostButton
                      onClick={() => handleResolveAmbiguous(s.id)}
                      disabled={resolvingId !== null}
                      className="px-3 py-1.5 text-xs"
                    >
                      {resolvingId === s.id ? (
                        <span
                          className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                          aria-hidden
                        />
                      ) : null}
                      Resolver consultando
                    </GhostButton>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {/* ── Filtros ── */}
          {!data ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-24 shrink-0 rounded-full" />
              ))}
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {TABS.map((t) => (
                <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} count={tabCount(data, t.id)}>
                  {t.label}
                </Chip>
              ))}
            </div>
          )}
        </section>

        {/* ── Lista ── */}
        <section>
          {!data ? (
            <SkeletonRows rows={6} />
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState title={activeTab.empty} hint="Esta vista se actualiza sola cada 20 segundos." />
            </Card>
          ) : (
            <>
              {/* Tabla en md+ */}
              <Card className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
                      <th className="px-4 py-2.5 font-semibold">Pedido</th>
                      <th className="px-3 py-2.5 font-semibold">Cliente</th>
                      <th className="px-3 py-2.5 font-semibold">Proveedor</th>
                      <th className="px-3 py-2.5 font-semibold">Estado</th>
                      <th className="px-3 py-2.5 font-semibold">Tracking</th>
                      <th className="px-3 py-2.5 font-semibold">Beeping</th>
                      <th className="px-4 py-2.5 font-semibold">Actualizado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-border">
                    {visible.map((s) => {
                      const beepingLabel = beepingStatusLabel(s.beepingOrderStatus);
                      return (
                        <tr key={s.id} className="hover:bg-brand-surface-2 transition-colors">
                          <td className="px-4 py-3 whitespace-nowrap font-semibold text-brand-text">
                            #{s.orderNumber}
                          </td>
                          <td className="px-3 py-3 max-w-[220px]">
                            <div className="text-brand-text truncate">{s.customer ?? "—"}</div>
                            <div className="text-[11px] text-brand-muted truncate">
                              {s.city ? `${s.city} · ` : ""}
                              {money(s.totalPrice)}
                            </div>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-xs text-brand-muted">{supplierLabel(s)}</td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <ShipmentBadge s={s} />
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-xs">
                            <TrackingCell s={s} />
                            {s.carrier ? <span className="ml-1.5 text-brand-muted">({s.carrier})</span> : null}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-[11px] text-brand-muted">
                            {beepingLabel ?? "—"}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs text-brand-muted">
                            {timeAgo(s.updatedAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>

              {/* Tarjetas en móvil */}
              <div className="md:hidden space-y-2.5">
                {visible.map((s) => {
                  const beepingLabel = beepingStatusLabel(s.beepingOrderStatus);
                  return (
                    <Card key={s.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-brand-text">#{s.orderNumber}</span>
                        <ShipmentBadge s={s} />
                      </div>
                      <div className="mt-1.5 text-xs text-brand-muted truncate">
                        {s.customer ?? "sin nombre"}
                        {s.city ? ` · ${s.city}` : ""} · {money(s.totalPrice)} · {supplierLabel(s)}
                        {beepingLabel ? ` · ${beepingLabel}` : ""}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                        <TrackingCell s={s} />
                        <span className="text-brand-muted shrink-0">{timeAgo(s.updatedAt)}</span>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
