"use client";

// ============================================================
// CALCULADORA COD — la herramienta de rentabilidad de Pedro.
//
// TODO el cálculo corre EN EL CLIENTE con las funciones puras del dominio
// (pedro-model / real-model / break-even): mover un slider recalcula al
// instante, sin una sola petición. El servidor solo aporta datos reales
// (tasas, CPA, productos) y guarda escenarios.
//
// Simular NUNCA escribe: cambiar CPA, entrega o precio aquí no toca
// product_costs, ni settings, ni Shopify, ni Meta. Solo "Guardar
// escenario" persiste, y guarda un escenario — no configuración real.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { calculatePedroModel } from "@/lib/cod-calculator/pedro-model";
import { calculateRealCODModel } from "@/lib/cod-calculator/real-model";
import { computeBreakEven, computeCurve, computeSensitivityMatrix, marginOf, profitPerOrder, projectMonthly, trafficLight } from "@/lib/cod-calculator/break-even";
import type { CODCalculatorInputs, CODInputWithSource, CODModelType, CODScenario } from "@/lib/cod-calculator/types";
import { Card, Chip, EmptyState, ErrorState, GhostButton, ModalShell, PrimaryButton, SectionTitle, Skeleton, formatEuro } from "./ui";

interface AutoData {
  deliveryRate: CODInputWithSource;
  shippingRate: CODInputWithSource;
  cpa: CODInputWithSource;
  defaults: { outboundShippingCost: number; codFee: number; returnCost: number; vatRate: number; targetMargin: number; otherCostPerOrder: number };
  products: Array<{ sku: string; title: string; salePrice: number | null; productCost: number | null; handlingCost: number | null }>;
  minSample: number;
}

const SOURCE_LABEL: Record<string, string> = {
  meta_ads: "META ADS",
  real: "REAL",
  configured: "CONFIGURADO",
  manual: "MANUAL",
  simulation: "SIMULACIÓN",
  default: "DEFECTO",
};

const pct = (f: number | null, dec = 1) => (f === null ? "—" : `${(f * 100).toLocaleString("es-ES", { maximumFractionDigits: dec })}%`);
const eur = (n: number | null | undefined) => formatEuro(n ?? null);

