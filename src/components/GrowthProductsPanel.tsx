"use client";

// Growth › Productos (§10): rendimiento por producto con datos REALES de
// Finanzas (enviados, entregados, tasa, facturación entregada). Margen y
// evolución solo cuando existan costes configurados — si no, lo dice.
import { useCallback, useEffect, useState } from "react";
import type { DockView } from "./NavRail";
import { Card, Chip, EmptyState, ErrorState, SectionTitle, SkeletonRows, StatusDot, formatEuro, formatInt, formatPct, type UiStatus } from "./ui";

interface ProductRow {
  sku: string;
  title: string;
  shipped: number;
  delivered: number;
  refused: number;
  deliveryRate: number | null;
  deliveredRevenue: number;
}

interface FinanceData {
  ok: boolean;
  data?: { products: ProductRow[]; window: { deliveredOrders: number; missing: string[] } };
}

const PRESETS = [
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
  { id: "month", label: "Mes" },
] as const;

function rateStatus(r: number | null): UiStatus {
  if (r === null) return "muted";
  if (r >= 70) return "ok";
  if (r >= 65) return "warn";
  return "error";
}

function nextAction(p: ProductRow): string {
  if (p.deliveryRate === null) return "Sin cierres conocidos: esperar datos";
  if (p.deliveryRate < 65) return "Por debajo del break-even típico: revisar confirmación y CPA";
  if (p.refused >= 3 && p.refused / Math.max(1, p.shipped) > 0.3) return "Muchos rehúses: reforzar el recordatorio de efectivo";
  return "Mantener";
}

export default function GrowthProductsPanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("30d");
  const [data, setData] = useState<FinanceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/finance?preset=${preset}`, { cache: "no-store" });
      const j = (await r.json()) as FinanceData;
      if (!j.ok || !j.data) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudo cargar el rendimiento por producto.");
    }
  }, [preset]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const products = data?.data?.products ?? [];
  const faltanCostes = (data?.data?.window.missing ?? []).some((m) => /coste|SKU/i.test(m));

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-brand-text">Productos</h1>
            <p className="mt-1 text-sm text-brand-muted">Pedidos enviados, entregados y rehusados por producto, con la facturación realmente cobrada.</p>
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map((p) => (
              <Chip key={p.id} active={preset === p.id} onClick={() => setPreset(p.id)}>{p.label}</Chip>
            ))}
          </div>
        </div>

        {error && !data ? (
          <ErrorState message={error} onRetry={load} />
        ) : !data ? (
          <SkeletonRows rows={5} />
        ) : products.length === 0 ? (
          <Card>
            <EmptyState title="Sin envíos en el periodo." hint="Cuando haya pedidos enviados con producto identificado, aparecerán aquí con su tasa de entrega real." />
          </Card>
        ) : (
          <>
            {faltanCostes && (
              <Card className="px-4 py-3 text-sm text-brand-muted flex flex-wrap items-center gap-2">
                <StatusDot status="warn" /> Sin costes configurados no se puede calcular el margen por producto.
                <button type="button" className="text-brand-gold underline-offset-2 hover:underline" onClick={() => onNavigate("finance")}>Configurar costes →</button>
              </Card>
            )}
            {/* Escritorio: tabla · Móvil: tarjetas */}
            <Card className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
                    <th className="px-4 py-2.5 font-medium">Producto</th>
                    <th className="px-4 py-2.5 font-medium text-right">Enviados</th>
                    <th className="px-4 py-2.5 font-medium text-right">Entregados</th>
                    <th className="px-4 py-2.5 font-medium text-right">Rehusados</th>
                    <th className="px-4 py-2.5 font-medium text-right">Entrega</th>
                    <th className="px-4 py-2.5 font-medium text-right">Fact. entregada</th>
                    <th className="px-4 py-2.5 font-medium">Siguiente acción</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.sku} className="border-b border-brand-border/60 last:border-0">
                      <td className="px-4 py-3">
                        <div className="text-brand-text">{p.title}</div>
                        <div className="text-[11px] text-brand-muted font-mono">{p.sku}</div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInt(p.shipped)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInt(p.delivered)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatInt(p.refused)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1.5"><StatusDot status={rateStatus(p.deliveryRate)} />{formatPct(p.deliveryRate)}</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatEuro(p.deliveredRevenue)}</td>
                      <td className="px-4 py-3 text-xs text-brand-muted">{nextAction(p)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="md:hidden space-y-2">
              {products.map((p) => (
                <Card key={p.sku} className="px-4 py-3">
                  <div className="text-sm text-brand-text">{p.title}</div>
                  <div className="mt-1 grid grid-cols-3 gap-2 text-xs text-brand-muted">
                    <div>Enviados <span className="block text-brand-text text-sm tabular-nums">{formatInt(p.shipped)}</span></div>
                    <div>Entrega <span className="block text-brand-text text-sm tabular-nums">{formatPct(p.deliveryRate)}</span></div>
                    <div>Cobrado <span className="block text-brand-text text-sm tabular-nums">{formatEuro(p.deliveredRevenue)}</span></div>
                  </div>
                  <div className="mt-2 text-xs text-brand-muted">{nextAction(p)}</div>
                </Card>
              ))}
            </div>
            <SectionTitle>Rentabilidad</SectionTitle>
            <Card className="px-4 py-3 text-sm text-brand-muted">
              Para simular precio, CPA y entrega por producto, usa la <button type="button" className="text-brand-gold underline-offset-2 hover:underline" onClick={() => onNavigate("finance")}>Calculadora COD</button>.
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
