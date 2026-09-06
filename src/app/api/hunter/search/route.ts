import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { createSearchRun, getSearchRun, listProductsForSearch } from "@/lib/hunter/repo";
import { executeSearch, planSearch } from "@/lib/hunter/search/run";
import { radarReadiness } from "@/lib/hunter/providers/registry";
import { parseIntentDeterministic } from "@/lib/hunter/intelligence";

// Lanzar y consultar búsquedas.
//
// POST ?dryRun=1 → solo INTERPRETA y devuelve filtros + consultas, sin salir
// a la red. Es lo que usa el botón "Analizar criterios": Pedro revisa y
// corrige antes de que se gaste un solo crédito.
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
    // Sin red y sin coste: solo interpretar.
    const plan = await planSearch({ prompt: prompt || null, filters: body.filters as never, maxQueries: body.maxQueries });
    return NextResponse.json({
      ok: true,
      dryRun: true,
      filters: plan.run.filters,
      queries: plan.run.queries,
      aiUsed: plan.aiUsed,
      notes: parseIntentDeterministic(prompt).notes,
    });
  }

  const readiness = await radarReadiness();
  if (!readiness.canSearch) {
    return NextResponse.json({ ok: false, error: readiness.reason }, { status: 409 });
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

  // Se responde YA con el id y la búsqueda sigue en segundo plano (§19): una
  // petición HTTP abierta cinco minutos se corta sola y deja todo a medias.
  void executeSearch(run).catch(() => {
    /* executeSearch ya persiste su propio estado de fallo */
  });

  return NextResponse.json({ ok: true, searchId: run.id, queries: run.queries, filters: run.filters });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "falta id" }, { status: 400 });
  const run = getSearchRun(id);
  if (!run) return NextResponse.json({ ok: false, error: "búsqueda no encontrada" }, { status: 404 });
  return NextResponse.json({ ok: true, run, opportunities: listProductsForSearch(id) });
}
