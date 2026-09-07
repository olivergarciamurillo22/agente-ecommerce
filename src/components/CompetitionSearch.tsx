"use client";

// ============================================================
// BUSCADOR DE COMPETENCIA — pestaña "Competencia" (07-09-2026)
// docs/HUNTER-BUSCADOR.md
//
// El panel SOLO encola y pregunta por el estado: la búsqueda dura hasta quince
// minutos y la ejecuta el proceso del bot. Aquí no hay ninguna llamada a Meta.
//
// Reglas de lo que se enseña, y por qué:
//  · Cada señal lleva su etiqueta (dato / señal / declarado). La Ad Library NO
//    da gasto, impresiones ni CTR de anuncios comerciales: enseñar un número
//    de rendimiento sería inventarlo.
//  · NUNCA "disponible en X países": una búsqueda consulta UN país, así que
//    solo podemos decir en cuáles LO HEMOS ENCONTRADO.
//  · El dominio va marcado como declarado por el anunciante, sin verificar.
//  · Sin análisis del creativo por IA: esa función está desactivada.
//  · Si EMERGENCY_STOP está activo, se dice ARRIBA y el botón se bloquea, en
//    vez de dejar lanzar una búsqueda que va a fallar sin explicación.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState, SectionTitle } from "./ui";

interface Signal {
  id: string;
  label: string;
  value: string | number | null;
  source: "api" | "derivada" | "declarado";
  confirmado: boolean;
  limite: string | null;
}

interface MomentumTrace {
  status: string;
  activeAds: number;
  previousActiveAds: number | null;
  delta: number | null;
  previousCapturedAt: number | null;
  daysSincePrevious: number | null;
  rule: string;
  reason: string;
}

interface Competitor {
  momentum: MomentumTrace;
  pageId: string;
  pageName: string | null;
  candidateKey: string;
  snapshotUrls: string[];
  activeAds: number;
  signals: Signal[];
  noise: boolean;
  noiseReason: string | null;
}

interface Progress {
  fase: "expandiendo" | "buscando" | "agrupando" | "terminado";
  term: string | null;
  termsDone: number;
  termsTotal: number;
  ads: number;
  requests: number;
  remainingSec: number;
}

interface SearchResult {
  seed: string;
  terms: Array<{ term: string; origin: string; why: string }>;
  termsQueried: string[];
  stopReason: string;
  requests: number;
  pages: number;
  rawAds: number;
  competitors: Competitor[];
  discarded: Competitor[];
  elapsedSec: number;
}

interface Job {
  id: number;
  seed: string;
  country: string;
  days: number;
  minutes: number;
  status: "pendiente" | "corriendo" | "terminado" | "fallido" | "cancelado";
  progress: Progress | null;
  result: SearchResult | null;
  error: string | null;
  stopReason: string | null;
}

interface Estado {
  paradaEmergencia: boolean;
  paradaMensaje: string | null;
  tokenConfigurado: boolean;
  job: Job | null;
  recientes: Job[];
}

const PARADA: Record<string, string> = {
  completado: "se recorrieron todos los términos",
  deadline: "se acabó el tiempo de la búsqueda",
  presupuesto_peticiones: "se alcanzó el tope de peticiones",
  cuota_meta: "Meta avisó de que la cuota se agotaba",
  rate_limit: "Meta cortó por exceso de peticiones",
  token_invalido: "el token no vale o ha caducado",
  permiso: "la app no tiene acceso a la Ad Library",
  parada_emergencia: "parada de emergencia activa",
  error: "un error inesperado",
};

function Etiqueta({ signal }: { signal: Signal }) {
  const texto = signal.confirmado ? "dato" : signal.source === "declarado" ? "declarado" : "señal";
  const clase = signal.confirmado
    ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
    : signal.source === "declarado"
      ? "bg-amber-500/15 text-amber-700 border-amber-500/30"
      : "bg-sky-500/15 text-sky-700 border-sky-500/30";
  return (
    <span className={`ml-2 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase align-middle ${clase}`} title={signal.limite ?? "dato devuelto por la API, sin interpretar"}>
      {texto}
    </span>
  );
}

