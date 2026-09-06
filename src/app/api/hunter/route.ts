import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { radarReadiness } from "@/lib/hunter/providers/registry";
import { listSearchRuns, providerUsageToday } from "@/lib/hunter/repo";
import { listAlerts } from "@/lib/hunter/decisions";

// Estado del radar: qué fuentes hay, qué se ha gastado hoy y qué avisos hay.
// SOLO PROPIETARIO, con guard explícito además del proxy (§56): buscar
// cuesta créditos y el consumo no es cosa de un agente de atención.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  const readiness = await radarReadiness();
  return NextResponse.json({
    readiness,
    usageToday: providerUsageToday(),
    recentSearches: listSearchRuns(10),
    alerts: listAlerts(true, 20),
  });
}
