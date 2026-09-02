"use client";

// Tarjeta de resultado de la Ad Library. Todo dato ausente se pinta como
// "No disponible": nunca un 0, nunca una estimación.

import { useState } from "react";
import { Card, GhostButton, PrimaryButton } from "../ui";
import { landingDomain, UNAVAILABLE_LABEL } from "@/lib/product-hunter/scoring";
import {
  CREATIVE_FORMAT_LABEL,
  PRODUCT_RESEARCH_STATUS_LABEL,
  type AdLibraryResult,
  type ProductResearchStatus,
} from "@/lib/product-hunter/types";
import {
  CheckIcon,
  CountryChips,
  DataStatusPill,
  formatDate,
  formatDays,
  formatPrice,
  formatVariations,
  Pill,
  ScoreMini,
} from "./hunter-shared";

/** Imagen perezosa con marcador cuando no hay preview o falla la carga. */
export function PreviewImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-brand-muted/70">
        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 16l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-[11px]">Sin vista previa</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
  );
}

/** Botón conmutable con estado activo visible (para "Comparar"). */
export function ToggleButton({
  active,
  disabled,
  onClick,
  children,
  size = "md",
  className = "",
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  size?: "md" | "sm";
  className?: string;
}) {
  const sizeClass = size === "sm" ? "min-h-11 md:min-h-9 px-2.5 py-1 text-xs" : "min-h-11 md:min-h-9 px-3.5 py-2 text-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border ${sizeClass} transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "border-brand-border-strong bg-brand-surface-2 text-brand-text"
          : "border-brand-border text-brand-text hover:border-brand-muted/70 hover:bg-brand-surface-2"
      } ${className}`}
    >
      {active ? <CheckIcon /> : null}
      {children}
    </button>
  );
}

export function displayName(r: { productName: string | null }): string {
  return r.productName ?? "Producto sin identificar";
}

export default function CandidateCard({
  result,
  savedStatus,
  compared,
  compareFull,
  saving,
  onSave,
  onToggleCompare,
  onOpenDetail,
}: {
  result: AdLibraryResult;
  savedStatus: ProductResearchStatus | null;
  compared: boolean;
  compareFull: boolean;
  saving: boolean;
  onSave: () => void;
  onToggleCompare: () => void;
  onOpenDetail: () => void;
}) {
  const name = displayName(result);
  const domain = landingDomain(result.landingUrl);
  const saved = savedStatus !== null && savedStatus !== "discovered";

  return (
    <Card className="overflow-hidden flex flex-col">
      <button
        type="button"
        onClick={onOpenDetail}
        aria-label={`Ver detalle de ${name}`}
        className="relative aspect-video w-full bg-brand-surface-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-text/30"
      >
        <PreviewImage src={result.previewUrl} alt="" />
        <span className="absolute left-2.5 top-2.5">
          <Pill>{result.format ? CREATIVE_FORMAT_LABEL[result.format] : "Formato no disponible"}</Pill>
        </span>
        <span className="absolute right-2.5 top-2.5">
          <DataStatusPill status={result.dataStatus} />
        </span>
      </button>

      <div className="p-4 flex-1 flex flex-col gap-3">
        <div>
          <div className="flex items-start justify-between gap-3">
            <h3 className={`text-sm font-semibold leading-snug line-clamp-2 ${result.productName ? "text-brand-text" : "text-brand-muted italic"}`}>{name}</h3>
            <ScoreMini score={result.winnerScore} />
          </div>
          <div className="mt-0.5 text-xs text-brand-muted truncate">{result.advertiser ?? `Anunciante ${UNAVAILABLE_LABEL.toLowerCase()}`}</div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <CountryChips countries={result.countries} />
          {result.cta ? <Pill tone="accent">{result.cta}</Pill> : null}
        </div>

        <div className="space-y-1 text-xs text-brand-muted">
          <div className="truncate">
            {result.startedAt ? `Desde ${formatDate(result.startedAt)}` : `Inicio ${UNAVAILABLE_LABEL.toLowerCase()}`} · {formatDays(result.activeDays)}
          </div>
          <div className="truncate">
            {formatVariations(result.variations)} · {domain ?? `landing ${UNAVAILABLE_LABEL.toLowerCase()}`}
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] font-medium text-brand-muted">Precio detectado</span>
          <span className={`text-sm tabular-nums ${result.detectedPrice ? "font-semibold text-brand-text" : "text-brand-muted"}`}>{formatPrice(result.detectedPrice)}</span>
        </div>

        <div className="mt-auto pt-3 border-t border-brand-border/60 flex flex-wrap items-center gap-2">
          {saved ? (
            <Pill tone="accent" title="Ya está en tu pipeline">
              <CheckIcon />
              {PRODUCT_RESEARCH_STATUS_LABEL[savedStatus]}
            </Pill>
          ) : (
            <PrimaryButton onClick={onSave} busy={saving} className="min-h-11 md:min-h-0">
              Guardar
            </PrimaryButton>
          )}
          <ToggleButton active={compared} disabled={!compared && compareFull} onClick={onToggleCompare} className="min-h-11 md:min-h-0">
            {compared ? "Comparando" : "Comparar"}
          </ToggleButton>
          <GhostButton onClick={onOpenDetail} className="ml-auto min-h-11 md:min-h-0">
            Detalle
          </GhostButton>
        </div>
      </div>
    </Card>
  );
}
