"use client";

// Matriz momentum × saturación. El cuadrante que interesa es arriba a la
// izquierda: mucho movimiento y poca competencia.
//
// Los productos SIN momentum (sin histórico) NO se pintan en el centro como
// si fueran mediocres: se listan aparte. Colocarlos en el gráfico sería
// inventarles una posición.

import type { ProductOpportunity } from "@/lib/hunter/types";

export default function SaturationMatrix({
  opportunities,
  onSelect,
}: {
  opportunities: ProductOpportunity[];
  onSelect: (op: ProductOpportunity) => void;
}) {
  const conDatos = opportunities.filter((o) => o.scores.momentum.score !== null && o.scores.saturation.score !== null);
  const sinDatos = opportunities.filter((o) => o.scores.momentum.score === null || o.scores.saturation.score === null);

  return (
    <div>
      <div className="relative rounded-xl border border-brand-line bg-white" style={{ height: 380 }}>
        {/* Cuadrante bueno, marcado sin adornos */}
        <div className="absolute left-0 top-0 h-1/2 w-1/2 bg-emerald-50/60" />
        <div className="absolute left-2 top-2 text-[10px] font-medium text-emerald-800">
          Zona buena · mucho momentum, poca saturación
        </div>
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-brand-line" />
        <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-brand-line" />

        {conDatos.map((o) => {
          const sat = o.scores.saturation.score as number;
          const mom = o.scores.momentum.score as number;
          const opp = o.scores.opportunity.score ?? 50;
          // El tamaño refleja la CONFIANZA, no el score: un punto grande es
          // un punto del que sabemos bastante.
          const tam = 10 + o.scores.opportunity.confidence * 14;
          return (
            <button
              key={o.id}
              onClick={() => onSelect(o)}
              title={`${o.canonicalName} · oportunidad ${opp}, momentum ${mom}, saturación ${sat}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow-sm"
              style={{
                left: `${sat}%`,
                top: `${100 - mom}%`,
                width: tam,
                height: tam,
                background: opp >= 70 ? "#059669" : opp >= 45 ? "#d97706" : "#737373",
              }}
            />
          );
        })}

        <div className="absolute bottom-1 right-2 text-[10px] text-brand-muted">saturación →</div>
        <div className="absolute left-2 bottom-8 text-[10px] text-brand-muted" style={{ writingMode: "vertical-rl" }}>
          momentum →
        </div>
      </div>

      {sinDatos.length > 0 && (
        <div className="mt-3 rounded-lg border border-brand-line p-3">
          <div className="text-[12px] font-medium">Sin sitio en el gráfico ({sinDatos.length})</div>
          <p className="text-[11px] text-brand-muted">
            Todavía no tienen histórico o saturación medible. Aparecerán cuando el radar los haya visto dos veces:
            colocarlos ahora sería inventarles una posición.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {sinDatos.map((o) => (
              <button key={o.id} onClick={() => onSelect(o)} className="rounded border border-brand-line px-2 py-1 text-[11px]">
                {o.canonicalName}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
