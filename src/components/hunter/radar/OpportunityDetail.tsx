"use client";

// Ficha de una oportunidad. Lo importante de esta pantalla no es que tenga
// muchas pestañas, sino que SEPARA lo observado de lo inferido y lo estimado.
// Mezclarlo en un párrafo bonito es como se toman decisiones caras con datos
// que nadie ha comprobado.

import { useEffect, useState } from "react";
import { useOverlayBack } from "@/components/useBackable";
import type { ProductOpportunity, TestPlan } from "@/lib/hunter/types";
import type { HunterAd } from "@/lib/hunter/types";
import { Badge, ProvenanceTag, ScoreChip, Stat, money, pct } from "./radar-shared";

type Tab = "resumen" | "ads" | "competidores" | "economia" | "ia" | "historico";

export default function OpportunityDetail({
  op,
  onClose,
  onDecide,
}: {
  op: ProductOpportunity;
  onClose: () => void;
  onDecide: (id: string, decision: string, reason?: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("resumen");
  // Atrás y Escape cierran la ficha, como espera cualquiera.
  useOverlayBack(true, onClose);
  const [plan, setPlan] = useState<TestPlan | null>(null);
  const [ads, setAds] = useState<HunterAd[]>([]);

  useEffect(() => {
    void fetch(`/api/hunter/opportunities?id=${op.id}`)
      .then((r) => r.json())
      .then((b: { testPlan?: TestPlan; opportunity?: ProductOpportunity & { ads?: HunterAd[] } }) => {
        if (b.testPlan) setPlan(b.testPlan);
        if (b.opportunity && Array.isArray((b.opportunity as { ads?: HunterAd[] }).ads)) {
          setAds((b.opportunity as { ads?: HunterAd[] }).ads ?? []);
        }
      })
      .catch(() => undefined);
  }, [op.id]);

  const e = op.economics;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40 p-0 md:p-6" onClick={onClose}>
      <div
        className="w-full md:max-w-4xl max-h-[92vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-white p-5"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-semibold">{op.canonicalName}</h2>
            <div className="mt-1 flex flex-wrap gap-1">{op.badges.map((b) => <Badge key={b} badge={b} />)}</div>
          </div>
          <button onClick={onClose} className="text-brand-muted text-[13px]">Cerrar</button>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          <ScoreChip label="Oportunidad" value={op.scores.opportunity} size="lg" />
          <ScoreChip label="Mercado" value={op.scores.market} />
          <ScoreChip label="Producto" value={op.scores.product} />
          <ScoreChip label="Casamable" value={op.scores.casamable} />
        </div>

        {op.clusterConfidence < 0.6 && (
          <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            La agrupación de anuncios es poco fiable ({Math.round(op.clusterConfidence * 100)} %): comprueba que todos
            los anuncios sean de verdad el mismo producto antes de decidir.
          </p>
        )}

        <nav className="mt-4 flex gap-1 border-b border-brand-line overflow-x-auto">
          {([["resumen", "Resumen"], ["ads", `Anuncios (${op.adIds.length})`], ["competidores", "Competidores"], ["economia", "Economía"], ["ia", "IA"], ["historico", "Histórico"]] as const).map(
            ([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`whitespace-nowrap px-3 py-2 text-[12px] font-medium border-b-2 -mb-px ${
                  tab === id ? "border-brand-accent" : "border-transparent text-brand-muted"
                }`}
              >
                {label}
              </button>
            )
          )}
        </nav>

        <div className="mt-4">
          {tab === "resumen" && (
            <div className="space-y-4">
              <Bloque titulo="Observado" nota="Lo dice la fuente, tal cual" tono="emerald" lineas={op.summary?.observed ?? []} />
              <Bloque titulo="Inferido" nota="Lectura del mercado, no un hecho" tono="violet" lineas={op.summary?.inferred ?? []} />
              <Bloque titulo="Estimado" nota="Cuentas con supuestos: compruébalos" tono="amber" lineas={op.summary?.estimated ?? []} />
              {(op.summary?.risks.length ?? 0) > 0 && (
                <Bloque titulo="Riesgos" nota="" tono="red" lineas={op.summary?.risks ?? []} />
              )}
              {op.summary && (
                <p className="text-[11px] text-brand-muted">
                  {op.summary.aiGenerated ? "Las lecturas las redactó un modelo a partir de los datos de arriba." : "Resumen generado sin IA."}
                </p>
              )}
            </div>
          )}

          {tab === "ads" && (
            <div className="space-y-2">
              {ads.length === 0 && <p className="text-[12px] text-brand-muted">Los anuncios de respaldo no se han cargado en esta vista.</p>}
              {ads.map((a) => (
                <div key={a.id} className="rounded border border-brand-line p-3">
                  <div className="flex justify-between text-[12px]">
                    <span className="font-medium">{a.advertiserName ?? "anunciante desconocido"}</span>
                    <span className="text-brand-muted">{a.platform} · {a.activeDays ?? "?"} días</span>
                  </div>
                  {a.adCopy && <p className="mt-1 text-[11px] text-brand-muted line-clamp-2">{a.adCopy}</p>}
                  {a.previewUrl && (
                    <a href={a.previewUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-block text-[11px] underline">
                      Ver el anuncio en la fuente
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "competidores" && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Stat label="Anunciantes" value={op.signals.advertiserCount} />
              <Stat label="Anuncios activos" value={op.signals.activeAds} />
              <Stat label="Anuncios totales" value={op.signals.totalAds} />
              <Stat label="Creatividades" value={op.signals.creativeCount} />
              <Stat
                label="Cuota del mayor"
                value={op.signals.topAdvertiserShare === null ? "—" : pct(op.signals.topAdvertiserShare)}
                hint={
                  op.signals.topAdvertiserShare === null
                    ? undefined
                    : op.signals.topAdvertiserShare > 0.6
                      ? "dominado por una marca: puede quedar hueco"
                      : "repartido: mercado más maduro"
                }
              />
              <Stat label="Países · plataformas" value={`${op.signals.countryCount} · ${op.signals.platformCount}`} />
            </div>
          )}

          {tab === "economia" && (
            <div>
              {!e && (
                <p className="text-[12px] text-brand-muted">
                  Sin coste de proveedor no se puede calcular nada. Mételo a mano en la ficha y vuelve aquí:
                  preferimos no enseñar un beneficio inventado.
                </p>
              )}
              {e && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <Metrica label="Precio de venta" v={e.salePrice.value} p={e.salePrice.provenance} money />
                    <Metrica label="Coste de proveedor" v={e.supplierCost.value} p={e.supplierCost.provenance} money />
                    <Metrica label="CPA real" v={e.realCPA.value} p={e.realCPA.provenance} money />
                    <Metrica label="Beneficio esperado" v={e.expectedProfit.value} p={e.expectedProfit.provenance} money />
                    <Metrica label="Margen" v={e.margin.value === null ? null : e.margin.value * 100} p={e.margin.provenance} suffix=" %" />
                    <Metrica label="CPA de equilibrio" v={e.breakEvenCPA.value} p={e.breakEvenCPA.provenance} money />
                  </div>
                  <div className="mt-4">
                    <div className="text-[12px] font-medium mb-1">Supuestos usados</div>
                    <ul className="space-y-1">
                      {e.assumptions.map((a) => (
                        <li key={a.key} className="flex items-center gap-2 text-[11px] text-brand-muted">
                          <ProvenanceTag provenance={a.provenance} />
                          <span>{a.label}: {a.value}{a.source ? ` · ${a.source}` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              {plan && (
                <div className="mt-5 rounded-lg border border-brand-line p-3">
                  <div className="text-[12px] font-medium">Plan de prueba (no lanza nada)</div>
                  <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
                    <Stat label="Precio" value={money(plan.recommendedPrice)} />
                    <Stat label="CPA objetivo" value={money(plan.targetCPA)} />
                    <Stat label="Presupuesto/día" value={plan.recommendedDailyBudget ? `${plan.recommendedDailyBudget} €` : "—"} />
                    <Stat label="Duración" value={plan.testDurationDays ? `${plan.testDurationDays} días` : "—"} />
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {plan.rationale.map((r, i) => (
                      <li key={i} className="text-[11px] text-brand-muted">· {r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {tab === "ia" && (
            <div>
              {op.features.length === 0 && (
                <p className="text-[12px] text-brand-muted">
                  Sin análisis de IA para este producto (o sin clave de modelo configurada).
                </p>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                {op.features.map((f) => (
                  <div key={f.key} className="rounded border border-brand-line p-2">
                    <div className="flex justify-between text-[12px]">
                      <span>{f.key}</span>
                      <span className="font-medium">{f.value ?? "—"}</span>
                    </div>
                    {f.rationale && <p className="text-[10px] text-brand-muted">{f.rationale}</p>}
                    <div className="mt-1"><ProvenanceTag provenance="AI_INFERENCE" /></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "historico" && (
            <p className="text-[12px] text-brand-muted">
              {op.scores.momentum.score === null
                ? "Todavía no hay fotos anteriores de este producto. El momentum aparecerá cuando el radar lo haya visto al menos dos veces con días de diferencia — no se inventa con una sola medición."
                : `Momentum ${op.scores.momentum.score}/100 con ${Math.round(op.scores.momentum.confidence * 100)} % de confianza.`}
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-brand-line pt-4">
          {(["save", "watch", "test", "winner", "loser"] as const).map((d) => (
            <button key={d} onClick={() => onDecide(op.id, d)} className="rounded-lg border border-brand-line px-3 py-1.5 text-[12px]">
              {{ save: "Guardar", watch: "Vigilar", test: "Testear", winner: "Ganador", loser: "Perdedor" }[d]}
            </button>
          ))}
          <DescartarConMotivo onDecide={(reason) => onDecide(op.id, "discard", reason)} />
        </div>
      </div>
    </div>
  );
}

function Bloque({ titulo, nota, tono, lineas }: { titulo: string; nota: string; tono: string; lineas: string[] }) {
  if (lineas.length === 0) return null;
  const border = { emerald: "border-emerald-200", violet: "border-violet-200", amber: "border-amber-200", red: "border-red-200" }[tono] ?? "border-brand-line";
  return (
    <div className={`rounded-lg border ${border} p-3`}>
      <div className="text-[12px] font-semibold">{titulo}</div>
      {nota && <div className="text-[10px] text-brand-muted">{nota}</div>}
      <ul className="mt-1.5 space-y-0.5">
        {lineas.map((l, i) => <li key={i} className="text-[12px]">· {l}</li>)}
      </ul>
    </div>
  );
}

function Metrica({ label, v, p, money: esMoneda, suffix }: { label: string; v: number | null; p: import("@/lib/hunter/provenance").MetricProvenance; money?: boolean; suffix?: string }) {
  return (
    <div>
      <div className="text-[11px] text-brand-muted">{label}</div>
      <div className="text-[14px] font-medium">
        {v === null ? "No disponible" : esMoneda ? money(v) : `${v.toFixed(0)}${suffix ?? ""}`}
      </div>
      <div className="mt-0.5"><ProvenanceTag provenance={p} /></div>
    </div>
  );
}

/** Descartar SIEMPRE pide motivo: sin él, el dataset de decisiones no enseña nada. */
function DescartarConMotivo({ onDecide }: { onDecide: (reason: string) => void }) {
  const [abierto, setAbierto] = useState(false);
  const RAZONES = [
    ["too_saturated", "Demasiado saturado"], ["bad_margin", "Margen insuficiente"],
    ["bad_supplier", "Proveedor malo"], ["weak_creative", "Creatividad floja"],
    ["fragile", "Frágil"], ["regulated", "Regulado"], ["other", "Otro"],
  ] as const;
  if (!abierto) {
    return <button onClick={() => setAbierto(true)} className="rounded-lg border border-brand-line px-3 py-1.5 text-[12px] text-brand-muted">Descartar</button>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {RAZONES.map(([k, l]) => (
        <button key={k} onClick={() => { onDecide(k); setAbierto(false); }} className="rounded border border-brand-line px-2 py-1 text-[11px]">
          {l}
        </button>
      ))}
    </div>
  );
}
