"use client";

// ============================================================
// WINNER RADAR — LA RESPUESTA.
//
// Esto NO es una tabla de resultados. Una lista de 38 productos ordenados por
// score deja todo el trabajo del lado de Pedro: sigue teniendo que leerlos
// uno a uno para saber por dónde empezar.
//
// Así que la pantalla contesta en este orden:
//
//   1. QUÉ HARÍA HOY   — tres o cuatro acciones concretas, con su motivo
//   2. LO MEJOR        — el podio, en grande y con su veredicto
//   3. LO DEMÁS        — la lista larga, compacta
//   4. QUÉ NO CUADRA   — riesgos y cobertura, sin esconderlos abajo del todo
//
// Los riesgos van ARRIBA, junto al resumen, no en un pie que nadie lee. Que
// una fuente no respondiera cambia cómo hay que leer todos los números de
// debajo.
// ============================================================

import { useMemo, useState } from "react";
import type { ProductOpportunity, SearchRun, TodayAction } from "@/lib/hunter/types";
import { Card, EmptyState, GhostButton, PrimaryButton, SectionTitle, SelectInput } from "@/components/ui";
import { IconCheck, IconClock, IconSearch, IconWarning } from "@/components/icons";
import { OpportunityCard, OpportunityHero, type CardAction } from "./OpportunityCard";
import { FixtureBanner, miles } from "./radar-shared";

type Orden = "opportunity" | "momentum" | "saturation" | "profit" | "newest";

const ORDENES: Array<{ id: Orden; label: string }> = [
  { id: "opportunity", label: "Mejor oportunidad" },
  { id: "momentum", label: "Más en alza" },
  { id: "saturation", label: "Menos competencia" },
  { id: "profit", label: "Más beneficio" },
  { id: "newest", label: "Más recientes" },
];

const VERBO_ICONO: Record<TodayAction["verb"], typeof IconCheck> = {
  TESTEAR: IconCheck,
  VIGILAR: IconClock,
  BUSCAR_PROVEEDOR: IconSearch,
  EVITAR: IconWarning,
  AMPLIAR_BUSQUEDA: IconSearch,
};

