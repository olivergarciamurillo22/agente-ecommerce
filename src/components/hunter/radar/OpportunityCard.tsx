"use client";

// ============================================================
// WINNER RADAR — LA TARJETA DE UN PRODUCTO.
//
// Dos tamaños: `hero` para el podio y `compact` para la lista larga. Los dos
// responden a las mismas tres preguntas, en este orden:
//
//   1. ¿QUÉ HAGO CON ESTO?  → el verbo, arriba y grande
//   2. ¿POR QUÉ?            → una frase construida con lo observado
//   3. ¿CON QUÉ DATOS?      → las señales, en crudo y comparables
//
// Al revés —score primero, explicación en un desplegable— es como se acaba
// decidiendo por un número sin saber qué hay debajo.
//
// Las acciones secundarias viven en un menú. Diez botones en una tarjeta no
// dan diez opciones: quitan la principal.
// ============================================================

import { useEffect, useRef, useState } from "react";
import type { ProductOpportunity } from "@/lib/hunter/types";
import { IconChevronRight, IconMore } from "@/components/icons";
import { ProductCover, ScoreBar, VerdictChip, miles, money, plural, scoreLabel } from "./radar-shared";

export type CardAction = "test" | "watch" | "save" | "discard";

interface CardProps {
  op: ProductOpportunity;
  why: string;
  onOpen: () => void;
  onAction: (a: CardAction) => void;
  rank?: number;
}

// ------------------------------------------------------------
// Podio
// ------------------------------------------------------------

export function OpportunityHero({ op, why, onOpen, onAction, rank }: CardProps) {
  const opp = op.scores.opportunity;
  return (
    <article className="group flex flex-col rounded-2xl border border-brand-border bg-brand-surface overflow-hidden hover:border-brand-border-strong transition-colors">
      <button type="button" onClick={onOpen} className="text-left" aria-label={`Abrir ${op.canonicalName}`}>
        <div className="relative">
          <ProductCover name={op.canonicalName} imageUrl={op.heroImageUrl ?? op.images[0] ?? null} size="lg" />
          {rank !== undefined && (
            <span className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-[13px] font-semibold text-white backdrop-blur-sm">
              {rank}
            </span>
          )}
        </div>
      </button>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <VerdictChip verdict={op.recommendation} size="lg" />
          <div className="text-right shrink-0">
            <div className="text-[24px] leading-none font-semibold tabular-nums tracking-tight">
              {opp.score === null ? "—" : Math.round(opp.score)}
            </div>
            <div className="text-[10px] uppercase tracking-[.08em] text-brand-tertiary mt-0.5">
              {opp.score === null ? "sin datos" : `${Math.round(opp.confidence * 100)} % conf.`}
            </div>
          </div>
        </div>

        <button type="button" onClick={onOpen} className="mt-2.5 text-left">
          <h3 className="text-[16px] font-semibold leading-snug tracking-tight line-clamp-2 group-hover:underline underline-offset-2">
            {op.canonicalName}
          </h3>
        </button>
        <p className="mt-1.5 text-[13px] leading-relaxed text-brand-muted line-clamp-3">{why}</p>

        <div className="mt-3.5 space-y-0.5 border-t border-brand-border pt-3">
          <ScoreBar label="Tendencia" value={op.scores.momentum.score} word={scoreLabel(op.scores.momentum)} tone="good" />
          <ScoreBar label="Saturación" value={op.scores.saturation.score} word={scoreLabel(op.scores.saturation, "saturation")} tone="warn" />
          <ScoreBar label="Encaje Casamable" value={op.scores.casamable.score} word={scoreLabel(op.scores.casamable)} />
        </div>

        <SignalRow op={op} />

        <div className="mt-3.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl bg-brand-gold px-4 h-11 text-[14px] font-semibold text-white hover:bg-brand-gold-soft transition-colors"
          >
            Ver a fondo
            <IconChevronRight size={16} />
          </button>
          <ActionMenu onAction={onAction} status={op.status} />
        </div>
      </div>
    </article>
  );
}

// ------------------------------------------------------------
// Lista larga
// ------------------------------------------------------------

