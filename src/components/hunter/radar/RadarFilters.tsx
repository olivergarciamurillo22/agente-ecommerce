"use client";

// ============================================================
// WINNER RADAR — AJUSTAR LA BÚSQUEDA.
//
// Este panel se puede IGNORAR ENTERO. Esa es su especificación, no un efecto
// secundario: quien no lo abre obtiene una búsqueda perfectamente válida.
//
// Por eso no hay ni un campo obligatorio, ni un asterisco, ni un «continuar».
// Se abre, se toca lo que se quiera y se cierra. Los cambios se aplican al
// momento; no hay un «guardar» que se pueda olvidar.
//
// La forma del panel NO se inventa aquí: es la misma que la ficha de pedido
// (`OrdersPanel`) — cajón a la derecha de 480 px en escritorio, hoja desde
// abajo en móvil, fondo oscurecido al 50 % y botón de cerrar CON BORDE. Una X
// sin borde sobre fondo claro no se lee como botón, y en una capa que tapa
// contenido eso deja al usuario sin salida visible.
//
// Los controles son de tres tipos y ninguno es un desplegable largo:
//   · segmentos  → cuando hay 2-4 opciones excluyentes
//   · chips      → cuando se pueden elegir varias
//   · números    → cuando el valor es una cifra que Pedro ya conoce (€, días)
// Un <select> de veinte opciones esconde diecinueve.
// ============================================================

import { useOverlayBack } from "@/components/useBackable";
import type { HunterFilters } from "@/lib/hunter/types";
import { PrimaryButton, TextButton } from "@/components/ui";
import { IconClose } from "@/components/icons";

const PAISES: Array<[string, string]> = [
  ["ES", "España"], ["PT", "Portugal"], ["IT", "Italia"], ["FR", "Francia"], ["DE", "Alemania"],
];

const CATEGORIAS: Array<[string, string]> = [
  ["hogar", "Hogar"], ["mascotas", "Mascotas"], ["coche", "Coche"], ["cocina", "Cocina"],
  ["belleza", "Belleza"], ["jardin", "Jardín"], ["bebe", "Bebé"], ["deporte", "Deporte"], ["salud", "Salud"],
];

