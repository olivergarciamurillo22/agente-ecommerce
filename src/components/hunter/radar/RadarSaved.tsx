"use client";

// ============================================================
// WINNER RADAR — LO QUE HAS GUARDADO.
//
// Existe por un agujero concreto: se podía pulsar «Guardar» o «Vigilar» en un
// producto y luego NO había ningún sitio donde volver a encontrarlo. Guardar
// algo que después no aparece en ninguna parte es peor que no ofrecer el
// botón, porque enseña que la herramienta no se acuerda de nada.
//
// Se agrupa por estado y en el ORDEN del embudo real —lo que estás probando
// primero, lo descartado al final—, no alfabéticamente ni por fecha: lo que
// importa es en qué punto está cada cosa.
// ============================================================

import { useMemo } from "react";
import type { OpportunityStatus, ProductOpportunity } from "@/lib/hunter/types";
import { Card, EmptyState, PageHeader, PrimaryButton, SectionTitle } from "@/components/ui";
import { IconSearch } from "@/components/icons";
import { OpportunityCard, type CardAction } from "./OpportunityCard";
import { miles } from "./radar-shared";

/** Orden del embudo. `new` no sale: eso es «aún no lo has mirado». */
const GRUPOS: ReadonlyArray<{ estado: OpportunityStatus; titulo: string; ayuda: string }> = [
  { estado: "testing", titulo: "En prueba", ayuda: "Con dinero puesto. Estos son los que hay que mirar cada día." },
  { estado: "winner", titulo: "Funcionaron", ayuda: "Lo que salió bien. Es el histórico que enseña qué buscar la próxima vez." },
  { estado: "watching", titulo: "Vigilando", ayuda: "Se refrescan solos y avisan si cambian." },
  { estado: "saved", titulo: "Guardados", ayuda: "Apartados para decidir más adelante." },
  { estado: "loser", titulo: "No funcionaron", ayuda: "Se probaron y no salió. Vale la pena recordar por qué." },
  { estado: "discarded", titulo: "Descartados", ayuda: "Fuera de las listas. Siguen aquí por si cambia el mercado." },
];

export default function RadarSaved({
  opportunities,
  why,
  onOpen,
  onAction,
  onNewSearch,
}: {
  opportunities: ProductOpportunity[];
  why: (op: ProductOpportunity) => string;
  onOpen: (op: ProductOpportunity) => void;
  onAction: (op: ProductOpportunity, a: CardAction) => void;
  onNewSearch: () => void;
}) {
  const porEstado = useMemo(() => {
    const m = new Map<OpportunityStatus, ProductOpportunity[]>();
    for (const o of opportunities) {
      const l = m.get(o.status) ?? [];
      l.push(o);
      m.set(o.status, l);
    }
    return m;
  }, [opportunities]);

  const conAlgo = GRUPOS.filter((g) => (porEstado.get(g.estado)?.length ?? 0) > 0);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 md:px-8 py-8">
      <PageHeader
        title="Tus productos"
        description="Lo que has guardado, lo que estás vigilando y lo que ya probaste."
      />

      {conAlgo.length === 0 ? (
        <Card className="mt-6">
          <EmptyState
            icon={<IconSearch size={26} />}
            title="Todavía no has guardado ningún producto"
            hint="Cuando encuentres algo que te interese, guárdalo o ponlo en vigilancia desde su ficha y aparecerá aquí."
          />
          <div className="-mt-4 flex justify-center pb-8">
            <PrimaryButton onClick={onNewSearch}>
              <IconSearch size={15} />
              Buscar oportunidades
            </PrimaryButton>
          </div>
        </Card>
      ) : (
        conAlgo.map((g) => {
          const lista = porEstado.get(g.estado) ?? [];
          return (
            <section key={g.estado} className="mt-8">
              <SectionTitle>
                {g.titulo} ({miles(lista.length)})
              </SectionTitle>
              <p className="-mt-2 mb-3 text-[12.5px] text-brand-muted">{g.ayuda}</p>
              <div className="grid gap-2.5 lg:grid-cols-2">
                {lista.map((op) => (
                  <OpportunityCard
                    key={op.id}
                    op={op}
                    why={why(op)}
                    onOpen={() => onOpen(op)}
                    onAction={(a) => onAction(op, a)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
