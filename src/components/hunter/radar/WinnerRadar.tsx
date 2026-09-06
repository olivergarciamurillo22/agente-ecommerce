"use client";

// ============================================================
// WINNER RADAR — EL MÓDULO.
//
// Un solo recorrido: escribir → ver cómo trabaja → recibir la selección →
// operar sobre los productos. No hay pestañas que obliguen a decidir dónde
// mirar antes de haber buscado nada.
//
// DOS COSAS QUE PARECEN DETALLE Y NO LO SON:
//
// 1. LA BÚSQUEDA VIVE EN EL SERVIDOR. Minimizar, irse a Pedidos y volver no
//    la cancela; al volver se retoma donde iba. Si la vista fuera la dueña
//    del proceso, cambiar de pantalla tiraría tres minutos de trabajo y la
//    cuota de Meta que se llevaron.
//
// 2. EL SONDEO SE CALLA SOLO. Con `usePolling`, la pestaña de fondo deja de
//    preguntar y nunca se solapan dos peticiones. Un `setInterval` a secas
//    acaba pidiendo toda la tarde para pintar algo que nadie mira.
// ============================================================

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePolling } from "@/components/usePolling";
import { navigateHash } from "@/components/useBackable";
import type { HunterFilters, ProductOpportunity, SearchRun } from "@/lib/hunter/types";
import type { RadarReadiness } from "@/lib/hunter/providers/registry";
import { IconClock, IconSearch } from "@/components/icons";
import { SkeletonRows } from "@/components/ui";
import RadarHome, { QUICK_CHIPS, type PlanPreview } from "./RadarHome";
import RadarProgress, { type LiveRun } from "./RadarProgress";
import type { CardAction } from "./OpportunityCard";
import type { DetailPayload } from "./OpportunityDetail";

// Cada pantalla se carga cuando hace falta. La inicial es lo único que se
// paga al abrir el módulo, y es lo único que se ve al abrirlo.
const RadarResults = lazy(() => import("./RadarResults"));
const RadarHistory = lazy(() => import("./RadarHistory"));
const RadarFilters = lazy(() => import("./RadarFilters"));
const OpportunityDetail = lazy(() => import("./OpportunityDetail"));

type Vista = "inicio" | "progreso" | "resultados" | "historial" | "detalle";

/** Mientras corre se pregunta cada 2 s; con la pestaña de fondo, nada. */
const POLL_MS = 2000;

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const b = (await r.json()) as Record<string, unknown>;
    if (!r.ok || b.ok === false) return { ok: false, error: String(b.error ?? `error ${r.status}`) };
    return { ok: true, data: b as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fallo de red" };
  }
}