export function OpportunityCard({ op, why, onOpen, onAction }: CardProps) {
  const opp = op.scores.opportunity;
  return (
    <article className="group flex gap-3.5 rounded-xl border border-brand-border bg-brand-surface p-3 hover:border-brand-border-strong transition-colors">
      <button
        type="button"
        onClick={onOpen}
        className="w-[92px] shrink-0"
        aria-label={`Abrir ${op.canonicalName}`}
        tabIndex={-1}
      >
        <ProductCover name={op.canonicalName} imageUrl={op.heroImageUrl ?? op.images[0] ?? null} size="sm" />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            <h3 className="text-[14px] font-semibold leading-snug truncate group-hover:underline underline-offset-2">
              {op.canonicalName}
            </h3>
          </button>
          <div className="flex items-center gap-2 shrink-0">
            <VerdictChip verdict={op.recommendation} />
            <span className="text-[15px] font-semibold tabular-nums">
              {opp.score === null ? "—" : Math.round(opp.score)}
            </span>
            <ActionMenu onAction={onAction} status={op.status} />
          </div>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-brand-muted line-clamp-2">{why}</p>
        <SignalRow op={op} compact />
      </div>
    </article>
  );
}

// ------------------------------------------------------------
// Piezas comunes
// ------------------------------------------------------------

function SignalRow({ op, compact = false }: { op: ProductOpportunity; compact?: boolean }) {
  const s = op.signals;
  const precio =
    op.observedPriceMin !== null && op.observedPriceMax !== null && op.observedPriceMin !== op.observedPriceMax
      ? `${money(op.observedPriceMin, op.currency)}–${money(op.observedPriceMax, op.currency)}`
      : money(op.observedPriceMax ?? op.observedPriceMin, op.currency);

  const datos: string[] = [
    plural(s.advertiserCount, "anunciante", "anunciantes"),
    plural(s.activeAds, "anuncio activo", "anuncios activos"),
    plural(s.creativeCount, "creatividad", "creatividades"),
  ];
  if (s.oldestActiveAdDays !== null) datos.push(`${miles(s.oldestActiveAdDays)} días el más veterano`);
  if (op.observedPriceMax !== null || op.observedPriceMin !== null) datos.push(`${precio} de precio visto`);

  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1 ${compact ? "mt-1.5" : "mt-3"} text-[12px] tabular-nums text-brand-tertiary`}>
      {datos.slice(0, compact ? 4 : 5).map((t) => (
        <li key={t}>
          <span className="font-medium text-brand-text">{t.split(" ")[0]}</span> {t.split(" ").slice(1).join(" ")}
        </li>
      ))}
    </ul>
  );
}

const ACCIONES: Array<{ id: CardAction; label: string; hint: string }> = [
  { id: "test", label: "Preparar test", hint: "Lo pasa a «en prueba» y prepara precio y presupuesto" },
  { id: "watch", label: "Vigilar", hint: "Se refresca solo y avisa si cambia" },
  { id: "save", label: "Guardar", hint: "Lo aparta para mirarlo luego" },
  { id: "discard", label: "Descartar", hint: "Deja de aparecer en las listas" },
];

function ActionMenu({ onAction, status }: { onAction: (a: CardAction) => void; status: string }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", escape);
    };
  }, [abierto]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-label="Más acciones"
        aria-expanded={abierto}
        className="flex h-11 w-11 md:h-9 md:w-9 items-center justify-center rounded-xl border border-brand-border text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text transition-colors"
      >
        <IconMore size={16} />
      </button>
      {abierto && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-xl border border-brand-border bg-brand-surface p-1 shadow-lg">
          {ACCIONES.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                setAbierto(false);
                onAction(a.id);
              }}
              className="w-full rounded-lg px-3 py-2 text-left hover:bg-brand-surface-2 transition-colors"
            >
              <div className="text-[13px] font-medium">{a.label}</div>
              <div className="text-[11px] text-brand-tertiary">{a.hint}</div>
            </button>
          ))}
          {status !== "new" && (
            <div className="border-t border-brand-border px-3 py-1.5 text-[11px] text-brand-tertiary">
              Ahora está en «{status}»
            </div>
          )}
        </div>
      )}
    </div>
  );
}
