"use client";

// ============================================================
// CAZADOR DE PRODUCTOS — pantalla del módulo.
//
// Buscar · Guardados · Comparar sobre /api/product-hunter, más Landing
// Studio sobre un LandingBlueprint local estructurado y versionado.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState, ErrorState, GhostButton, ReadinessBadge, Skeleton, TabBar } from "../ui";
import type { AdLibraryResult, ProductHunterAvailability, ProductResearchStatus, WinningProductCandidate } from "@/lib/product-hunter/types";
import CandidateDetail, { type DetailTarget } from "./CandidateDetail";
import CompareTable from "./CompareTable";
import { hunterGet, InlineNotice, MAX_COMPARE, Pill } from "./hunter-shared";
import PipelineBoard from "./PipelineBoard";
import SearchView from "./SearchView";
import LandingStudio from "../landing-studio/LandingStudio";

type HunterTab = "search" | "saved" | "compare" | "studio";

interface Notice {
  tone: "ok" | "error" | "info";
  text: string;
}

export default function ProductHunterView({ initialTab }: { initialTab?: "search" | "studio" } = {}) {
  const [availability, setAvailability] = useState<ProductHunterAvailability | null>(null);
  const [availError, setAvailError] = useState<string | null>(null);
  const [tab, setTab] = useState<HunterTab>(() => {
    if (initialTab) return initialTab;
    return typeof window !== "undefined" && window.location.hash === "#landing-studio" ? "studio" : "search";
  });
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [savedMap, setSavedMap] = useState<Record<string, ProductResearchStatus>>({});
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAvailability = useCallback(async () => {
    setAvailError(null);
    const r = await hunterGet<{ availability: ProductHunterAvailability }>("availability");
    if (r.ok) setAvailability(r.availability);
    else setAvailError(r.error);
  }, []);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  useEffect(() => {
    const syncDeepLink = () => {
      if (window.location.hash === "#landing-studio") setTab("studio");
    };
    syncDeepLink();
    window.addEventListener("hashchange", syncDeepLink);
    return () => window.removeEventListener("hashchange", syncDeepLink);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const showNotice = useCallback((text: string, tone: Notice["tone"]) => {
    setNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  const toggleCompare = useCallback(
    (id: string) => {
      setCompareIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id);
        if (prev.length >= MAX_COMPARE) {
          showNotice(`Como máximo se comparan ${MAX_COMPARE} productos. Quita uno para añadir otro.`, "info");
          return prev;
        }
        return [...prev, id];
      });
    },
    [showNotice]
  );

  const onChanged = useCallback((c: WinningProductCandidate) => {
    setSavedMap((prev) => ({ ...prev, [c.id]: c.status }));
    setRefreshKey((k) => k + 1);
  }, []);

  const openResult = useCallback((r: AdLibraryResult) => setDetail({ id: r.id, initial: r }), []);
  const openCandidate = useCallback((c: WinningProductCandidate) => setDetail({ id: c.id, initial: c }), []);
  const closeDetail = useCallback(() => setDetail(null), []);

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-6 pb-8">
      <div className="space-y-6">
        {/* ── Título ── */}
        <header className="flex flex-col items-start gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="font-display text-[26px] md:text-[30px] font-semibold text-brand-text leading-[1.15] tracking-[-0.02em]">Cazador de productos</h1>
            <p className="mt-1.5 text-[14px] text-brand-muted max-w-2xl leading-snug">
              {availability && !availability.available
                ? "Puedes explorar la interfaz, pero todavía no hay una fuente real de productos conectada."
                : "Anuncios que llevan tiempo activos en la Biblioteca de anuncios de Meta, puntuados por el backend, para que decidas qué probar en COD."}
            </p>
          </div>
          {availability ? (
            availability.available ? (
              <Pill tone={availability.source === "mock" ? "warn" : "ok"} title={availability.reason}>
                {availability.source === "mock" ? "Datos de ejemplo" : "Conectado"}
              </Pill>
            ) : (
              <ReadinessBadge readiness="not_configured" title={availability.reason} />
            )
          ) : null}
        </header>

        {availError ? (
          <Card>
            <ErrorState message={availError} onRetry={() => void loadAvailability()} />
          </Card>
        ) : availability === null ? (
          <div className="space-y-4" aria-busy>
            <div className="flex gap-2" aria-hidden>
              {["w-24", "w-28", "w-32"].map((w) => (
                <div key={w} className={`h-8 ${w} animate-pulse rounded-lg bg-brand-surface-2`} />
              ))}
            </div>
            <Skeleton className="h-11 w-full" />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-72" />
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* ── Vistas ── */}
            <TabBar
              tabs={
                availability.available
                  ? [
                      { id: "search", label: "Buscar" },
                      { id: "saved", label: "Guardados" },
                      { id: "compare", label: "Comparar" },
                      { id: "studio", label: "Landing Studio" },
                    ]
                  : [
                      // Sin fuente conectada no hay nada que buscar, guardar ni
                      // comparar: enseñar esas pestañas sería prometer un
                      // descubrimiento que no puede ocurrir.
                      { id: "search", label: "Estado" },
                      { id: "studio", label: "Landing Studio" },
                    ]
              }
              value={tab}
              onChange={(next) => {
                setTab(next);
                if (typeof window !== "undefined") window.history.replaceState(null, "", next === "studio" ? "#landing-studio" : "#cazador");
              }}
              label="Vistas del cazador"
              counts={{ compare: compareIds.length > 0 ? compareIds.length : undefined }}
            />

            {availability.source === "mock" && tab !== "studio" ? (
              <InlineNotice tone="info">Estás viendo datos de ejemplo del modo mock: anunciantes y puntuaciones ficticios. En producción este modo no arranca.</InlineNotice>
            ) : null}
            {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

            {tab === "studio" ? (
              <LandingStudio />
            ) : !availability.available ? (
              <Card>
                <EmptyState
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" className="h-8 w-8" aria-hidden>
                      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M16 16l4.5 4.5M8 11h6M11 8v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  }
                  title="No hay una fuente de descubrimiento conectada"
                  hint={`Esto NO significa que no haya productos: significa que todavía no se ha buscado en ningún sitio. ${availability.reason}`}
                />
                <div className="flex justify-center pb-8 -mt-4">
                  <GhostButton onClick={() => void loadAvailability()}>Pendiente de conexión · reintentar</GhostButton>
                </div>
              </Card>
            ) : tab === "search" ? (
              <SearchView
                savedMap={savedMap}
                compareIds={compareIds}
                onToggleCompare={toggleCompare}
                onOpenDetail={openResult}
                onSaved={onChanged}
                onNotice={showNotice}
              />
            ) : tab === "saved" ? (
              <PipelineBoard
                refreshKey={refreshKey}
                compareIds={compareIds}
                onToggleCompare={toggleCompare}
                onOpenDetail={openCandidate}
                onChanged={onChanged}
                onNotice={showNotice}
              />
            ) : (
              <CompareTable
                ids={compareIds}
                onRemove={(id) => setCompareIds((prev) => prev.filter((x) => x !== id))}
                onClear={() => setCompareIds([])}
                onOpenDetail={openCandidate}
              />
            )}
          </>
        )}
      </div>

      <CandidateDetail target={detail} onClose={closeDetail} onChanged={onChanged} compareIds={compareIds} onToggleCompare={toggleCompare} />
    </div>
  );
}