export default function RadarResults({
  run,
  opportunities,
  why,
  onOpen,
  onAction,
  onNewSearch,
}: {
  run: SearchRun;
  opportunities: ProductOpportunity[];
  why: (op: ProductOpportunity) => string;
  onOpen: (op: ProductOpportunity) => void;
  onAction: (op: ProductOpportunity, a: CardAction) => void;
  onNewSearch: () => void;
}) {
  const [orden, setOrden] = useState<Orden>("opportunity");
  const informe = run.report;

  const porId = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities]);
  const top = useMemo(
    () => (informe?.topPickIds ?? []).map((id) => porId.get(id)).filter((o): o is ProductOpportunity => !!o),
    [informe, porId]
  );
  const vigilar = useMemo(
    () => (informe?.watchIds ?? []).map((id) => porId.get(id)).filter((o): o is ProductOpportunity => !!o),
    [informe, porId]
  );
  const resto = useMemo(() => {
    const yaVistos = new Set([...top, ...vigilar].map((o) => o.id));
    return ordenar(opportunities.filter((o) => !yaVistos.has(o.id)), orden);
  }, [opportunities, top, vigilar, orden]);

  const fecha = new Date(run.startedAt * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "long" });

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 md:px-8 py-8">
      {run.fixtureMode && <FixtureBanner />}

      {/* Cabecera del informe */}
      <header className="border-b border-brand-border pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[.12em] text-brand-tertiary">
              Radar · {fecha}
            </div>
            <h1 className="mt-1 text-[24px] md:text-[30px] font-semibold tracking-tight text-balance">
              {informe?.headline ?? run.title ?? "Resultados"}
            </h1>
          </div>
          <GhostButton onClick={onNewSearch} className="shrink-0">
            <IconSearch size={15} />
            Nueva búsqueda
          </GhostButton>
        </div>

        {informe && informe.summary.length > 0 && (
          <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-brand-muted">
            {informe.summary.join(" ")}
          </p>
        )}

        {/* Lo que cambia cómo leer todo lo de abajo, arriba del todo. */}
        {informe && informe.risks.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {informe.risks.map((r, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-amber-900">
                <IconWarning size={15} className="mt-0.5 shrink-0 text-amber-600" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        )}
      </header>

      {/* Qué haría hoy */}
      {informe && informe.todayActions.length > 0 && (
        <section className="mt-8">
          <SectionTitle>Qué haría hoy</SectionTitle>
          <ol className="divide-y divide-brand-border overflow-hidden rounded-2xl border border-brand-border bg-brand-surface shadow-[var(--shadow-card)]">
            {informe.todayActions.map((a, i) => {
              const Icono = VERBO_ICONO[a.verb] ?? IconCheck;
              const producto = a.productId ? porId.get(a.productId) : null;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => producto && onOpen(producto)}
                    disabled={!producto}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left enabled:hover:bg-brand-surface-2 transition-colors disabled:cursor-default"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-surface-2 text-[11px] font-semibold tabular-nums text-brand-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[14px] font-medium">
                        <Icono size={15} className="shrink-0 text-brand-tertiary" />
                        {a.text}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] leading-relaxed text-brand-muted">{a.because}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* Podio */}
      {top.length > 0 && (
        <section className="mt-10">
          <SectionTitle>Las mejores oportunidades</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {top.map((op, i) => (
              <OpportunityHero
                key={op.id}
                op={op}
                rank={i + 1}
                why={why(op)}
                onOpen={() => onOpen(op)}
                onAction={(a) => onAction(op, a)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Para vigilar */}
      {vigilar.length > 0 && (
        <section className="mt-10">
          <SectionTitle>Para vigilar</SectionTitle>
          <p className="-mt-2 mb-3 text-[12.5px] text-brand-muted">
            Interesantes, pero todavía sin lo suficiente para gastar en un test.
          </p>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {vigilar.map((op) => (
              <OpportunityCard key={op.id} op={op} why={why(op)} onOpen={() => onOpen(op)} onAction={(a) => onAction(op, a)} />
            ))}
          </div>
        </section>
      )}

      {/* El resto */}
      {resto.length > 0 && (
        <section className="mt-10">
          <SectionTitle
            right={
              <SelectInput
                label="Ordenar las oportunidades"
                value={orden}
                onChange={(v) => setOrden(v as Orden)}
                options={ORDENES.map((o) => ({ value: o.id, label: o.label }))}
              />
            }
          >
            Otras oportunidades ({miles(resto.length)})
          </SectionTitle>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {resto.map((op) => (
              <OpportunityCard key={op.id} op={op} why={why(op)} onOpen={() => onOpen(op)} onAction={(a) => onAction(op, a)} />
            ))}
          </div>
        </section>
      )}

      {/* Notas de mercado */}
      {informe && informe.marketNotes.length > 0 && (
        <section className="mt-10">
          <SectionTitle>Lectura del mercado</SectionTitle>
          <Card className="px-5 py-4">
          <ul className="space-y-1.5 text-[13.5px] leading-relaxed text-brand-muted">
            {informe.marketNotes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
          {informe.aiGenerated && (
            <p className="mt-2.5 text-[11px] text-brand-tertiary">
              Esta lectura la ha redactado un modelo a partir de los datos de arriba. Los números son observados; la
              interpretación, no.
            </p>
          )}
          </Card>
        </section>
      )}

      {opportunities.length === 0 && (
        <Card className="mt-10">
          <EmptyState
            icon={<IconSearch size={26} />}
            title="No ha salido nada con esos criterios"
            hint={
              run.progress.productsDetected > 0
                ? `Se detectaron ${miles(run.progress.productsDetected)} productos, pero ninguno pasó tus filtros. Los que más descartan suelen ser el precio y el coste de proveedor.`
                : "No hemos encontrado anuncios con ese vocabulario. Prueba con las palabras que usaría el anunciante, no las que usarías tú."
            }
          />
          <div className="-mt-4 flex justify-center pb-8">
            <PrimaryButton onClick={onNewSearch}>Probar otra búsqueda</PrimaryButton>
          </div>
        </Card>
      )}
    </div>
  );
}

function ordenar(ops: ProductOpportunity[], orden: Orden): ProductOpportunity[] {
  const v = (n: number | null) => (n === null ? -1 : n);
  const copia = [...ops];
  switch (orden) {
    case "momentum":
      return copia.sort((a, b) => v(b.scores.momentum.score) - v(a.scores.momentum.score));
    case "saturation":
      // Menos saturación primero: aquí «mejor» es el número más bajo.
      return copia.sort((a, b) => v(a.scores.saturation.score) - v(b.scores.saturation.score));
    case "profit":
      return copia.sort((a, b) => (b.economics?.expectedProfit.value ?? -1) - (a.economics?.expectedProfit.value ?? -1));
    case "newest":
      return copia.sort((a, b) => (b.firstSeenAt ?? 0) - (a.firstSeenAt ?? 0));
    default:
      return copia.sort((a, b) => v(b.scores.opportunity.score) - v(a.scores.opportunity.score));
  }
}