function FichaCompetidor({ c }: { c: Competitor }) {
  return (
    <div className="rounded-lg border border-brand-border bg-brand-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-[15px] text-brand-text">{c.pageName ?? c.pageId}</strong>
        <span className="text-[12px] text-brand-muted">{c.activeAds} anuncio(s) activo(s)</span>
      </div>
      {/* El momentum va aparte y con su traza: qué se compara, contra qué
          fecha y con qué regla. Antes era solo la palabra «fuerte». */}
      <div className="mt-2 rounded-md border border-brand-border/70 bg-brand-surface-2 px-3 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-tertiary">Momentum</div>
        <div className="mt-0.5 text-[13px] text-brand-text">{c.momentum.reason}</div>
        <div className="mt-1 text-[11px] leading-snug text-brand-tertiary">
          Regla: {c.momentum.rule}.{" "}
          {c.momentum.previousCapturedAt === null
            ? "No hay medida anterior: todavía no compara nada."
            : `Comparado con la medida de hace ${c.momentum.daysSincePrevious} día(s)${
                (c.momentum.daysSincePrevious ?? 0) >= 21 ? ", que ya es vieja" : ""
              }.`}
        </div>
      </div>
      <dl className="mt-2 grid gap-1.5">
        {c.signals
          .filter((s) => s.id !== "momentum" && s.value !== null && s.value !== "")
          .map((s) => (
            <div key={s.id} className="text-[13px]">
              <dt className="inline text-brand-muted">{s.label}:</dt>{" "}
              <dd className="inline font-medium text-brand-text">
                {String(s.value)}
                <Etiqueta signal={s} />
              </dd>
              {s.limite ? <p className="mt-0.5 text-[11px] leading-snug text-brand-tertiary">{s.limite}</p> : null}
            </div>
          ))}
      </dl>
      {c.snapshotUrls[0] ? (
        <a href={c.snapshotUrls[0]} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[12px] font-medium text-brand-accent underline">
          Ver la ficha del anuncio en Meta →
        </a>
      ) : null}
    </div>
  );
}

