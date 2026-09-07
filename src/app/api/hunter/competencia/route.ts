import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { canRunDiscovery } from "@/lib/safety";
import { DISCOVERY_HALTED_MESSAGE } from "@/lib/hunter/discovery/errors";
import { enqueueDiscoveryJob, getDiscoveryJob, latestDiscoveryJob, listDiscoveryJobs } from "@/lib/hunter/discovery/jobs";
import { discoveryToken } from "@/lib/hunter/discovery/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Buscador de competencia (docs/HUNTER-BUSCADOR.md). Esta ruta NO busca: solo
 * encola y consulta. La búsqueda, que dura hasta quince minutos, la ejecuta el
 * proceso del bot; una ruta de Next moriría en cada redespliegue.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const idParam = req.nextUrl.searchParams.get("jobId");
  const job = idParam ? getDiscoveryJob(Number(idParam)) : latestDiscoveryJob();
  return NextResponse.json({
    // El estado de los frenos viaja SIEMPRE: la interfaz tiene que poder
    // avisar antes de que alguien lance una búsqueda que va a fallar.
    paradaEmergencia: !canRunDiscovery(),
    paradaMensaje: canRunDiscovery() ? null : DISCOVERY_HALTED_MESSAGE,
    tokenConfigurado: discoveryToken() !== "",
    job,
    recientes: listDiscoveryJobs(5),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  let body: { seed?: string; country?: string; days?: number; minutes?: number; kind?: "busqueda" | "auditoria" | "cadena"; storeUrl?: string; facebookUrl?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  if (!discoveryToken()) {
    return NextResponse.json(
      { ok: false, error: "falta META_AD_LIBRARY_ACCESS_TOKEN en el entorno: sin token no se busca nada" },
      { status: 409 }
    );
  }
  const kind = body.kind === "auditoria" || body.kind === "cadena" ? body.kind : "busqueda";
  const r = enqueueDiscoveryJob({
    kind,
    seed: kind === "auditoria" ? (body.storeUrl ?? body.seed ?? "") : (body.seed ?? ""),
    params: kind === "auditoria" ? { facebookUrl: body.facebookUrl ?? null } : {},
    country: body.country,
    days: body.days,
    minutes: body.minutes,
    requestedBy: auth.user.name,
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.detail, reason: r.reason }, { status: 409 });
  return NextResponse.json({ ok: true, job: r.job });
}
