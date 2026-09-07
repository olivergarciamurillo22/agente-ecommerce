import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { radarReadiness } from "@/lib/hunter/providers/registry";
import { listSearchRuns, providerUsageToday } from "@/lib/hunter/repo";
import { listAlerts } from "@/lib/hunter/decisions";
import path from "node:path";
import { HunterRepository } from "@/lib/hunter/repository";
import type { CandidateState } from "@/lib/hunter/types";
import { runLandingPipeline } from "@/lib/landing/e2e";

// Estado del radar: qué fuentes hay, qué se ha gastado hoy y qué avisos hay.
// SOLO PROPIETARIO, con guard explícito además del proxy (§56): buscar
// cuesta créditos y el consumo no es cosa de un agente de atención.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const STATES = new Set<CandidateState>(["nuevo", "descartado", "en_prueba", "ganador"]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  const candidateId = req.nextUrl.searchParams.get("id");
  const candidateRepo = new HunterRepository();
  if (candidateId !== null) {
    const id = Number(candidateId);
    const candidate = Number.isInteger(id) ? candidateRepo.byId(id) : null;
    return candidate
      ? NextResponse.json({ candidate })
      : NextResponse.json({ ok: false, error: "Candidato no encontrado" }, { status: 404 });
  }

  const readiness = await radarReadiness();
  return NextResponse.json({
    readiness,
    usageToday: providerUsageToday(),
    recentSearches: listSearchRuns(10),
    alerts: listAlerts(true, 20),
    candidates: candidateRepo.list(),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  let body: { op?: string; id?: number; state?: CandidateState; note?: string | null; salePriceEur?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  const id = Number(body.id);
  const repo = new HunterRepository();
  if (!Number.isInteger(id) || !repo.byId(id)) {
    return NextResponse.json({ ok: false, error: "Candidato no encontrado" }, { status: 404 });
  }
  if (body.op === "score") return NextResponse.json({ candidate: repo.score(id) });
  if (body.op === "price" && typeof body.salePriceEur === "number") {
    return NextResponse.json({ candidate: repo.setSalePrice(id, body.salePriceEur) });
  }
  if (body.op === "state" && body.state && STATES.has(body.state)) {
    return NextResponse.json({ candidate: repo.setState(id, body.state, typeof body.note === "string" ? body.note.slice(0, 1000) : null) });
  }
  if (body.op === "generate") {
    const result = runLandingPipeline(repo.byId(id)!, path.join(process.cwd(), "outputs", "landings"));
    return NextResponse.json({
      ok: true,
      result: { ...result, generatedFiles: result.generatedFiles.map((file) => path.basename(file)) },
    });
  }
  return NextResponse.json({ ok: false, error: "Operación no permitida" }, { status: 400 });
}
