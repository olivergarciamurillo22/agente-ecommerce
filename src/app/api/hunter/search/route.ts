import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { createSearchRun, getSearchRun, listProductsForSearch, listSearchRuns } from "@/lib/hunter/repo";
import { executeSearch, planSearch } from "@/lib/hunter/search/run";
import { radarReadiness } from "@/lib/hunter/providers/registry";
import { stageProgress } from "@/lib/hunter/stages";
import { withVerdictAll } from "@/lib/hunter/verdict";

// Lanzar y consultar búsquedas.
//
// POST ?dryRun=1 → solo PLANIFICA: devuelve la frase legible, los chips y la
// estrategia de consultas, sin salir a la red y sin gastar una llamada. Es lo
// que alimenta la vista previa antes de pulsar «Buscar».
//
// GET ?id=… → estado vivo de una búsqueda: etapas, progreso, tiempo restante
// y lo que ya se ha encontrado. Es lo que la pantalla de proceso consulta.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Una búsqueda cada 30 s: freno simple contra el doble clic y el bucle. */
const MIN_SECONDS_BETWEEN_SEARCHES = 30;
let lastSearchAt = 0;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  let body: { prompt?: string; filters?: Record<string, unknown>; dryRun?: boolean; maxQueries?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const dryRun = body.dryRun === true || req.nextUrl.searchParams.get("dryRun") === "1";

  if (dryRun) {
    // Sin red y sin coste: solo planificar.
    const { run, plan } = await planSearch({
      prompt: prompt || null,
      filters: body.filters as never,
      maxQueries: body.maxQueries,
    });
    return NextResponse.json({
      ok: true,
      dryRun: true,
      title: run.title,
      filters: plan.filters,
      queries: plan.queries,
      sentence: plan.sentence,
      chips: plan.chips,
      strategy: plan.strategy,
      aiUsed: plan.aiUsed,
      notes: plan.notes,
      estimateSeconds: run.estimateSeconds,
    });
  }

  const readiness = await radarReadiness();
  if (!readiness.canSearch) {
    return NextResponse.json({ ok: false, error: readiness.reason, nextStep: readiness.nextStep }, { status: 409 });
  }

  const ahora = Math.floor(Date.now() / 1000);
  if (ahora - lastSearchAt < MIN_SECONDS_BETWEEN_SEARCHES) {
    return NextResponse.json(
      { ok: false, error: `Espera ${MIN_SECONDS_BETWEEN_SEARCHES - (ahora - lastSearchAt)} s antes de otra búsqueda.` },
      { status: 429 }
    );
  }
  lastSearchAt = ahora;

  const { run } = await planSearch({ prompt: prompt || null, filters: body.filters as never, maxQueries: body.maxQueries });
  if (run.queries.length === 0) {
    return NextResponse.json({ ok: false, error: "No hay palabras clave que buscar. Describe el producto." }, { status: 400 });
  }
  createSearchRun(run, auth.user.email || auth.user.name);

  // Se responde YA con el id y la búsqueda sigue en segundo plano: una
  // petición HTTP abierta cinco minutos se corta sola y deja todo a medias.
  void executeSearch(run).catch(() => {
    /* executeSearch ya persiste su propio estado de fallo */
  });

  return NextResponse.json({ ok: true, searchId: run.id, run: serialize(run) });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    // Sin id: el historial (§35).
    return NextResponse.json({ ok: true, runs: listSearchRuns(30).map(serialize) });
  }

  const run = getSearchRun(id);
  if (!run) return NextResponse.json({ ok: false, error: "búsqueda no encontrada" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    run: serialize(run),
    opportunities: withVerdictAll(listProductsForSearch(id), run.filters?.country ?? "ES"),
  });
}

/**
 * Añade lo que la interfaz necesita y no conviene recalcular en el navegador:
 * el avance 0..1 y los segundos que quedan. Que los dos números salgan del
 * MISMO sitio evita que la barra y el reloj se contradigan.
 */
function serialize(run: ReturnType<typeof getSearchRun> & object) {
  const avance = stageProgress(run.stages);
  const ahora = Math.floor(Date.now() / 1000);
  const terminada = run.state === "complete" || run.state === "partial" || run.state === "failed";
  return {
    ...run,
    progressRatio: terminada ? 1 : avance,
    remainingSeconds: terminada
      ? 0
      : run.estimatedFinishAt !== null
        ? Math.max(0, run.estimatedFinishAt - ahora)
        : null,
  };
}