export default function CompetitionSearch() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [palabra, setPalabra] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<number | null>(null);

  const cargar = useCallback(async () => {
    try {
      const id = jobIdRef.current;
      const res = await fetch(`/api/hunter/competencia${id ? `?jobId=${id}` : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Estado;
      setEstado(data);
      if (data.job) jobIdRef.current = data.job.id;
    } catch {
      /* se reintenta en el siguiente ciclo */
    }
  }, []);

  useEffect(() => {
    void cargar();
    // Polling, como el resto del panel: no hay SSE en este repo.
    const t = setInterval(() => void cargar(), 4000);
    return () => clearInterval(t);
  }, [cargar]);

  const lanzar = async () => {
    setError(null);
    setEnviando(true);
    try {
      const res = await fetch("/api/hunter/competencia", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: palabra }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; job?: Job };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "no se pudo lanzar la búsqueda");
        return;
      }
      jobIdRef.current = data.job?.id ?? null;
      setPalabra("");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "no se pudo lanzar la búsqueda");
    } finally {
      setEnviando(false);
    }
  };

  const job = estado?.job ?? null;
  const corriendo = job?.status === "pendiente" || job?.status === "corriendo";
  const bloqueado = Boolean(estado?.paradaEmergencia) || !estado?.tokenConfigurado || corriendo || enviando || palabra.trim() === "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-semibold text-brand-text">Competencia</h1>
        <p className="mt-1 text-sm text-brand-muted">
          Escribe una palabra y el Cazador busca en la Ad Library de Meta durante unos minutos: quién anuncia eso, cuántos
          anuncios tiene activos y desde cuándo.
        </p>
      </div>

      {estado?.paradaEmergencia ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-brand-text">
          <div className="font-semibold text-red-600">PARADA DE EMERGENCIA ACTIVA</div>
          <p className="mt-1 text-brand-muted">{estado.paradaMensaje}</p>
        </div>
      ) : null}

      {estado && !estado.tokenConfigurado ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-brand-text">
          <div className="font-semibold text-amber-700">FALTA EL TOKEN DE LA AD LIBRARY</div>
          <p className="mt-1 text-brand-muted">
            Sin <code>META_AD_LIBRARY_ACCESS_TOKEN</code> en el entorno no se busca nada. No se inventan resultados.
          </p>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <input
            value={palabra}
            onChange={(e) => setPalabra(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !bloqueado) void lanzar();
            }}
            placeholder="organizador cocina"
            aria-label="Palabra o frase para buscar"
            className="h-11 min-w-[220px] flex-1 rounded-lg border border-brand-border bg-brand-surface px-3 text-[15px]"
          />
          <button
            onClick={() => void lanzar()}
            disabled={bloqueado}
            className="h-11 rounded-lg bg-brand-text px-5 text-[14px] font-medium text-white disabled:opacity-40"
          >
            {corriendo ? "Buscando…" : "Buscar competencia"}
          </button>
        </div>
        {error ? <p className="px-4 pb-3 text-[13px] text-red-600">{error}</p> : null}
        <p className="px-4 pb-4 text-[12px] text-brand-tertiary">
          La búsqueda tarda hasta 15 minutos y corre en el servidor: puedes cerrar esta pestaña y volver.
        </p>
      </Card>

      {corriendo ? (
        <Card>
          <div className="p-4">
            <SectionTitle>Buscando «{job?.seed}»</SectionTitle>
            {job?.progress ? (
              <>
                <p className="mt-2 text-[13px] text-brand-text">
                  {job.progress.fase === "buscando"
                    ? `Término ${job.progress.termsDone} de ${job.progress.termsTotal}: «${job.progress.term}»`
                    : job.progress.fase === "agrupando"
                      ? "Agrupando por competidor…"
                      : "Preparando los términos…"}
                </p>
                <p className="mt-1 text-[13px] text-brand-muted">
                  {job.progress.ads} anuncios · {job.progress.requests} peticiones · quedan{" "}
                  {Math.max(0, Math.floor(job.progress.remainingSec / 60))} min
                </p>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-brand-surface-2">
                  <div
                    className="h-full bg-brand-accent transition-all"
                    style={{ width: `${Math.min(100, Math.round((job.progress.termsDone / Math.max(1, job.progress.termsTotal)) * 100))}%` }}
                  />
                </div>
              </>
            ) : (
              <p className="mt-2 text-[13px] text-brand-muted">En cola: el proceso del bot la recogerá en unos segundos.</p>
            )}
          </div>
        </Card>
      ) : null}

      {job?.status === "fallido" ? (
        <Card>
          <div className="p-4">
            <div className="font-semibold text-red-600">La búsqueda «{job.seed}» falló</div>
            <p className="mt-1 text-[13px] text-brand-muted">{job.error}</p>
          </div>
        </Card>
      ) : null}

      {job?.status === "terminado" && job.result ? (
        <>
          <Card>
            <div className="p-4 text-[13px] text-brand-muted">
              <SectionTitle>
                «{job.result.seed}» · {job.result.competitors.length} competidor(es)
              </SectionTitle>
              <p className="mt-2">
                {job.result.termsQueried.length} de {job.result.terms.length} términos · {job.result.rawAds} anuncios únicos ·{" "}
                {job.result.requests} peticiones · {job.result.elapsedSec} s
              </p>
              <p className="mt-1">Terminó porque {PARADA[job.result.stopReason] ?? job.result.stopReason}.</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {job.result.terms.map((t) => (
                  <span
                    key={t.term}
                    title={t.why}
                    className="rounded-full border border-brand-border bg-brand-surface-2 px-2.5 py-1 text-[12px] text-brand-muted"
                  >
                    {t.term}
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <div className="grid gap-3">
            {job.result.competitors.map((c) => (
              <FichaCompetidor key={c.candidateKey} c={c} />
            ))}
            {job.result.competitors.length === 0 ? (
              <EmptyState title="Ningún competidor encontrado." hint="Prueba con otra palabra, amplía los días o revisa los descartados por ruido." />
            ) : null}
          </div>

          {job.result.discarded.length > 0 ? (
            <Card>
              <div className="p-4">
                <SectionTitle>Descartados por ruido ({job.result.discarded.length})</SectionTitle>
                <p className="mt-1 text-[12px] text-brand-tertiary">
                  El filtro los apartó por su texto. Si alguno no debería estar aquí, dilo: la heurística se ajusta.
                </p>
                <ul className="mt-2 space-y-1 text-[13px] text-brand-muted">
                  {job.result.discarded.slice(0, 10).map((c) => (
                    <li key={c.candidateKey}>
                      <span className="text-brand-text">{c.pageName ?? c.pageId}</span> — {c.noiseReason}
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          ) : null}

          <Card>
            <div className="p-4 text-[12px] leading-relaxed text-brand-tertiary">
              <strong className="text-brand-muted">Lo que esta API no da, y por eso no se enseña:</strong> gasto publicitario,
              impresiones, CTR o ventas (solo existen para anuncios de temática social o política), el creativo en sí (imagen o
              vídeo) y el dominio de destino resuelto. El análisis del creativo por IA está desactivado.
            </div>
          </Card>
        </>
      ) : null}

      {!job ? <EmptyState title="Sin búsquedas todavía." hint="Escribe una palabra arriba y lanza la primera." /> : null}
    </div>
  );
}
