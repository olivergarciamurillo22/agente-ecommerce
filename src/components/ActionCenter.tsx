"use client";

// ============================================================
// ACTION CENTER — la bandeja de trabajo de Pedro.
//
// Ordenada por urgencia. Cada fila: qué pasó, qué hacer, desde cuándo.
// "Resuelto" registra la nota y quita el elemento SIN borrar nada del
// pedido ni del histórico.
// ============================================================

import { useCallback, useEffect, useState } from "react";

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

function hace(epoch: number): string {
  const min = Math.max(0, Math.floor(Date.now() / 1000 - epoch) / 60);
  if (min < 60) return `hace ${Math.round(min)} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} día(s)`;
}

export default function ActionCenter() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolviendo, setResolviendo] = useState<string | null>(null);

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

  async function resolver(item: Item) {
    const note = window.prompt(
      `Marcar RESUELTO: ${ETIQUETAS[item.type]?.label ?? item.type} del pedido #${item.orderNumber}.\n\n¿Qué hiciste? (una frase corta, queda en el histórico)`
    );
    if (note === null) return; // canceló
    setResolviendo(`${item.orderId}:${item.type}`);
    try {
      await fetch("/api/action-center", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: item.orderId, actionType: item.type, note }),
      });
      await load();
    } finally {
      setResolviendo(null);
    }
  }

  if (error) return <div className="p-6 text-sm text-rose-300">No se pudo cargar la bandeja: {error}</div>;
  if (!data) return <div className="p-6 text-sm text-brand-muted">Cargando…</div>;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold mr-2">Qué requiere tu acción</h2>
        {Object.entries(data.counts)
          .filter(([, n]) => n > 0)
          .map(([t, n]) => (
            <span key={t} className={`px-2 py-0.5 rounded text-[11px] font-bold border ${ETIQUETAS[t]?.cls ?? ""}`}>
              {ETIQUETAS[t]?.label ?? t}: {n}
            </span>
          ))}
      </div>

      {data.total === 0 ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-6 text-center">
          <div className="text-2xl mb-1">✅</div>
          <div className="font-semibold text-emerald-300">Nada pendiente de ti ahora mismo</div>
          <div className="text-xs text-brand-muted mt-1">
            Si algo necesita acción humana, aparecerá aquí solo. No hace falta vigilar otras pestañas.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {data.items.map((item) => {
            const et = ETIQUETAS[item.type] ?? { label: item.type, cls: "" };
            const key = `${item.orderId}:${item.type}`;
            return (
              <div key={key} className="rounded-xl border border-brand-border/60 bg-brand-surface/60 p-3 md:p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold border ${et.cls}`}>{et.label}</span>
                  <span className="font-mono font-semibold text-brand-gold">#{item.orderNumber}</span>
                  <span className="text-sm">{item.customer}</span>
                  <span className="ml-auto text-[11px] text-brand-muted whitespace-nowrap">{hace(item.sinceAt)}</span>
                </div>
                <div className="mt-2 text-sm">{item.problem}</div>
                <div className="mt-1 text-sm text-brand-muted">
                  <span className="font-semibold text-brand-text">Qué hacer:</span> {item.whatToDo}
                </div>
                <div className="mt-2">
                  <button
                    onClick={() => void resolver(item)}
                    disabled={resolviendo === key}
                    className="px-3 py-1 rounded-lg text-xs font-semibold border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                  >
                    ✓ Marcar resuelto
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