export default function WinnerRadar({ toolbar }: { toolbar?: React.ReactNode } = {}) {
  const [vista, setVista] = useState<Vista>("inicio");
  const [readiness, setReadiness] = useState<RadarReadiness | null>(null);

  const [prompt, setPrompt] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Partial<HunterFilters>>({});
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);

  const [run, setRun] = useState<LiveRun | null>(null);
  const [ops, setOps] = useState<ProductOpportunity[]>([]);
  const [historial, setHistorial] = useState<SearchRun[]>([]);
  const [detalle, setDetalle] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lanzando, setLanzando] = useState(false);

  const corriendo = run !== null && (run.state === "running" || run.state === "queued");

  // --- Estado del módulo ---
  const cargarEstado = useCallback(async () => {
    const r = await api<{ readiness: RadarReadiness; recentSearches: SearchRun[] }>("/api/hunter");
    if (r.ok) {
      setReadiness(r.data.readiness);
      setHistorial(r.data.recentSearches ?? []);
      // Si había una búsqueda viva al recargar la página, se retoma. Sin
      // esto, un F5 daría a entender que se ha perdido lo que sigue corriendo.
      const viva = (r.data.recentSearches ?? []).find((s) => s.state === "running" || s.state === "queued");
      if (viva) {
        setRun(viva as LiveRun);
        setVista((v) => (v === "inicio" ? "progreso" : v));
      }
    } else setError(r.error);
  }, []);

  useEffect(() => {
    void cargarEstado();
  }, [cargarEstado]);

  // --- Sondeo del progreso ---
  const refrescarRun = useCallback(async () => {
    if (!run) return;
    const r = await api<{ run: LiveRun; opportunities: ProductOpportunity[] }>(`/api/hunter/search?id=${run.id}`);
    if (!r.ok) return;
    setRun(r.data.run);
    setOps(r.data.opportunities ?? []);
    if (r.data.run.state !== "running" && r.data.run.state !== "queued") {
      setLanzando(false);
      // Solo se salta a resultados si Pedro estaba MIRANDO el progreso. Si se
      // fue a otra pantalla, se le avisa con la píldora; secuestrarle la
      // navegación al terminar sería peor que no avisar.
      setVista((v) => (v === "progreso" ? "resultados" : v));
    }
  }, [run]);

  usePolling(refrescarRun, { intervalMs: POLL_MS, enabled: corriendo });

  // --- Filtros efectivos: chips + ajustes a mano ---
  const filtrosManuales = useMemo(() => {
    let out: Partial<HunterFilters> = {};
    for (const id of chips) {
      const c = QUICK_CHIPS.find((q) => q.id === id);
      if (!c) continue;
      out = {
        ...out,
        ...c.patch,
        // Las categorías se suman en vez de pisarse: elegir Hogar y Mascotas
        // tiene que buscar en las dos, no solo en la última pulsada.
        ...(c.patch.categories ? { categories: [...new Set([...(out.categories ?? []), ...c.patch.categories])] } : {}),
      };
    }
    return { ...out, ...overrides };
  }, [chips, overrides]);

  // --- Vista previa (gratis: ni red externa ni modelo) ---
  const pedirPreview = useCallback(
    async (p: string, _c: string[]) => {
      const r = await api<PlanPreview & { title: string | null }>("/api/hunter/search?dryRun=1&preview=1", {
        method: "POST",
        body: JSON.stringify({ prompt: p, filters: filtrosManuales, preview: true }),
      });
      if (r.ok) setPreview(r.data);
    },
    [filtrosManuales]
  );

  // --- Lanzar ---
  const buscar = useCallback(async () => {
    setError(null);
    setLanzando(true);
    setOps([]);
    const r = await api<{ searchId: string; run: LiveRun }>("/api/hunter/search", {
      method: "POST",
      body: JSON.stringify({ prompt, filters: filtrosManuales }),
    });
    if (!r.ok) {
      setError(r.error);
      setLanzando(false);
      return;
    }
    setRun(r.data.run);
    setVista("progreso");
  }, [prompt, filtrosManuales]);

  // --- Abrir ficha ---
  const abrir = useCallback(async (op: ProductOpportunity) => {
    const r = await api<DetailPayload>(`/api/hunter/opportunities?id=${encodeURIComponent(op.id)}`);
    if (r.ok) {
      setDetalle(r.data);
      setVista("detalle");
    } else setError(r.error);
  }, []);

  const cerrarDetalle = useCallback(() => {
    setDetalle(null);
    setVista("resultados");
  }, []);

  // --- Decidir ---
  const DECISION: Record<CardAction, string> = { test: "test", watch: "watch", save: "save", discard: "discard" };
  const decidir = useCallback(async (op: ProductOpportunity, a: CardAction) => {
    const r = await api<{ opportunity: ProductOpportunity }>("/api/hunter/decision", {
      method: "POST",
      body: JSON.stringify({ productId: op.id, decision: DECISION[a] }),
    });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setOps((prev) => prev.map((o) => (o.id === op.id ? { ...o, status: r.data.opportunity.status } : o)));
    setDetalle((d) => (d && d.opportunity.id === op.id ? { ...d, opportunity: { ...d.opportunity, status: r.data.opportunity.status } } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const abrirHistorial = useCallback(async (r: SearchRun) => {
    const res = await api<{ run: LiveRun; opportunities: ProductOpportunity[] }>(`/api/hunter/search?id=${r.id}`);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRun(res.data.run);
    setOps(res.data.opportunities ?? []);
    setVista(res.data.run.state === "running" || res.data.run.state === "queued" ? "progreso" : "resultados");
  }, []);

  const nuevaBusqueda = useCallback(() => {
    setVista("inicio");
    navigateHash("#winner-radar", "push");
  }, []);

  // La frase de «por qué interesa» se compone en el cliente con lo OBSERVADO.
  // Se duplica aquí a propósito en lugar de importar `verdict.ts`: ese módulo
  // arrastra la puntuación y, por ella, el acceso a datos.
  const why = useCallback((op: ProductOpportunity): string => {
    if (op.summary?.observed?.length) {
      const mom = op.scores.momentum.score;
      const sat = op.scores.saturation.score;
      const cabeza =
        mom !== null && mom >= 65 && sat !== null && sat <= 50
          ? "Está acelerando sin señales claras de saturación"
          : mom !== null && mom >= 65
            ? "Está acelerando"
            : sat !== null && sat >= 70
              ? "Mercado concurrido"
              : op.signals.oldestActiveAdDays !== null && op.signals.oldestActiveAdDays >= 60
                ? `Lleva ${op.signals.oldestActiveAdDays} días vendiéndose sin parar`
                : "Señal temprana";
      const n = (v: number, s1: string, s2: string) => `${v} ${v === 1 ? s1 : s2}`;
      const datos: string[] = [];
      if (op.signals.newAdvertisers14d) datos.push(n(op.signals.newAdvertisers14d, "anunciante nuevo en 14 días", "anunciantes nuevos en 14 días"));
      else if (op.signals.advertiserCount) datos.push(n(op.signals.advertiserCount, "anunciante", "anunciantes"));
      if (op.signals.activeAds) datos.push(n(op.signals.activeAds, "creatividad activa", "creatividades activas"));
      return datos.length ? `${cabeza}. ${datos.join(" y ")}.` : `${cabeza}.`;
    }
    return op.description ?? "Todavía sin lectura: hacen falta más anuncios.";
  }, []);

  return (
    <div className={`relative h-full bg-brand-bg ${vista === "detalle" ? "overflow-hidden" : "overflow-y-auto"}`}>
      {/* Barra fina: solo lo que se necesita saber estando en cualquier vista.
          En la ficha no aparece: esa pantalla trae su propia cabecera y su
          "volver", y dos filas de navegación apiladas hacen dudar de dónde
          estás y qué cierra cada cosa. */}
      <div className={`sticky top-0 z-20 items-center justify-between gap-2 border-b border-brand-border bg-brand-bg/85 px-4 md:px-8 py-2.5 backdrop-blur ${vista === "detalle" ? "hidden" : "flex"}`}>
        {/* `min-w-0` + scroll horizontal: sin esto, en 390 px las pestañas y
            la etiqueta de datos de ejemplo se montaban una encima de otra. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto no-scrollbar">
          {toolbar}
          {/* El aviso de datos de ejemplo va en la BARRA, no solo en los
              resultados: si solo se ve al final, se puede pasar una búsqueda
              entera creyendo que los productos son reales. */}
          {readiness?.fixtureMode ? (
            <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[.08em] text-amber-900">
              <span className="hidden sm:inline">Datos de ejemplo</span>
              <span className="sm:hidden">Ejemplo</span>
            </span>
          ) : readiness?.activeProvider === "meta_ad_library" ? (
            <span className="hidden lg:inline text-[11px] text-brand-tertiary">Biblioteca de Anuncios de Meta</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {corriendo && vista !== "progreso" && (
            <button
              type="button"
              onClick={() => setVista("progreso")}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand-gold px-3 h-8 text-[12px] font-medium text-white"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white brand-pulse" aria-hidden />
              Radar trabajando
            </button>
          )}
          {vista !== "inicio" && (
            <button
              type="button"
              onClick={nuevaBusqueda}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 h-8 text-[12.5px] text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text transition-colors"
            >
              <IconSearch size={14} />
              Buscar
            </button>
          )}
          <button
            type="button"
            onClick={() => setVista("historial")}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 h-8 text-[12.5px] text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text transition-colors"
          >
            <IconClock size={14} />
            Historial
          </button>
        </div>
      </div>

      {vista === "inicio" && (
        <RadarHome
          readiness={readiness}
          prompt={prompt}
          onPromptChange={setPrompt}
          chips={chips}
          onToggleChip={(id) => setChips((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
          preview={preview}
          onPreview={pedirPreview}
          onOpenFilters={() => setFiltrosAbiertos(true)}
          onSearch={buscar}
          busy={lanzando}
          error={error}
        />
      )}

      {vista === "progreso" && run && (
        <RadarProgress run={run} onMinimize={() => setVista("inicio")} onCancelView={() => setVista("inicio")} />
      )}

      <Suspense fallback={<div className="px-4 md:px-8 py-8"><SkeletonRows rows={5} /></div>}>
        {vista === "resultados" && run && (
          <RadarResults
            run={run}
            opportunities={ops}
            why={why}
            onOpen={abrir}
            onAction={decidir}
            onNewSearch={nuevaBusqueda}
          />
        )}

        {vista === "historial" && (
          <RadarHistory runs={historial} onOpen={abrirHistorial} onNewSearch={nuevaBusqueda} />
        )}

        {filtrosAbiertos && preview && (
          <RadarFilters
            filters={{ ...preview.filters, ...filtrosManuales } as HunterFilters}
            onChange={(patch) => setOverrides((o) => ({ ...o, ...patch }))}
            onClose={() => setFiltrosAbiertos(false)}
            onReset={() => {
              setOverrides({});
              setChips([]);
            }}
          />
        )}

        {vista === "detalle" && detalle && (
          <OpportunityDetail
            data={detalle}
            onClose={cerrarDetalle}
            onAction={(a) => void decidir(detalle.opportunity, a)}
          />
        )}
      </Suspense>
    </div>
  );
}