export default function RadarFilters({
  filters,
  onChange,
  onClose,
  onReset,
}: {
  filters: HunterFilters;
  onChange: (patch: Partial<HunterFilters>) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  useOverlayBack(true, onClose);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal aria-label="Ajustar búsqueda">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        className="absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col rounded-t-2xl border-t border-brand-border bg-brand-surface shadow-2xl md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:h-full md:max-h-full md:w-[480px] md:max-w-full md:rounded-none md:border-t-0 md:border-l anim-slide-right"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-brand-border px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold tracking-tight">Ajustar búsqueda</h2>
            <p className="text-[12px] text-brand-tertiary">Todo esto es opcional.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 rounded-lg border border-brand-border p-2 text-brand-muted hover:border-brand-border-strong hover:bg-brand-surface-2 hover:text-brand-text transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30"
          >
            <IconClose size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <Grupo title="Mercado">
            <Segmentos
              label="País"
              value={filters.country}
              options={PAISES}
              onChange={(v) => onChange({ country: v })}
            />
            <Chips
              label="Categorías"
              hint="Ninguna = todas"
              options={CATEGORIAS}
              selected={filters.categories}
              onToggle={(v) =>
                onChange({
                  categories: filters.categories.includes(v)
                    ? filters.categories.filter((c) => c !== v)
                    : [...filters.categories, v],
                })
              }
            />
          </Grupo>

          <Grupo title="Precio">
            <div className="grid grid-cols-2 gap-3">
              <Numero label="Desde (€)" value={filters.priceMin} onChange={(v) => onChange({ priceMin: v })} />
              <Numero label="Hasta (€)" value={filters.priceMax} onChange={(v) => onChange({ priceMax: v })} />
            </div>
            <Numero
              label="Coste de proveedor máximo (€)"
              hint="Solo filtra los productos de los que conocemos el coste."
              value={filters.supplierCostMax}
              onChange={(v) => onChange({ supplierCostMax: v })}
            />
            <Numero
              label="Beneficio mínimo por pedido (€)"
              value={filters.minExpectedProfit}
              onChange={(v) => onChange({ minExpectedProfit: v })}
            />
          </Grupo>

          <Grupo title="Señal de mercado">
            <Deslizador
              label="Saturación máxima"
              hint={filters.saturationMax === null ? "Sin límite" : filters.saturationMax <= 45 ? "Solo poco disputados" : "Se admite competencia media"}
              value={filters.saturationMax}
              onChange={(v) => onChange({ saturationMax: v })}
            />
            <Deslizador
              label="Tendencia mínima"
              hint={filters.momentumMin === null ? "Da igual la tendencia" : "Solo lo que está creciendo"}
              value={filters.momentumMin}
              onChange={(v) => onChange({ momentumMin: v })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Numero label="Anunciantes mínimos" value={filters.minAdvertisers} onChange={(v) => onChange({ minAdvertisers: v })} />
              <Numero label="Días activo mínimo" value={filters.minDaysActive} onChange={(v) => onChange({ minDaysActive: v })} />
            </div>
          </Grupo>

          <Grupo title="Producto">
            <Deslizador
              label="Facilidad de demostrar en vídeo"
              hint="Un producto que se entiende viéndolo funcionar vende solo."
              value={filters.demoability}
              onChange={(v) => onChange({ demoability: v })}
            />
            <Deslizador
              label="Claridad del problema"
              value={filters.problemClarity}
              onChange={(v) => onChange({ problemClarity: v })}
            />
            <Tres
              label="Se vende todo el año"
              value={filters.evergreen}
              onChange={(v) => onChange({ evergreen: v })}
            />
          </Grupo>

          <Grupo title="Riesgo">
            <Tres label="Frágil" value={filters.fragile} onChange={(v) => onChange({ fragile: v })} negativo />
            <Tres label="Con tallas" value={filters.requiresSizing} onChange={(v) => onChange({ requiresSizing: v })} negativo />
            <Tres label="Electrónica" value={filters.electronics} onChange={(v) => onChange({ electronics: v })} negativo />
            <p className="text-[11px] leading-relaxed text-brand-tertiary">
              Estos tres los infiere la IA leyendo los anuncios. Si de un producto no se sabe, NO se descarta: se deja
              pasar y se marca. Descartar por ignorancia se lleva por delante productos buenos.
            </p>
          </Grupo>
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-brand-border px-5 py-3 pb-[max(env(safe-area-inset-bottom),12px)]">
          <TextButton onClick={onReset}>Quitar todos</TextButton>
          <PrimaryButton onClick={onClose}>Listo</PrimaryButton>
        </footer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------

function Grupo({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[.12em] text-brand-tertiary">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Etiqueta({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-brand-tertiary">{hint}</span>}
    </div>
  );
}

function Segmentos({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Etiqueta label={label} />
      <div className="flex flex-wrap gap-1 rounded-xl bg-brand-surface-2 p-1">
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={value === v}
            className={`flex-1 rounded-lg px-3 h-9 text-[13px] font-medium transition-colors ${
              value === v ? "bg-brand-surface text-brand-text shadow-sm" : "text-brand-muted hover:text-brand-text"
            }`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Chips({
  label,
  hint,
  options,
  selected,
  onToggle,
}: {
  label: string;
  hint?: string;
  options: Array<[string, string]>;
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div>
      <Etiqueta label={label} hint={hint} />
      <div className="flex flex-wrap gap-1.5">
        {options.map(([v, l]) => {
          const on = selected.includes(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => onToggle(v)}
              aria-pressed={on}
              className={`rounded-full px-3 h-9 text-[13px] border transition-colors ${
                on ? "border-brand-gold bg-brand-gold text-white" : "border-brand-border text-brand-muted hover:border-brand-border-strong"
              }`}
            >
              {l}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Numero({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <Etiqueta label={label} hint={hint} />
      <input
        type="number"
        inputMode="decimal"
        value={value ?? ""}
        placeholder="sin límite"
        onChange={(e) => {
          const t = e.target.value.trim();
          const n = t === "" ? null : Number(t);
          onChange(n === null || !Number.isFinite(n) ? null : n);
        }}
        className="w-full h-11 rounded-xl border border-brand-border bg-brand-surface px-3 text-[14px] tabular-nums outline-none focus:border-brand-border-strong"
      />
    </div>
  );
}

/**
 * Deslizador con estado APAGADO explícito. Un slider que arranca en 0 hace
 * creer que el filtro está puesto en «0» cuando lo que pasa es que no hay
 * filtro: son cosas distintas y confundirlas descarta productos sin querer.
 */
function Deslizador({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const activo = value !== null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <button
          type="button"
          onClick={() => onChange(activo ? null : 50)}
          className="text-[11px] text-brand-info underline underline-offset-2"
        >
          {activo ? "quitar" : "usar"}
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value ?? 50}
        disabled={!activo}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--color-brand-gold)] disabled:opacity-35"
      />
      <div className="mt-0.5 text-[11px] text-brand-tertiary">{activo ? `${value} · ${hint ?? ""}` : (hint ?? "sin filtro")}</div>
    </div>
  );
}

/**
 * Tres estados de verdad: da igual · sí · no. Un interruptor de dos posiciones
 * no puede decir «da igual», y ese es el valor por defecto correcto en casi
 * todos estos campos.
 */
function Tres({
  label,
  value,
  onChange,
  negativo = false,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  negativo?: boolean;
}) {
  const opciones: Array<[boolean | null, string]> = [
    [null, "Da igual"],
    [true, negativo ? "Permitir" : "Sí"],
    [false, negativo ? "Evitar" : "No"],
  ];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px]">{label}</span>
      <div className="flex gap-1 rounded-xl bg-brand-surface-2 p-1">
        {opciones.map(([v, l]) => (
          <button
            key={String(v)}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={value === v}
            className={`rounded-lg px-2.5 h-8 text-[12px] font-medium transition-colors ${
              value === v ? "bg-brand-surface text-brand-text shadow-sm" : "text-brand-muted hover:text-brand-text"
            }`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
