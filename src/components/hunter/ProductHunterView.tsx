"use client";

// ============================================================
// CAZADOR DE PRODUCTOS — pantalla del módulo.
//
// Buscar · Guardados · Comparar sobre /api/product-hunter, más Landing
// Studio sobre un LandingBlueprint local estructurado y versionado.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState, ErrorState, GhostButton, Skeleton, TabBar } from "../ui";
import type { AdLibraryResult, ProductHunterAvailability, ProductResearchStatus, WinningProductCandidate } from "@/lib/product-hunter/types";
import CandidateDetail, { type DetailTarget } from "./CandidateDetail";
import CompareTable from "./CompareTable";
import { hunterGet, InlineNotice, MAX_COMPARE } from "./hunter-shared";
import PipelineBoard from "./PipelineBoard";
import SearchView from "./SearchView";
import LandingStudio from "../landing-studio/LandingStudio";
import WinnerRadar from "./radar/WinnerRadar";

type HunterTab = "radar" | "search" | "saved" | "compare" | "studio";

/**
 * Tres cosas distintas conviven en el Cazador y sin separarlas parecen una
 * lista arbitraria de pestañas: ENCONTRAR productos (el Radar), TRABAJAR los
 * candidatos guardados (el pipeline heredado) y PUBLICAR la landing.
 */
const SECCIONES: ReadonlyArray<{ id: "radar" | "candidatos" | "studio"; label: string }> = [
  { id: "radar", label: "Radar" },
  { id: "candidatos", label: "Mis candidatos" },
  { id: "studio", label: "Landing Studio" },
];

interface Notice {
  tone: "ok" | "error" | "info";
  text: string;
}

export default function ProductHunterView({ initialTab }: { initialTab?: "radar" | "studio" } = {}) {
  const [availability, setAvailability] = useState<ProductHunterAvailability | null>(null);
  const [availError, setAvailError] = useState<string | null>(null);
  const [tab, setTab] = useState<HunterTab>(() => {
    if (initialTab) return initialTab;
    // Por defecto, el Radar: es lo que de verdad encuentra productos. Antes se
    // abría en «Estado», una pantalla vacía del backend heredado, y el módulo
    // parecía roto desde el primer segundo.
    return typeof window !== "undefined" && window.location.hash === "#landing-studio" ? "studio" : "radar";
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

  const cambiarPestana = useCallback((next: HunterTab) => {
    setTab(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", next === "studio" ? "#landing-studio" : "#cazador");
    }
  }, []);

  // Tira de secciones. Vive DENTRO de la barra del radar cuando estamos en él:
  // dos tiras apiladas (nombre del módulo arriba, secciones debajo) es
  // justamente el aspecto de backoffice que sobraba.
  const tiraSecciones = (
    <nav className="flex min-w-0 items-center gap-0.5" aria-label="Secciones del cazador">
      {SECCIONES.filter((sec) => sec.id !== "candidatos" || availability?.available).map((sec) => (
        <button
          key={sec.id}
          type="button"
          onClick={() => cambiarPestana(sec.id === "candidatos" ? "search" : (sec.id as HunterTab))}
          aria-current={sec.id === "candidatos" ? tab === "search" || tab === "saved" || tab === "compare" : tab === sec.id}
          className={`whitespace-nowrap rounded-lg px-2.5 h-8 text-[12.5px] font-medium transition-colors ${
            (sec.id === "candidatos" ? tab === "search" || tab === "saved" || tab === "compare" : tab === sec.id)
              ? "bg-brand-surface text-brand-text shadow-sm"
              : "text-brand-muted hover:text-brand-text"
          }`}
        >
          {sec.label}
        </button>
      ))}
    </nav>
  );

  // El Radar se sirve a pantalla completa: tiene su propia cabecera y su
  // propio recorrido, y envolverlo en el título de página le robaba 120 px
  // de alto sin decir nada nuevo.
  if (tab === "radar") {
    return (
      <>
        <WinnerRadar toolbar={tiraSecciones} />
        <CandidateDetail target={detail} onClose={closeDetail} onChanged={onChanged} compareIds={compareIds} onToggleCompare={toggleCompare} />
      </>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-brand-border bg-brand-bg/85 px-4 md:px-8 py-2.5 backdrop-blur">
        {tiraSecciones}
      </div>
      <div className="px-4 md:px-8 py-6 pb-8">
      <div className="space-y-6">
        {availError ? (
          <Card>
            <ErrorState message={availError} onRetry={() => void loadAvailability()} />
          </Card>
        ) : availability === null ? (
          <div className="space-y-4" aria-busy>
            <Skeleton className="h-11 w-full" />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-72" />
              ))}
            </div>
          </div>
        ) : (
          <>
            {tab !== "studio" && availability.available && (
              <TabBar
                tabs={[
                  { id: "search", label: "Buscar" },
                  { id: "saved", label: "Guardados" },
                  { id: "compare", label: "Comparar" },
                ]}
                value={tab as "search" | "saved" | "compare"}
                onChange={(next) => cambiarPestana(next)}
                label="Vistas de candidatos"
                counts={{ compare: compareIds.length > 0 ? compareIds.length : undefined }}
              />
            )}

            {availability.source === "mock" && tab !== "studio" ? (
              <InlineNotice tone="info">Estás viendo datos de ejemplo del modo mock: anunciantes y puntuaciones ficticios. En producción este modo no arranca.</InlineNotice>
            ) : null}
            {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}

            {tab === "studio" ? (
              <LandingStudio />
            ) : !availability.available ? (
              <Card>
                <EmptyState
                  title="El pipeline de candidatos usa otro backend"
                  hint={`Esta pestaña es el flujo antiguo (descubierto → ganador) y necesita PRODUCT_HUNTER_SOURCE configurado. Para encontrar productos usa el Radar, que ya funciona. ${availability.reason}`}
                />
                <div className="flex justify-center pb-8 -mt-4">
                  <GhostButton onClick={() => void loadAvailability()}>Reintentar conexión</GhostButton>
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
      </div>

      <CandidateDetail target={detail} onClose={closeDetail} onChanged={onChanged} compareIds={compareIds} onToggleCompare={toggleCompare} />
    </div>
  );
}
