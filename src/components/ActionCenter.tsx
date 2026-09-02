"use client";

// ============================================================
// ACTION CENTER — la bandeja de trabajo de Pedro.
//
// Ordenada por urgencia. Cada fila: qué pasó, qué hacer, desde cuándo.
// "Resuelto" registra la nota y quita el elemento SIN borrar nada del
// pedido ni del histórico.
//
// v3 (QA 02-09): fuera window.prompt — la nota se pide en un modal propio
// (§53), con skeleton de carga y el lenguaje visual del resto del panel.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, ErrorState, GhostButton, ModalShell, PrimaryButton, SectionTitle, SkeletonRows, StatusDot, timeAgo } from "./ui";

interface Item {
  type: string;
  orderId: number;
  orderNumber: string;
  customer: string;
  problem: string;
  whatToDo: string;
  sinceAt: number;
  urgency: number;
}

interface Data {
  ok: boolean;
  items: Item[];
  counts: Record<string, number>;
  total: number;
}

const ETIQUETAS: Record<string, { label: string; cls: string }> = {
  CANCEL_REQUEST: { label: "PIDE CANCELAR", cls: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
  POSSIBLE_DUPLICATE: { label: "POSIBLE DUPLICADO", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  TRACKING_INCIDENT: { label: "INCIDENCIA ENVÍO", cls: "bg-orange-500/15 text-orange-300 border-orange-500/30" },
  NEEDS_CALL: { label: "SIN RESPUESTA", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" },
  ADDRESS_CORRECTION: { label: "DIRECCIÓN NUEVA", cls: "bg-violet-500/15 text-violet-300 border-violet-500/30" },
  SUPPLIER_ERROR: { label: "PROVEEDOR", cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
};

export default function ActionCenter() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolviendo, setResolviendo] = useState<string | null>(null);
  // Modal de resolución (sustituye a window.prompt).
  const [resolverItem, setResolverItem] = useState<Item | null>(null);
  const [nota, setNota] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/action-center", { cache: "no-store" });
      const j = (await r.json()) as Data;
      if (!j.ok) throw new Error("no se pudo leer");
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  async function confirmarResolucion() {
    const item = resolverItem;
    if (!item) return;
    const key = `${item.orderId}:${item.type}`;
    setResolviendo(key);
    try {
      await fetch("/api/action-center", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: item.orderId, actionType: item.type, note: nota.trim() }),
      });
      await load();
    } finally {
      setResolviendo(null);
      setResolverItem(null);
      setNota("");
    }
  }

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-4xl mx-auto space-y-4">
        <SectionTitle
          right={
            data && data.total > 0 ? (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {Object.entries(data.counts)
                  .filter(([, n]) => n > 0)
                  .map(([t, n]) => (
                    <span key={t} className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${ETIQUETAS[t]?.cls ?? "border-brand-border text-brand-muted"}`}>
                      {ETIQUETAS[t]?.label ?? t}: {n}
                    </span>
                  ))}
              </div>
            ) : null
          }
        >
          Qué requiere tu acción
        </SectionTitle>

        {error && !data ? (
          <ErrorState message={`No se pudo cargar la bandeja: ${error}`} onRetry={load} />
        ) : !data ? (
          <SkeletonRows rows={4} />
        ) : data.total === 0 ? (
          <Card>
            <EmptyState
              icon={<StatusDot status="ok" />}
              title="No hay nada que necesite tu atención."
              hint="Todo está al día. Si algo requiere acción humana, aparecerá aquí solo — no hace falta vigilar otras pestañas."
            />
          </Card>
        ) : (
          <Card className="divide-y divide-brand-border/50">
            {data.items.map((item) => {
              const et = ETIQUETAS[item.type] ?? { label: item.type, cls: "border-brand-border text-brand-muted" };
              const key = `${item.orderId}:${item.type}`;
              return (
                <div key={key} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold border ${et.cls}`}>{et.label}</span>
                    <span className="font-mono font-semibold text-sm text-brand-text">#{item.orderNumber}</span>
                    <span className="text-sm text-brand-muted">{item.customer}</span>
                    <span className="ml-auto text-[11px] text-brand-muted whitespace-nowrap">{timeAgo(item.sinceAt)}</span>
                  </div>
                  <div className="mt-2 text-sm text-brand-text">{item.problem}</div>
                  <div className="mt-1 text-sm text-brand-muted">
                    <span className="font-semibold text-brand-text">Qué hacer:</span> {item.whatToDo}
                  </div>
                  <div className="mt-2.5">
                    <GhostButton
                      disabled={resolviendo === key}
                      onClick={() => {
                        setResolverItem(item);
                        setNota("");
                      }}
                      className="text-xs"
                    >
                      Marcar resuelto
                    </GhostButton>
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      {/* Modal de resolución (nada de window.prompt) */}
      <ModalShell
        open={resolverItem !== null}
        onClose={() => setResolverItem(null)}
        title={resolverItem ? `Marcar resuelto: ${ETIQUETAS[resolverItem.type]?.label ?? resolverItem.type} · #${resolverItem.orderNumber}` : undefined}
      >
        <p className="text-sm text-brand-muted mb-3">
          ¿Qué hiciste? Una frase corta — queda en el histórico y el pedido no se toca.
        </p>
        <input
          autoFocus
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && nota.trim()) void confirmarResolucion();
          }}
          placeholder='p.ej. "hablado con el cliente, mantiene el pedido"'
          className="w-full rounded-lg border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text placeholder:text-brand-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
        />
        <div className="mt-4 flex justify-end gap-2">
          <GhostButton onClick={() => setResolverItem(null)}>Cancelar</GhostButton>
          <PrimaryButton busy={resolviendo !== null} disabled={!nota.trim()} onClick={() => void confirmarResolucion()}>
            Resolver
          </PrimaryButton>
        </div>
      </ModalShell>
    </div>
  );
}
