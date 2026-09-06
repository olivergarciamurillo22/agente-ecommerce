"use client";

// AI Winner Radar — pantalla principal.
//
// Tres vistas dentro de la pestaña del Cazador: buscar, oportunidades y
// vigilancia. Se integra en el Cazador existente (§43) en vez de crear un
// módulo aparte: el pipeline de Pedro (descubierto → … → ganador) sigue donde
// estaba y esto es lo que lo alimenta.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { HunterFilters, ProductOpportunity, SearchRun } from "@/lib/hunter/types";
import type { RadarReadiness } from "@/lib/hunter/providers/registry";
import { Badge, FixtureBanner, ScoreChip, Stat, money, pct } from "./radar-shared";
import OpportunityDetail from "./OpportunityDetail";
import SaturationMatrix from "./SaturationMatrix";

type Vista = "buscar" | "oportunidades" | "vigilancia";
type Orden = "opportunity" | "momentum" | "saturation" | "casamable" | "profit" | "newest" | "confidence";

const PRESETS: Array<{ id: string; label: string; prompt: string }> = [
  { id: "cod-es", label: "COD España", prompt: "Productos para España con pago contrareembolso, ticket 25-55 €, coste de proveedor menor de 12 €, sin tallas y no frágiles." },
  { id: "high-margin", label: "Margen alto", prompt: "Productos con precio 40-70 € y coste de proveedor menor de 10 € para España, fáciles de demostrar en vídeo." },
  { id: "early", label: "Tendencia temprana", prompt: "Productos con pocos anunciantes y saturación baja en España, mínimo 14 días con anuncios activos." },
  { id: "low-sat", label: "Baja saturación", prompt: "Productos de hogar para España con saturación baja y poca competencia." },
  { id: "pet", label: "Mascotas", prompt: "Productos de mascotas para España, contrareembolso, 25-50 €, no frágiles." },
  { id: "home", label: "Hogar", prompt: "Productos de hogar para España, contrareembolso, 25-55 €, que se entiendan en 3 segundos." },
  { id: "car", label: "Coche", prompt: "Accesorios de coche para España, contrareembolso, 25-55 €, sin electrónica compleja." },
];

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const b = (await r.json()) as Record<string, unknown>;
    if (!r.ok || b.ok === false) return { ok: false, error: String(b.error ?? `error ${r.status}`) };
    return { ok: true, data: b as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fallo de red" };
  }
}

