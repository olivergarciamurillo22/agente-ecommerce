"use client";

// ============================================================
// COSTES por SKU (§37-§38). Editor de product_costs.
// Cada cambio se versiona en product_cost_history: el histórico nunca se
// sobrescribe, para poder calcular P&L de periodos pasados con los costes
// que regían entonces.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, ErrorState, GhostButton, ModalShell, PrimaryButton, SectionTitle, SkeletonRows, formatEuro } from "./ui";

interface CostRow {
  sku: string;
  title: string | null;
  product_cost: number | null;
  shipping_cost: number | null;
  cod_fee: number | null;
  handling_cost: number | null;
  updated_at: number;
}

type Draft = { sku: string; title: string; product_cost: string; shipping_cost: string; cod_fee: string; handling_cost: string };

const emptyDraft = (): Draft => ({ sku: "", title: "", product_cost: "", shipping_cost: "", cod_fee: "", handling_cost: "" });

const toDraft = (c: CostRow): Draft => ({
  sku: c.sku,
  title: c.title ?? "",
  product_cost: c.product_cost?.toString() ?? "",
  shipping_cost: c.shipping_cost?.toString() ?? "",
  cod_fee: c.cod_fee?.toString() ?? "",
  handling_cost: c.handling_cost?.toString() ?? "",
});

const numOrNull = (s: string): number | null => {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const FIELDS: Array<{ key: keyof Draft; label: string }> = [
  { key: "product_cost", label: "Producto €" },
  { key: "shipping_cost", label: "Envío €" },
  { key: "cod_fee", label: "COD €" },
  { key: "handling_cost", label: "Manipulación €" },
];

export default function CostsPanel() {
  const [costs, setCosts] = useState<CostRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteSku, setDeleteSku] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/system/costs", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { costs: CostRow[] };
      setCosts(j.costs);
      setError(null);
    } catch {
      setError("No se pudieron cargar los costes.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(d: Draft) {
    if (!d.sku.trim()) {
      setSaveError("El SKU es obligatorio.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/system/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: d.sku.trim(),
          title: d.title.trim() || null,
          product_cost: numOrNull(d.product_cost),
          shipping_cost: numOrNull(d.shipping_cost),
          cod_fee: numOrNull(d.cod_fee),
          handling_cost: numOrNull(d.handling_cost),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) {
        setSaveError(j.error ?? "No se pudo guardar.");
        return;
      }
      setEditing(null);
      setAdding(null);
      await refresh();
    } catch {
      setSaveError("No se pudo contactar con el servidor.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(sku: string) {
    setSaving(true);
    try {
      await fetch(`/api/system/costs?sku=${encodeURIComponent(sku)}`, { method: "DELETE" });
      await refresh();
    } catch {
      setSaveError("No se pudo borrar.");
    } finally {
      setSaving(false);
      setDeleteSku(null);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-sm text-brand-text placeholder:text-brand-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60";

  function DraftForm({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <input
          className={inputCls}
          placeholder="SKU"
          value={draft.sku}
          disabled={editing !== null && draft === editing}
          onChange={(e) => onChange({ ...draft, sku: e.target.value })}
        />
        <input className={inputCls} placeholder="Nombre" value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
        {FIELDS.map((f) => (
          <input
            key={f.key}
            className={inputCls}
            placeholder={f.label}
            inputMode="decimal"
            value={draft[f.key]}
            onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        <SectionTitle
          right={
            !adding ? (
              <GhostButton onClick={() => { setAdding(emptyDraft()); setSaveError(null); }}>Añadir producto</GhostButton>
            ) : null
          }
        >
          Costes por producto
        </SectionTitle>
        <p className="text-xs text-brand-muted -mt-2">
          Cada cambio se versiona: el histórico de costes nunca se sobrescribe, para que el P&amp;L de un mes pasado use los costes que regían entonces.
        </p>

        {saveError && <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600">{saveError}</div>}

        {adding && (
          <Card className="p-4 space-y-3">
            <div className="text-sm text-brand-text">Nuevo producto</div>
            <DraftForm draft={adding} onChange={setAdding} />
            <div className="flex justify-end gap-2">
              <GhostButton onClick={() => setAdding(null)}>Cancelar</GhostButton>
              <PrimaryButton busy={saving} onClick={() => void save(adding)}>Guardar</PrimaryButton>
            </div>
          </Card>
        )}

        {error && !costs ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : !costs ? (
          <SkeletonRows rows={4} />
        ) : costs.length === 0 && !adding ? (
          <Card>
            <EmptyState
              title="Sin costes configurados"
              hint="Sin el coste de cada SKU, Finanzas no puede calcular el margen ni la calculadora el break-even."
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {costs.map((c) =>
              editing?.sku === c.sku ? (
                <Card key={c.sku} className="p-4 space-y-3">
                  <DraftForm draft={editing} onChange={setEditing} />
                  <div className="flex justify-end gap-2">
                    <GhostButton onClick={() => setEditing(null)}>Cancelar</GhostButton>
                    <PrimaryButton busy={saving} onClick={() => void save(editing)}>Guardar</PrimaryButton>
                  </div>
                </Card>
              ) : (
                <Card key={c.sku} className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                  <div className="min-w-[140px]">
                    <div className="font-mono text-sm text-brand-gold">{c.sku}</div>
                    <div className="text-xs text-brand-muted truncate">{c.title ?? "—"}</div>
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs flex-1">
                    <span className="text-brand-muted">Producto <span className="text-brand-text">{formatEuro(c.product_cost)}</span></span>
                    <span className="text-brand-muted">Envío <span className="text-brand-text">{formatEuro(c.shipping_cost)}</span></span>
                    <span className="text-brand-muted">COD <span className="text-brand-text">{formatEuro(c.cod_fee)}</span></span>
                    <span className="text-brand-muted">Manipulación <span className="text-brand-text">{formatEuro(c.handling_cost)}</span></span>
                  </div>
                  <div className="flex gap-2">
                    <GhostButton onClick={() => { setEditing(toDraft(c)); setSaveError(null); }}>Editar</GhostButton>
                    <GhostButton onClick={() => setDeleteSku(c.sku)}>Borrar</GhostButton>
                  </div>
                </Card>
              )
            )}
          </div>
        )}
      </div>

      <ModalShell open={deleteSku !== null} onClose={() => setDeleteSku(null)} title="Borrar coste">
        <p className="text-sm text-brand-muted mb-4">
          Se borra el coste vigente del SKU <strong className="text-brand-text">{deleteSku}</strong>. El histórico ya registrado se conserva, pero Finanzas dejará de poder costear ese producto.
        </p>
        <div className="flex justify-end gap-2">
          <GhostButton onClick={() => setDeleteSku(null)}>Cancelar</GhostButton>
          <PrimaryButton danger busy={saving} onClick={() => deleteSku && void remove(deleteSku)}>Borrar</PrimaryButton>
        </div>
      </ModalShell>
    </div>
  );
}