export default function CodCalculatorPanel() {
  const [auto, setAuto] = useState<AutoData | null>(null);
  const [scenarios, setScenarios] = useState<CODScenario[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<CODModelType>("real");
  const [advanced, setAdvanced] = useState(false);
  const [inputs, setInputs] = useState<CODCalculatorInputs | null>(null);
  /** Campos que el usuario ha tocado → badge SIMULACIÓN. */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [targetMargin, setTargetMargin] = useState(0.1);
  const [sku, setSku] = useState<string>("");
  const [ordersPerDay, setOrdersPerDay] = useState(20);
  const [howOpen, setHowOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cod-calculator", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const j = (await res.json()) as { ok: boolean; auto: AutoData; scenarios: CODScenario[] };
      setAuto(j.auto);
      setScenarios(j.scenarios);
      setError(null);
      setTargetMargin(j.auto.defaults.targetMargin);
      setInputs((prev) =>
        prev ?? {
          salePrice: j.auto.products.find((p) => p.salePrice !== null)?.salePrice ?? 39.99,
          productCost: j.auto.products.find((p) => p.productCost !== null)?.productCost ?? 6.5,
          vatRate: j.auto.defaults.vatRate,
          rawCPA: j.auto.cpa.value ?? 5,
          shippingRate: j.auto.shippingRate.value ?? 0.9,
          deliveryRate: j.auto.deliveryRate.value ?? 0.7,
          outboundShippingCost: j.auto.defaults.outboundShippingCost,
          codFee: j.auto.defaults.codFee,
          returnCost: j.auto.defaults.returnCost,
          otherCostPerOrder: j.auto.defaults.otherCostPerOrder,
          returnedProductRecoveryRate: 0,
        }
      );
    } catch {
      setError("No se pudieron cargar los datos reales. La calculadora necesita al menos los costes por defecto.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof CODCalculatorInputs, v: number) => {
    setInputs((p) => (p ? { ...p, [k]: v } : p));
    setTouched((t) => new Set(t).add(k));
  };

  function applyPreset(kind: "real" | "conservador" | "optimista") {
    if (!inputs || !auto) return;
    if (kind === "real") {
      setInputs({
        ...inputs,
        rawCPA: auto.cpa.value ?? inputs.rawCPA,
        deliveryRate: auto.deliveryRate.value ?? inputs.deliveryRate,
        shippingRate: auto.shippingRate.value ?? inputs.shippingRate,
      });
      setTouched(new Set());
      return;
    }
    const signo = kind === "conservador" ? -1 : 1;
    setInputs({
      ...inputs,
      deliveryRate: Math.min(1, Math.max(0.01, inputs.deliveryRate + signo * 0.05)),
      rawCPA: Math.max(0, inputs.rawCPA * (kind === "conservador" ? 1.1 : 0.9)),
    });
    setTouched(new Set(["deliveryRate", "rawCPA"]));
  }

  const pedro = useMemo(() => (inputs ? calculatePedroModel(inputs) : null), [inputs]);
  const real = useMemo(() => (inputs ? calculateRealCODModel(inputs, 100) : null), [inputs]);
  const be = useMemo(() => (inputs ? computeBreakEven(model, inputs, targetMargin) : null), [inputs, model, targetMargin]);
  const light = useMemo(() => (inputs ? trafficLight(model, inputs, targetMargin) : null), [inputs, model, targetMargin]);
  const proj = useMemo(() => (inputs ? projectMonthly(model, inputs, ordersPerDay) : null), [inputs, model, ordersPerDay]);

  if (error && !auto) return <ErrorState message={error} onRetry={load} />;
  if (!inputs || !auto || !be || !light || !real)
    return (
      <div className="h-full overflow-y-auto px-4 md:px-8 py-5">
        <div className="max-w-5xl mx-auto space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
          <Skeleton className="h-56" />
        </div>
      </div>
    );

  const inputCls =
    "w-full rounded-lg border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-sm text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60";

  function SourceLine({ field, src }: { field: string; src?: CODInputWithSource }) {
    if (touched.has(field)) {
      return <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold bg-amber-500/15 text-amber-600 border border-amber-500/30">SIMULACIÓN</span>;
    }
    if (!src) return <span className="mt-1 block text-[10px] text-brand-muted">MANUAL</span>;
    const corta = src.sample !== null && src.sample !== undefined && src.sample > 0 && src.sample < auto!.minSample;
    return (
      <span className="mt-1 block text-[10px] text-brand-muted">
        {SOURCE_LABEL[src.source] ?? src.source} · {src.detail ?? "—"}
        {corta && <span className="text-amber-600"> · muestra pequeña (n={src.sample})</span>}
      </span>
    );
  }

  function NumField({ label, field, value, step = 0.01, src, hint }: { label: string; field: keyof CODCalculatorInputs; value: number; step?: number; src?: CODInputWithSource; hint?: string }) {
    return (
      <div>
        <label className="text-[10px] uppercase tracking-wider text-brand-muted" title={hint}>{label}</label>
        <input type="number" step={step} className={inputCls} value={value} onChange={(e) => set(field, parseFloat(e.target.value) || 0)} />
        <SourceLine field={field} src={src} />
      </div>
    );
  }

  function RateField({ label, field, value, min, src, hint }: { label: string; field: "deliveryRate" | "shippingRate"; value: number; min: number; src?: CODInputWithSource; hint?: string }) {
    return (
      <div>
        <label className="text-[10px] uppercase tracking-wider text-brand-muted" title={hint}>{label}</label>
        <div className="flex items-center gap-2">
          <input type="range" min={min} max={100} step={0.5} value={value * 100} onChange={(e) => set(field, parseFloat(e.target.value) / 100)} className="flex-1 accent-[color:var(--color-brand-gold)]" />
          <input type="number" step={0.5} className={`${inputCls} w-20`} value={Math.round(value * 1000) / 10} onChange={(e) => set(field, (parseFloat(e.target.value) || 0) / 100)} />
        </div>
        <SourceLine field={field} src={src} />
      </div>
    );
  }

  // Curvas de los simuladores.
  const curvaCPA = computeCurve(model, inputs, "rawCPA", Array.from({ length: 41 }, (_, i) => i * 0.5));
  const curvaEntrega = computeCurve(model, inputs, "deliveryRate", Array.from({ length: 61 }, (_, i) => 0.4 + i * 0.01));

  function MiniChart({ points, current, breakEvenX, xLabel }: { points: Array<{ x: number; profit: number | null }>; current: number; breakEvenX: number | null; xLabel: string }) {
    const vals = points.filter((p) => p.profit !== null);
    if (vals.length < 2) return <EmptyState title="Sin curva calculable" />;
    const xs = vals.map((v) => v.x);
    const ys = vals.map((v) => v.profit!);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys, 0), y1 = Math.max(...ys, 0);
    const W = 300, H = 110, pad = 6;
    const px = (x: number) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
    const py = (y: number) => H - pad - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * pad);
    const d = vals.map((v, i) => `${i === 0 ? "M" : "L"}${px(v.x).toFixed(1)},${py(v.profit!).toFixed(1)}`).join(" ");
    const curY = points.find((p) => Math.abs(p.x - current) < 1e-6)?.profit ?? null;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 110 }} role="img" aria-label={`Beneficio frente a ${xLabel}`}>
        <line x1={pad} y1={py(0)} x2={W - pad} y2={py(0)} stroke="currentColor" className="text-brand-border" strokeWidth="1" />
        <path d={d} fill="none" stroke="currentColor" className="text-brand-gold" strokeWidth="1.6" />
        {breakEvenX !== null && breakEvenX >= x0 && breakEvenX <= x1 && (
          <line x1={px(breakEvenX)} y1={pad} x2={px(breakEvenX)} y2={H - pad} stroke="currentColor" className="text-red-600" strokeWidth="1" strokeDasharray="3 3">
            <title>break-even</title>
          </line>
        )}
        {curY !== null && <circle cx={px(current)} cy={py(curY)} r="3" className="fill-brand-gold" />}
      </svg>
    );
  }

  // Matriz de sensibilidad centrada en el CPA actual.
  const cpaBase = Math.max(2, Math.round(inputs.rawCPA));
  const cpas = [cpaBase - 2, cpaBase - 1, cpaBase, cpaBase + 1, cpaBase + 2].filter((c) => c >= 0);
  const entregas = [0.6, 0.65, 0.7, 0.75, 0.8];
  const matriz = computeSensitivityMatrix(model, inputs, cpas, entregas);

  const productosComparables = auto.products.filter((p) => p.salePrice !== null && p.productCost !== null);

  async function guardarEscenario() {
    setBusy(true);
    try {
      const res = await fetch("/api/cod-calculator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_scenario", name: saveName, productSku: sku || null, modelType: model, assumptions: inputs }),
      });
      const j = (await res.json()) as { ok: boolean; scenarios?: CODScenario[] };
      if (j.ok && j.scenarios) setScenarios(j.scenarios);
      setSaveOpen(false);
      setSaveName("");
    } finally {
      setBusy(false);
    }
  }

  async function escenarioAccion(action: "duplicate_scenario" | "delete_scenario", id: number) {
    const res = await fetch("/api/cod-calculator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const j = (await res.json()) as { ok: boolean; scenarios?: CODScenario[] };
    if (j.scenarios) setScenarios(j.scenarios);
  }

  const lightCls =
    light.light === "green" ? "text-emerald-600" : light.light === "amber" ? "text-amber-600" : light.light === "red" ? "text-red-600" : "text-brand-muted";

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Cabecera + modelo */}
        <div>
          <SectionTitle
            right={
              <div className="flex gap-1.5">
                <Chip active={model === "real"} onClick={() => setModel("real")}>Modelo Real</Chip>
                <Chip active={model === "pedro"} onClick={() => setModel("pedro")}>Modelo Pedro</Chip>
              </div>
            }
          >
            Calculadora COD
          </SectionTitle>
          {model === "pedro" && (
            <p className="text-[11px] text-brand-muted -mt-1">
              Replica exactamente tu calculadora original (IVA sobre el coste, ajuste ×0,8). No constituye cálculo fiscal.
            </p>
          )}
        </div>

        {/* Producto + presets */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${inputCls} w-auto`}
            value={sku}
            onChange={(e) => {
              const s = e.target.value;
              setSku(s);
              const p = auto.products.find((x) => x.sku === s);
              if (p) {
                setInputs((prev) => (prev ? { ...prev, salePrice: p.salePrice ?? prev.salePrice, productCost: p.productCost ?? prev.productCost } : prev));
              }
            }}
          >
            <option value="">Producto libre</option>
            {auto.products.map((p) => (
              <option key={p.sku} value={p.sku}>{p.title} ({p.sku})</option>
            ))}
          </select>
          <GhostButton onClick={() => applyPreset("real")}>Datos reales</GhostButton>
          <GhostButton onClick={() => applyPreset("conservador")}>Conservador</GhostButton>
          <GhostButton onClick={() => applyPreset("optimista")}>Optimista</GhostButton>
        </div>

        {/* RESULTADO */}
        <Card className="p-5">
          <div className={`font-display text-2xl font-bold ${lightCls}`}>{light.headline}</div>
          <div className="text-sm text-brand-muted mt-0.5">{light.detail}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-brand-muted">Profit / pedido</div>
              <div className={`text-xl font-semibold font-display ${(profitPerOrder(model, inputs) ?? 0) < 0 ? "text-red-600" : "text-brand-text"}`}>{eur(profitPerOrder(model, inputs))}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-brand-muted">Margen</div>
              <div className="text-xl font-semibold font-display text-brand-text">{pct(marginOf(model, inputs), 2)}</div>
            </div>
            {model === "pedro" ? (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-brand-muted">CPA real</div>
                  <div className="text-xl font-semibold font-display text-brand-text">{eur(pedro?.realCPA ?? null)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-brand-muted">ROI</div>
                  <div className="text-xl font-semibold font-display text-brand-text">{pct(pedro?.roi ?? null, 2)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-brand-muted" title="Replica el cálculo original. No constituye cálculo fiscal.">Tras ajuste 20% (Excel)</div>
                  <div className="text-xl font-semibold font-display text-brand-text">{eur(pedro?.afterIrpf ?? null)}</div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-brand-muted">Profit / enviado</div>
                  <div className="text-xl font-semibold font-display text-brand-text">{eur(real.profitPerSent)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-brand-muted">Profit / entregado</div>
                  <div className="text-xl font-semibold font-display text-brand-text">{eur(real.profitPerDelivered)}</div>
                </div>
              </>
            )}
          </div>
          <div className="mt-3">
            <GhostButton onClick={() => setHowOpen(true)}>¿Cómo se calcula?</GhostButton>
          </div>
        </Card>

        {/* INPUTS */}
        <Card className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumField label="Precio venta €" field="salePrice" value={inputs.salePrice} />
            <NumField label="Coste producto €" field="productCost" value={inputs.productCost} />
            <NumField label="CPA pedido €" field="rawCPA" value={inputs.rawCPA} src={auto.cpa} hint="Coste publicitario por pedido recibido antes de ajustar por envío/entrega." />
            <RateField label="% Entrega" field="deliveryRate" value={inputs.deliveryRate} min={40} src={auto.deliveryRate} />
          </div>
          <div>
            <Chip active={advanced} onClick={() => setAdvanced(!advanced)}>Avanzado</Chip>
          </div>
          {advanced && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
              <RateField label="% Envío" field="shippingRate" value={inputs.shippingRate} min={50} src={auto.shippingRate} />
              <NumField label="Envío €" field="outboundShippingCost" value={inputs.outboundShippingCost} />
              <NumField label="COD €" field="codFee" value={inputs.codFee} />
              <NumField label="Devolución €" field="returnCost" value={inputs.returnCost} />
              <NumField label="IVA (fracción)" field="vatRate" value={inputs.vatRate} hint="El Modelo Pedro lo aplica AL COSTE del producto, como el Excel." />
              <NumField label="Otros costes €" field="otherCostPerOrder" value={inputs.otherCostPerOrder ?? 0} />
              <NumField label="Recuperación devuelto" field="returnedProductRecoveryRate" value={inputs.returnedProductRecoveryRate ?? 0} hint="Qué parte del coste del producto recuperas cuando vuelve. 0 = pérdida completa." />
              <div>
                <label className="text-[10px] uppercase tracking-wider text-brand-muted">Margen objetivo %</label>
                <input type="number" step={1} className={inputCls} value={Math.round(targetMargin * 1000) / 10} onChange={(e) => setTargetMargin((parseFloat(e.target.value) || 0) / 100)} />
              </div>
            </div>
          )}
        </Card>

        {/* POR CADA 100 PEDIDOS */}
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted mb-2">Por cada 100 pedidos</div>
          <div className="text-sm text-brand-text mb-1">
            100 pedidos → <strong>{real.sent}</strong> enviados → <strong>{real.delivered}</strong> entregados
          </div>
          <div className="text-xs text-brand-muted mb-3">{(100 - real.delivered).toFixed(0)} se pierden por el camino (no enviados o no entregados)</div>
          <div className="space-y-1 text-sm max-w-md">
            {[
              ["Facturación", real.revenue, false],
              ["Ads", real.ads, true],
              ["Producto", real.productCost, true],
              ["Logística (envío ida)", real.outboundShipping, true],
              ["COD", real.codFees, true],
              ["Devoluciones", real.returnCosts, true],
              ["Otros", real.otherCosts, true],
            ].map(([label, val, neg]) => (
              <div key={label as string} className="flex justify-between">
                <span className="text-brand-muted">{label as string}</span>
                <span className={neg ? "text-red-600" : "text-brand-text"}>{neg ? `(${eur(val as number)})` : eur(val as number)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-brand-border pt-1.5 font-semibold">
              <span className="text-brand-text">BENEFICIO</span>
              <span className={real.profit100 >= 0 ? "text-emerald-600" : "text-red-600"}>{eur(real.profit100)}</span>
            </div>
          </div>
          {model === "pedro" && <div className="mt-2 text-[11px] text-brand-muted">Calculado por evento (Modelo Real): el Modelo Pedro no descompone el embudo.</div>}
        </Card>

        {/* BREAK-EVEN */}
        <Card className="p-4 space-y-1.5 text-sm">
          <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted mb-1">Break-even</div>
          <div className="text-brand-muted">Entrega break-even: <strong className="text-brand-text">{pct(be.deliveryRateBreakEven)}</strong> — por debajo pierdes dinero.</div>
          <div className="text-brand-muted">CPA máximo: <strong className="text-brand-text">{eur(be.cpaBreakEven)}</strong> — más caro que esto y pierdes.</div>
          <div className="text-brand-muted">Precio mínimo: <strong className="text-brand-text">{eur(be.minSalePrice)}</strong>.</div>
          <div className="text-brand-muted">Coste de producto máximo: <strong className="text-brand-text">{eur(be.maxProductCost)}</strong>.</div>
          <div className="text-brand-muted pt-1">
            Para un margen del {pct(targetMargin, 0)}: entrega ≥ <strong className="text-brand-text">{pct(be.deliveryForTargetMargin)}</strong> · CPA ≤ <strong className="text-brand-text">{eur(be.cpaForTargetMargin)}</strong>.
          </div>
        </Card>

        {/* SENSIBILIDAD */}
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted mb-2">Sensibilidad · beneficio por pedido</div>
          <div className="overflow-x-auto">
            <table className="text-xs min-w-[420px]">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-brand-muted">CPA \ Entrega</th>
                  {entregas.map((d) => (
                    <th key={d} className="px-2 py-1 text-brand-muted font-normal">{pct(d, 0)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matriz.map((fila, i) => (
                  <tr key={cpas[i]}>
                    <td className="px-2 py-1 text-brand-muted whitespace-nowrap">{eur(cpas[i])}</td>
                    {fila.map((c, j) => {
                      const v = c.profitPerOrder;
                      const bg = v === null ? "" : v > 2 ? "bg-emerald-500/25" : v > 0 ? "bg-emerald-500/10" : v > -2 ? "bg-red-500/10" : "bg-red-500/25";
                      return (
                        <td key={j} className={`px-2 py-1 text-center ${bg}`} title={v === null ? "—" : `${v.toFixed(2)} € por pedido`}>
                          {v === null ? "—" : v.toFixed(1)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* SIMULADORES */}
        <div className="grid md:grid-cols-2 gap-3">
          <Card className="p-4">
            <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted mb-1">Beneficio según CPA</div>
            <MiniChart points={curvaCPA} current={inputs.rawCPA} breakEvenX={be.cpaBreakEven} xLabel="CPA" />
            <div className="text-[10px] text-brand-muted">Línea roja: CPA de equilibrio ({eur(be.cpaBreakEven)}).</div>
          </Card>
          <Card className="p-4">
            <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted mb-1">Beneficio según tasa de entrega</div>
            <MiniChart points={curvaEntrega} current={inputs.deliveryRate} breakEvenX={be.deliveryRateBreakEven} xLabel="entrega" />
            <div className="text-[10px] text-brand-muted">Línea roja: entrega de equilibrio ({pct(be.deliveryRateBreakEven)}).</div>
          </Card>
        </div>

        {/* PROYECCIÓN */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted">Proyección</div>
            <input type="number" className={`${inputCls} w-24`} value={ordersPerDay} onChange={(e) => setOrdersPerDay(Math.max(0, parseInt(e.target.value, 10) || 0))} />
            <span className="text-xs text-brand-muted">pedidos/día</span>
            {[20, 50, 100].map((n) => (
              <Chip key={n} active={ordersPerDay === n} onClick={() => setOrdersPerDay(n)}>{n}/día</Chip>
            ))}
          </div>
          {proj && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              <div><span className="text-brand-muted text-xs block">Pedidos/mes</span>{proj.ordersPerMonth}</div>
              <div><span className="text-brand-muted text-xs block">Enviados</span>{proj.sentPerMonth}</div>
              <div><span className="text-brand-muted text-xs block">Entregados</span>{proj.deliveredPerMonth}</div>
              <div><span className="text-brand-muted text-xs block">Facturación</span>{eur(proj.revenue)}</div>
              <div><span className="text-brand-muted text-xs block">Ads</span>{eur(proj.ads)}</div>
              <div>
                <span className="text-brand-muted text-xs block">Beneficio/mes</span>
                <span className={(proj.profitPerMonth ?? 0) >= 0 ? "text-emerald-600" : "text-red-600"}>{eur(proj.profitPerMonth)}</span>
              </div>
            </div>
          )}
          <div className="mt-2 text-[11px] text-brand-muted">{proj?.note}</div>
        </Card>

        {/* ESCENARIOS */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted">Escenarios</div>
            <PrimaryButton onClick={() => setSaveOpen(true)}>Guardar escenario</PrimaryButton>
          </div>
          {scenarios.length === 0 ? (
            <div className="text-xs text-brand-muted">Ninguno guardado todavía. Guardar un escenario no cambia ningún dato real.</div>
          ) : (
            <div className="space-y-1.5">
              {scenarios.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-2">
                  <Chip
                    onClick={() => {
                      try {
                        setInputs(JSON.parse(s.assumptions_json) as CODCalculatorInputs);
                        setModel(s.model_type);
                        setTouched(new Set(["salePrice"]));
                      } catch {
                        /* escenario ilegible */
                      }
                    }}
                  >
                    {s.name}
                  </Chip>
                  <span className="text-[10px] text-brand-muted">{s.model_type === "pedro" ? "Modelo Pedro" : "Modelo Real"}</span>
                  <GhostButton onClick={() => void escenarioAccion("duplicate_scenario", s.id)}>Duplicar</GhostButton>
                  <GhostButton onClick={() => void escenarioAccion("delete_scenario", s.id)}>Eliminar</GhostButton>
                </div>
              ))}
            </div>
          )}
          {/* REAL vs ESCENARIO */}
          {(auto.cpa.value !== null || auto.deliveryRate.value !== null) && (
            <div className="mt-4 overflow-x-auto">
              <table className="text-xs min-w-[360px] w-full">
                <thead>
                  <tr className="text-brand-muted">
                    <th className="text-left px-2 py-1 font-normal"></th>
                    <th className="px-2 py-1 font-normal">REAL</th>
                    <th className="px-2 py-1 font-normal">ESCENARIO</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const realInputs: CODCalculatorInputs = {
                      ...inputs,
                      rawCPA: auto.cpa.value ?? inputs.rawCPA,
                      deliveryRate: auto.deliveryRate.value ?? inputs.deliveryRate,
                      shippingRate: auto.shippingRate.value ?? inputs.shippingRate,
                    };
                    const filas: Array<[string, string, string]> = [
                      ["CPA", eur(realInputs.rawCPA), eur(inputs.rawCPA)],
                      ["Entrega", pct(realInputs.deliveryRate), pct(inputs.deliveryRate)],
                      ["Margen", pct(marginOf(model, realInputs), 2), pct(marginOf(model, inputs), 2)],
                      ["Profit / 100", eur(calculateRealCODModel(realInputs, 100).profit100), eur(real.profit100)],
                    ];
                    return filas.map(([k, a, b]) => (
                      <tr key={k} className="border-t border-brand-border/50">
                        <td className="px-2 py-1 text-brand-muted">{k}</td>
                        <td className="px-2 py-1 text-center text-brand-text">{a}</td>
                        <td className="px-2 py-1 text-center text-brand-gold">{b}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* COMPARADOR */}
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-brand-muted mb-2">Comparar productos</div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {productosComparables.map((p) => (
              <Chip
                key={p.sku}
                active={compare.includes(p.sku)}
                onClick={() => setCompare((c) => (c.includes(p.sku) ? c.filter((x) => x !== p.sku) : c.length < 4 ? [...c, p.sku] : c))}
              >
                {p.title}
              </Chip>
            ))}
          </div>
          {compare.length < 2 ? (
            <div className="text-xs text-brand-muted">Selecciona al menos dos productos (máximo 4) para compararlos con las tasas y el CPA actuales.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs min-w-[560px] w-full">
                <thead>
                  <tr className="text-brand-muted">
                    {["Producto", "Precio", "Coste", "Profit/pedido", "Margen", "BE CPA", "BE entrega"].map((h) => (
                      <th key={h} className="px-2 py-1 text-left font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {compare.map((s) => {
                    const p = productosComparables.find((x) => x.sku === s)!;
                    const ins = { ...inputs, salePrice: p.salePrice!, productCost: p.productCost! };
                    const b = computeBreakEven(model, ins, targetMargin);
                    return (
                      <tr key={s} className="border-t border-brand-border/50">
                        <td className="px-2 py-1 text-brand-text">{p.title}</td>
                        <td className="px-2 py-1">{eur(p.salePrice)}</td>
                        <td className="px-2 py-1">{eur(p.productCost)}</td>
                        <td className={`px-2 py-1 ${(profitPerOrder(model, ins) ?? 0) < 0 ? "text-red-600" : "text-emerald-600"}`}>{eur(profitPerOrder(model, ins))}</td>
                        <td className="px-2 py-1">{pct(marginOf(model, ins), 1)}</td>
                        <td className="px-2 py-1">{eur(b.cpaBreakEven)}</td>
                        <td className="px-2 py-1">{pct(b.deliveryRateBreakEven)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* ¿Cómo se calcula? */}
      <ModalShell open={howOpen} onClose={() => setHowOpen(false)} title="¿Cómo se calcula?">
        {model === "real" ? (
          <div className="text-sm text-brand-muted space-y-1">
            <p className="text-brand-text mb-2">Modelo Real, por cada 100 pedidos creados:</p>
            <div>Ingresos {eur(real.revenue)} (solo los {real.delivered} entregados)</div>
            <div>− Ads {eur(real.ads)} (100 pedidos × {eur(inputs.rawCPA)})</div>
            <div>− Producto {eur(real.productCost)} ({real.sent} enviados)</div>
            <div>− Envío {eur(real.outboundShipping)} · COD {eur(real.codFees)} · Devoluciones {eur(real.returnCosts)}</div>
            <div className="text-brand-text pt-1">= Beneficio {eur(real.profit100)} → {eur(real.profitPerOrder)} por pedido creado</div>
            <p className="pt-2 text-[11px]">{real.fiscalNote}</p>
          </div>
        ) : (
          <div className="text-sm text-brand-muted space-y-1">
            <p className="text-brand-text mb-2">Modelo Pedro (fórmulas del Excel original):</p>
            <div>IVA = coste × {inputs.vatRate} = {eur(pedro?.vat ?? null)}</div>
            <div>CPA real = {eur(inputs.rawCPA)} / ({pct(inputs.shippingRate)} × {pct(inputs.deliveryRate)}) = {eur(pedro?.realCPA ?? null)}</div>
            <div>Gastos envío = {eur(inputs.outboundShippingCost)} + COD×entrega + (1−entrega)×devolución = {eur(pedro?.expectedShippingCost ?? null)}</div>
            <div className="text-brand-text pt-1">Profit = (precio − coste − IVA − CPA real − gastos) × entrega = {eur(pedro?.profit ?? null)}</div>
            <p className="pt-2 text-[11px]">El ajuste ×0,8 replica el cálculo original. No constituye cálculo fiscal.</p>
          </div>
        )}
      </ModalShell>

      {/* Guardar escenario */}
      <ModalShell open={saveOpen} onClose={() => setSaveOpen(false)} title="Guardar escenario">
        <p className="text-sm text-brand-muted mb-3">Guarda estos supuestos con un nombre. No cambia ningún dato real del sistema.</p>
        <input className={inputCls} placeholder='p.ej. "PELUCHE CPA 6€"' value={saveName} onChange={(e) => setSaveName(e.target.value)} />
        <div className="flex justify-end gap-2 mt-4">
          <GhostButton onClick={() => setSaveOpen(false)}>Cancelar</GhostButton>
          <PrimaryButton busy={busy} disabled={!saveName.trim()} onClick={() => void guardarEscenario()}>Guardar</PrimaryButton>
        </div>
      </ModalShell>
    </div>
  );
}
