"use client";

// ============================================================
// WINNER RADAR — PANTALLA INICIAL.
//
// Una pregunta, un sitio donde escribir, un botón. Nada más a la vista.
//
// POR QUÉ NO HAY VEINTE FILTROS DELANTE:
// un formulario con veinte campos obliga a decidir veinte cosas antes de
// saber si hay algo que encontrar. Casi todas esas decisiones son peores
// tomadas a ciegas que dejadas en su valor por defecto. Los filtros existen
// —completos— pero detrás de «Ajustar búsqueda», que se puede ignorar
// entero.
//
// La FRASE de vista previa se construye con código y sin salir a la red, así
// que aparece mientras Pedro escribe sin costar una llamada por tecla. La
// estrategia de consultas —que sí usa el modelo— se calcula una vez, al
// lanzar la búsqueda.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HunterFilters } from "@/lib/hunter/types";
import type { RadarReadiness } from "@/lib/hunter/providers/registry";
import { IconFilter, IconSearch } from "@/components/icons";

export interface PlanPreview {
  title: string | null;
  sentence: string;
  chips: Array<{ field: keyof HunterFilters; label: string; index?: number }>;
  queries: string[];
  strategy: string[];
  filters: HunterFilters;
  estimateSeconds: number | null;
  /** Ya viene redactado: horquilla si no hay histórico, cifra si lo hay. */
  estimateLabel: string | null;
  estimateFromHistory: boolean;
  notes: string[];
}

/** Atajos. Cada uno rellena criterios; ninguno es obligatorio. */
export const QUICK_CHIPS: ReadonlyArray<{
  id: string;
  label: string;
  group: "Mercado" | "Categoría" | "Precio" | "Señal" | "Riesgo";
  patch: Partial<HunterFilters>;
}> = [
  { id: "es", label: "España", group: "Mercado", patch: { country: "ES" } },
  { id: "cod", label: "Contrareembolso", group: "Mercado", patch: { codFit: true } },
  { id: "hogar", label: "Hogar", group: "Categoría", patch: { categories: ["hogar"] } },
  { id: "mascotas", label: "Mascotas", group: "Categoría", patch: { categories: ["mascotas"] } },
  { id: "coche", label: "Coche", group: "Categoría", patch: { categories: ["coche"] } },
  { id: "cocina", label: "Cocina", group: "Categoría", patch: { categories: ["cocina"] } },
  { id: "t2040", label: "20–40 €", group: "Precio", patch: { priceMin: 20, priceMax: 40 } },
  { id: "t4060", label: "40–60 €", group: "Precio", patch: { priceMin: 40, priceMax: 60 } },
  { id: "lowsat", label: "Poca competencia", group: "Señal", patch: { saturationMax: 45 } },
  { id: "rising", label: "En alza", group: "Señal", patch: { momentumMin: 60 } },
  { id: "nofragile", label: "No frágil", group: "Riesgo", patch: { fragile: false } },
  { id: "nosizing", label: "Sin tallas", group: "Riesgo", patch: { requiresSizing: false } },
];

const EJEMPLOS = [
  "Algo para el coche que se vea muy bien en vídeo, 30–45 €, que no esté quemado",
  "Productos de mascotas para España, contrareembolso, 25–50 €, no frágiles",
  "Hogar, que se entienda en tres segundos, coste de proveedor menor de 12 €",
];

