"use client";

// ============================================================
// MARCA — Casamable · Control Center.
//
// No hay asset oficial del logo en el repo (buscado en public/, assets/ y
// docs/): wordmark tipográfico sobrio. SLOT PREPARADO: si algún día se
// añade public/brand/casamable.svg, sustituir el <span> del nombre por
// <img src="/brand/casamable.svg" …> y listo — nada más que tocar.
// ============================================================

/** Emblema mínimo: la "C" de Casamable en un sello redondo. */
export function Emblem({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="20" cy="20" r="19" fill="#17150f" stroke="rgba(250,197,28,0.55)" strokeWidth="1.5" />
      <path
        d="M26.5 14.2a8.4 8.4 0 1 0 .2 11.4"
        stroke="#fac51c"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Wordmark completo: emblema + CASAMABLE + Control Center. */
export default function Logo({ size = 22, subtitle = true }: { size?: number; subtitle?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none" aria-label="Casamable Control Center">
      <Emblem size={size * 1.4} />
      <div className="leading-none">
        <div
          className="font-display font-bold tracking-[0.02em] text-brand-text"
          style={{ fontSize: size }}
        >
          Casamable
        </div>
        {subtitle && (
          <div className="mt-0.5 text-[9px] font-semibold tracking-[0.32em] uppercase text-brand-muted">
            Control Center
          </div>
        )}
      </div>
    </div>
  );
}