export default function WinnerRadar() {
  const [vista, setVista] = useState<Vista>("buscar");
  const [readiness, setReadiness] = useState<RadarReadiness | null>(null);
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<{ filters: HunterFilters; queries: string[]; aiUsed: boolean } | null>(null);
  const [run, setRun] = useState<SearchRun | null>(null);
  const [ops, setOps] = useState<ProductOpportunity[]>([]);
  const [detalle, setDetalle] = useState<ProductOpportunity | null>(null);
  const [orden, setOrden] = useState<Orden>("opportunity");
  const [modo, setModo] = useState<"tarjetas" | "tabla" | "matriz">("tarjetas");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargarEstado = useCallback(async () => {
    const r = await api<{ readiness: RadarReadiness }>("/api/hunter");
    if (r.ok) setReadiness(r.data.readiness);
    else setError(r.error);
  }, []);

  useEffect(() => {
    void cargarEstado();
  }, [cargarEstado]);

  // Mientras la búsqueda corre en segundo plano se pregunta por su progreso.
  // Se para en cuanto termina: dejar un intervalo vivo es como se acaban
  // haciendo cientos de peticiones inútiles con la pestaña abierta.
  useEffect(() => {
    if (!run || (run.state !== "running" && run.state !== "queued")) return;
    const t = setInterval(async () => {
      const r = await api<{ run: SearchRun; opportunities: ProductOpportunity[] }>(`/api/hunter/search?id=${run.id}`);
      if (r.ok) {
        setRun(r.data.run);
        setOps(r.data.opportunities);
        if (r.data.run.state !== "running" && r.data.run.state !== "queued") {
          setCargando(false);
          setVista("oportunidades");
        }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [run]);

  const analizar = async () => {
    setError(null);
    const r = await api<{ filters: HunterFilters; queries: string[]; aiUsed: boolean }>("/api/hunter/search?dryRun=1", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    if (r.ok) setPlan({ filters: r.data.filters, queries: r.data.queries, aiUsed: r.data.aiUsed });
    else setError(r.error);
  };

  const buscar = async () => {
    setError(null);
    setCargando(true);
    setOps([]);
    const r = await api<{ searchId: string }>("/api/hunter/search", {
      method: "POST",
      body: JSON.stringify({ prompt, filters: plan?.filters }),
    });
    if (!r.ok) {
      setError(r.error);
      setCargando(false);
      return;
    }
    const s = await api<{ run: SearchRun }>(`/api/hunter/search?id=${r.data.searchId}`);
    if (s.ok) setRun(s.data.run);
  };

  const decidir = async (productId: string, decision: string, reason?: string) => {
    const r = await api<{ opportunity: ProductOpportunity }>("/api/hunter/decision", {
      method: "POST",
      body: JSON.stringify({ productId, decision, reason, searchId: run?.id }),
    });
    if (r.ok) {
      setOps((prev) => prev.map((o) => (o.id === productId ? r.data.opportunity : o)));
      setDetalle((d) => (d && d.id === productId ? r.data.opportunity : d));
    } else setError(r.error);
  };

  const ordenadas = useMemo(() => ordenar(ops, orden), [ops, orden]);

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-6">
      <div className="max-w-[1400px]">
        <header className="mb-5">
          <div className="text-[12px] font-semibold uppercase tracking-[.14em] text-brand-accent">Cazador</div>
          <h1 className="text-[24px] font-semibold">AI Winner Radar</h1>
          <p className="text-brand-muted text-[13px]">
            Busca productos, no anuncios. Cada número dice de dónde sale.
          </p>
        </header>

        {readiness?.fixtureMode && <FixtureBanner />}

        {readiness && !readiness.canSearch && (
          <div className="mb-4 rounded-lg border border-brand-line bg-neutral-50 px-4 py-3">
            <div className="text-[13px] font-medium">Sin fuentes conectadas</div>
            <p className="mt-0.5 text-[12px] text-brand-muted">{readiness.reason}</p>
          </div>
        )}

        <nav className="mb-5 flex gap-1 border-b border-brand-line">
          {([["buscar", "Buscar"], ["oportunidades", `Oportunidades${ops.length ? ` (${ops.length})` : ""}`], ["vigilancia", "Vigilancia"]] as const).map(
            ([id, label]) => (
              <button
                key={id}
                onClick={() => setVista(id)}
                className={`px-3 py-2 text-[13px] font-medium border-b-2 -mb-px ${
                  vista === id ? "border-brand-accent text-brand-fg" : "border-transparent text-brand-muted"
                }`}
              >
                {label}
              </button>
            )
          )}
        </nav>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">{error}</div>
        )}

        {vista === "buscar" && (
          <section>
            <label className="block text-[13px] font-medium mb-1.5">¿Qué producto quieres encontrar?</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="España, COD, ticket 25-55 €, coste menor de 12 €, sin tallas, no frágil, hogar o mascotas, fácil de demostrar en vídeo, mínimo 14 días con anuncios activos, saturación media o baja."
              className="w-full rounded-lg border border-brand-line px-3 py-2 text-sm resize-y leading-relaxed"
            />

            <div className="mt-3 flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPrompt(p.prompt)}
                  className="rounded-full border border-brand-line px-3 py-1 text-[12px] hover:bg-neutral-50"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={analizar} disabled={!prompt.trim()} className="rounded-lg border border-brand-line px-4 py-2 text-[13px] font-medium disabled:opacity-40">
                Analizar criterios
              </button>
              <button
                onClick={buscar}
                disabled={!prompt.trim() || cargando || !readiness?.canSearch}
                className="rounded-lg bg-neutral-900 text-white px-4 py-2 text-[13px] font-medium disabled:opacity-40"
              >
                {cargando ? "Buscando…" : "Buscar oportunidades"}
              </button>
              <button
                onClick={() => { setPrompt(PRESETS[0].prompt); void analizar(); }}
                className="rounded-lg border border-brand-line px-4 py-2 text-[13px]"
                title="Usa el preset de Casamable y prepara la búsqueda"
              >
                ✨ Buscar por mí
              </button>
            </div>

            {plan && (
              <div className="mt-5 rounded-lg border border-brand-line p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[13px] font-medium">Criterios interpretados</div>
                  <span className="text-[11px] text-brand-muted">
                    {plan.aiUsed ? "interpretado con IA" : "interpretado sin IA (analizador determinista)"}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Stat label="País" value={plan.filters.country} />
                  <Stat label="Precio" value={plan.filters.priceMin !== null ? `${plan.filters.priceMin}–${plan.filters.priceMax} €` : "sin límite"} />
                  <Stat label="Coste máx." value={plan.filters.supplierCostMax !== null ? `${plan.filters.supplierCostMax} €` : "sin límite"} />
                  <Stat label="Saturación máx." value={plan.filters.saturationMax ?? "sin límite"} />
                  <Stat label="Frágil" value={plan.filters.fragile === null ? "indiferente" : plan.filters.fragile ? "sí" : "no"} />
                  <Stat label="Con tallas" value={plan.filters.requiresSizing === null ? "indiferente" : plan.filters.requiresSizing ? "sí" : "no"} />
                  <Stat label="Días activo mín." value={plan.filters.minDaysActive ?? "sin límite"} />
                  <Stat label="Categorías" value={plan.filters.categories.join(", ") || "todas"} />
                </div>
                <div className="mt-3">
                  <div className="text-[11px] text-brand-muted mb-1">
                    Consultas que se lanzarán ({plan.queries.length}) — cada una consume crédito
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {plan.queries.map((q) => (
                      <span key={q} className="rounded bg-neutral-100 px-2 py-0.5 text-[11px]">{q}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {run && (
              <div className="mt-4 rounded-lg border border-brand-line p-4">
                <div className="text-[13px] font-medium">Progreso · {run.state}</div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-5 gap-3">
                  <Stat label="Fuentes" value={`${run.progress.sourcesQueried}/${run.progress.sourcesTotal}`} />
                  <Stat label="Anuncios" value={run.progress.adsAnalyzed} />
                  <Stat label="Productos" value={run.progress.productsDetected} />
                  <Stat label="Descartados" value={run.progress.candidatesDiscarded} />
                  <Stat label="Oportunidades" value={run.progress.opportunities} />
                </div>
                {run.progress.sourcesFailed.length > 0 && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    No respondieron: {run.progress.sourcesFailed.join(", ")}. El resultado es parcial y la confianza baja.
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {vista === "oportunidades" && (
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select value={orden} onChange={(e) => setOrden(e.target.value as Orden)} className="rounded-lg border border-brand-line px-2 py-1.5 text-[12px]">
                <option value="opportunity">Oportunidad</option>
                <option value="momentum">Momentum</option>
                <option value="saturation">Menos saturación</option>
                <option value="casamable">Encaje Casamable</option>
                <option value="profit">Beneficio</option>
                <option value="newest">Más recientes</option>
                <option value="confidence">Confianza</option>
              </select>
              <div className="flex gap-1">
                {(["tarjetas", "tabla", "matriz"] as const).map((m) => (
                  <button key={m} onClick={() => setModo(m)} className={`rounded px-2 py-1 text-[12px] border ${modo === m ? "border-neutral-900" : "border-brand-line text-brand-muted"}`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {ordenadas.length === 0 && <p className="text-[13px] text-brand-muted">Todavía no hay oportunidades. Lanza una búsqueda.</p>}

            {modo === "matriz" && ordenadas.length > 0 && <SaturationMatrix opportunities={ordenadas} onSelect={setDetalle} />}

            {modo === "tarjetas" && (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {ordenadas.map((o) => (
                  <OpportunityCard key={o.id} op={o} onOpen={() => setDetalle(o)} onDecide={decidir} />
                ))}
              </div>
            )}

            {modo === "tabla" && (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-brand-muted">
                    <tr className="border-b border-brand-line">
                      <th className="text-left py-2">Producto</th>
                      <th className="text-right">Opp.</th>
                      <th className="text-right">Conf.</th>
                      <th className="text-right">Mercado</th>
                      <th className="text-right">Sat.</th>
                      <th className="text-right">Anunc.</th>
                      <th className="text-right">Activos</th>
                      <th className="text-right">Beneficio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordenadas.map((o) => (
                      <tr key={o.id} className="border-b border-brand-line/50 cursor-pointer hover:bg-neutral-50" onClick={() => setDetalle(o)}>
                        <td className="py-2">{o.canonicalName}</td>
                        <td className="text-right font-medium">{o.scores.opportunity.score ?? "—"}</td>
                        <td className="text-right text-brand-muted">{Math.round(o.scores.opportunity.confidence * 100)} %</td>
                        <td className="text-right">{o.scores.market.score ?? "—"}</td>
                        <td className="text-right">{o.scores.saturation.score ?? "—"}</td>
                        <td className="text-right">{o.signals.advertiserCount}</td>
                        <td className="text-right">{o.signals.activeAds}</td>
                        <td className="text-right">{money(o.economics?.expectedProfit.value ?? null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {vista === "vigilancia" && <Watchlist onOpen={setDetalle} />}

        {detalle && <OpportunityDetail op={detalle} onClose={() => setDetalle(null)} onDecide={decidir} />}
      </div>
    </div>
  );
}

function OpportunityCard({
  op,
  onOpen,
  onDecide,
}: {
  op: ProductOpportunity;
  onOpen: () => void;
  onDecide: (id: string, decision: string, reason?: string) => void;
}) {
  return (
    <div className="rounded-xl border border-brand-line p-4 hover:shadow-sm transition">
      <button onClick={onOpen} className="text-left w-full">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-[14px] font-semibold leading-tight">{op.canonicalName}</h3>
          <div className="text-right shrink-0">
            <div className="text-[22px] font-semibold leading-none">{op.scores.opportunity.score ?? "—"}</div>
            <div className="text-[10px] text-brand-muted">conf. {Math.round(op.scores.opportunity.confidence * 100)} %</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {op.badges.map((b) => <Badge key={b} badge={b} />)}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <ScoreChip label="Mercado" value={op.scores.market} />
          <ScoreChip label="Producto" value={op.scores.product} />
          <ScoreChip label="Casamable" value={op.scores.casamable} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-brand-muted">
          <span>{op.signals.advertiserCount} anunciantes · {op.signals.activeAds} activos</span>
          <span className="text-right">{op.signals.creativeCount} creatividades</span>
          <span>
            {op.observedPriceMin !== null ? `${op.observedPriceMin.toFixed(0)}–${op.observedPriceMax?.toFixed(0)} €` : "precio no visto"}
          </span>
          <span className="text-right">
            {op.economics?.expectedProfit.value !== null && op.economics
              ? `benef. ${money(op.economics.expectedProfit.value)}`
              : "sin economía"}
          </span>
        </div>
      </button>
      <div className="mt-3 flex gap-1">
        <button onClick={() => onDecide(op.id, "save")} className="flex-1 rounded border border-brand-line px-2 py-1.5 text-[11px]">Guardar</button>
        <button onClick={() => onDecide(op.id, "watch")} className="flex-1 rounded border border-brand-line px-2 py-1.5 text-[11px]">Vigilar</button>
        <button onClick={() => onDecide(op.id, "discard", "other")} className="flex-1 rounded border border-brand-line px-2 py-1.5 text-[11px] text-brand-muted">Descartar</button>
      </div>
    </div>
  );
}

function Watchlist({ onOpen }: { onOpen: (op: ProductOpportunity) => void }) {
  const [items, setItems] = useState<Array<{ product: ProductOpportunity; addedAt: number }>>([]);
  useEffect(() => {
    void api<{ watchlist: Array<{ product: ProductOpportunity; addedAt: number }> }>("/api/hunter/watchlist").then((r) => {
      if (r.ok) setItems(r.data.watchlist);
    });
  }, []);
  if (items.length === 0) return <p className="text-[13px] text-brand-muted">No vigilas ningún producto todavía.</p>;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map(({ product }) => (
        <button key={product.id} onClick={() => onOpen(product)} className="rounded-xl border border-brand-line p-4 text-left">
          <div className="text-[14px] font-semibold">{product.canonicalName}</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <ScoreChip label="Oportunidad" value={product.scores.opportunity} />
            <ScoreChip label="Momentum" value={product.scores.momentum} />
          </div>
        </button>
      ))}
    </div>
  );
}

/** Ordena SIN inventar: lo que no tiene valor va al final, no vale 0. */
function ordenar(ops: ProductOpportunity[], orden: Orden): ProductOpportunity[] {
  const val = (o: ProductOpportunity): number | null => {
    switch (orden) {
      case "opportunity": return o.scores.opportunity.score;
      case "momentum": return o.scores.momentum.score;
      case "saturation": return o.scores.saturation.score === null ? null : 100 - o.scores.saturation.score;
      case "casamable": return o.scores.casamable.score;
      case "profit": return o.economics?.expectedProfit.value ?? null;
      case "newest": return o.firstSeenAt;
      case "confidence": return o.scores.opportunity.confidence;
    }
  };
  return [...ops].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return vb - va;
  });
}

export { pct };