export default function RadarHome({
  readiness,
  prompt,
  onPromptChange,
  chips,
  onToggleChip,
  preview,
  onPreview,
  onOpenFilters,
  onSearch,
  busy,
  error,
}: {
  readiness: RadarReadiness | null;
  prompt: string;
  onPromptChange: (v: string) => void;
  chips: string[];
  onToggleChip: (id: string) => void;
  preview: PlanPreview | null;
  onPreview: (prompt: string, chips: string[]) => void;
  onOpenFilters: () => void;
  onSearch: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [verEstrategia, setVerEstrategia] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [ejemplo] = useState(() => EJEMPLOS[Math.floor(Math.random() * EJEMPLOS.length)]);

  // Vista previa al hacer pausa. 700 ms: lo justo para no recalcular a cada
  // tecla y lo bastante rápido para que parezca instantáneo.
  useEffect(() => {
    if (prompt.trim().length < 4 && chips.length === 0) return;
    const t = setTimeout(() => onPreview(prompt, chips), 700);
    return () => clearTimeout(t);
  }, [prompt, chips, onPreview]);

  const puedeBuscar = (prompt.trim().length >= 3 || chips.length > 0) && !busy && readiness?.canSearch !== false;

  const alTeclear = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter busca; Mayús+Enter hace salto de línea. Es lo que la gente ya
      // espera de un campo así, y evita tener que ir al ratón.
      if (e.key === "Enter" && !e.shiftKey && puedeBuscar) {
        e.preventDefault();
        onSearch();
      }
    },
    [onSearch, puedeBuscar]
  );

  const porGrupo = useMemo(() => {
    const m = new Map<string, typeof QUICK_CHIPS>();
    for (const c of QUICK_CHIPS) {
      const l = m.get(c.group) ?? [];
      m.set(c.group, [...l, c] as typeof QUICK_CHIPS);
    }
    return [...m.entries()];
  }, []);

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 md:px-6 pt-10 pb-16 md:pt-16">
      <div className="text-center">
        <h1 className="text-[26px] md:text-[32px] font-semibold tracking-tight text-balance">
          ¿Qué producto quieres encontrar?
        </h1>
        <p className="mt-2 text-[14px] text-brand-muted text-balance">
          Descríbelo como se lo contarías a alguien. Del resto nos encargamos nosotros.
        </p>
      </div>

      {/* Barra de comando */}
      <div className="mt-7 rounded-2xl border border-brand-border bg-brand-surface shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_-12px_rgba(0,0,0,.10)] focus-within:border-brand-border-strong focus-within:shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_32px_-12px_rgba(0,0,0,.16)] transition-shadow">
        <textarea
          ref={areaRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={alTeclear}
          rows={3}
          autoFocus
          aria-label="Describe el producto que buscas"
          placeholder={ejemplo}
          className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[16px] leading-relaxed outline-none placeholder:text-brand-tertiary"
        />
        <div className="flex items-center justify-between gap-3 px-3 pb-3">
          <button
            type="button"
            onClick={onOpenFilters}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 h-9 text-[13px] text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text transition-colors"
          >
            <IconFilter size={16} />
            Ajustar búsqueda
          </button>
          <button
            type="button"
            onClick={onSearch}
            disabled={!puedeBuscar}
            className="inline-flex items-center gap-2 rounded-xl bg-brand-gold px-5 h-11 text-[14px] font-semibold text-white hover:bg-brand-gold-soft disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <IconSearch size={17} />
            Buscar oportunidades
          </button>
        </div>
      </div>

      {/* Atajos */}
      <div className="mt-5 space-y-2.5">
        {porGrupo.map(([grupo, lista]) => (
          <div key={grupo} className="flex flex-wrap items-center gap-1.5">
            <span className="w-[74px] shrink-0 text-[11px] uppercase tracking-[.08em] text-brand-tertiary">{grupo}</span>
            {lista.map((c) => {
              const activo = chips.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onToggleChip(c.id)}
                  aria-pressed={activo}
                  className={`rounded-full px-3 h-8 text-[13px] border transition-colors ${
                    activo
                      ? "border-brand-gold bg-brand-gold text-white"
                      : "border-brand-border bg-brand-surface text-brand-muted hover:border-brand-border-strong hover:text-brand-text"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Vista previa: la frase, no el JSON */}
      {preview && (
        <div className="mt-6 rounded-xl border border-brand-border bg-brand-surface-subtle px-4 py-3.5">
          <p className="text-[14px] leading-relaxed">{preview.sentence}</p>
          {preview.notes.length > 0 && (
            <p className="mt-1.5 text-[12px] text-amber-800">{preview.notes[0]}</p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {preview.chips.slice(0, 12).map((c, i) => (
              <span
                key={`${String(c.field)}-${c.index ?? i}`}
                className="rounded-md bg-brand-surface px-2 py-0.5 text-[12px] text-brand-muted ring-1 ring-inset ring-brand-border"
              >
                {c.label}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-brand-tertiary">
            {preview.estimateLabel && (
              <span>{preview.estimateFromHistory ? "Tardará unos" : "Suele tardar"} {preview.estimateLabel}</span>
            )}
            <button
              type="button"
              onClick={() => setVerEstrategia((v) => !v)}
              className="underline underline-offset-2 hover:text-brand-text transition-colors"
            >
              {verEstrategia ? "Ocultar estrategia" : `Ver estrategia (${preview.queries.length} búsquedas)`}
            </button>
          </div>
          {verEstrategia && (
            <div className="mt-3 border-t border-brand-border pt-3">
              {preview.strategy.length > 0 && (
                <ul className="mb-2.5 space-y-1 text-[12px] text-brand-muted">
                  {preview.strategy.map((s, i) => (
                    <li key={i}>· {s}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-1">
                {preview.queries.map((q) => (
                  <code key={q} className="rounded bg-brand-surface-2 px-1.5 py-0.5 text-[11px] text-brand-muted">
                    {q}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-900">{error}</div>
      )}

      {/* Estado de la fuente. Solo se enseña si HAY algo que resolver. */}
      {readiness && !readiness.canSearch && (
        <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="text-[13px] font-semibold text-amber-900">Falta conectar la fuente de anuncios</div>
          <p className="mt-0.5 text-[12px] text-amber-800">{readiness.reason}</p>
          {readiness.nextStep && <p className="mt-1 text-[12px] text-amber-900 font-medium">{readiness.nextStep}</p>}
        </div>
      )}
    </div>
  );
}
