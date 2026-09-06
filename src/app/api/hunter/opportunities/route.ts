import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { applyManualOverride, getAdsForProduct, getProduct, listProductsByStatus, listSnapshots } from "@/lib/hunter/repo";
import { buildLandingHandoff, buildTestPlan } from "@/lib/hunter/test-plan";
import { deterministicCreatives } from "@/lib/hunter/intelligence";
import { adLibraryPageUrl } from "@/lib/hunter/links";
import { decideVerdict, whyLine, withVerdict, withVerdictAll } from "@/lib/hunter/verdict";
import type { OpportunityStatus } from "@/lib/hunter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ESTADOS: OpportunityStatus[] = ["new", "saved", "watching", "testing", "discarded", "winner", "loser"];
/** Anuncios servidos en la ficha. Más no cabe en pantalla y sí pesa. */
const MAX_ADS = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;

  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const bruto = getProduct(id);
    if (!bruto) return NextResponse.json({ ok: false, error: "no encontrada" }, { status: 404 });
    const op = withVerdict(bruto);
    const ads = getAdsForProduct(id);

    // Competidores: se agregan aquí y no en el navegador porque son los
    // MISMOS anuncios recortados; mandarlos dos veces sería pagar el peso dos
    // veces por el mismo dato.
    const porAnunciante = new Map<string, { name: string; pageId: string | null; ads: number; active: number; oldestDays: number | null; countries: Set<string> }>();
    for (const a of ads) {
      const nombre = a.advertiserName ?? "Sin nombre";
      const e = porAnunciante.get(nombre) ?? {
        name: nombre, pageId: a.advertiserExternalId, ads: 0, active: 0, oldestDays: null, countries: new Set<string>(),
      };
      e.ads += 1;
      if (a.active) e.active += 1;
      if (a.activeDays !== null) e.oldestDays = Math.max(e.oldestDays ?? 0, a.activeDays);
      for (const c of a.countries) e.countries.add(c);
      porAnunciante.set(nombre, e);
    }
    const competidores = [...porAnunciante.values()]
      .map((e) => ({
        name: e.name,
        adCount: e.ads,
        activeCount: e.active,
        oldestDays: e.oldestDays,
        countries: [...e.countries],
        adLibraryUrl: e.pageId ? adLibraryPageUrl(e.pageId) : null,
      }))
      .sort((a, b) => b.adCount - a.adCount);

    return NextResponse.json({
      ok: true,
      opportunity: op,
      why: whyLine(op),
      verdict: decideVerdict(op),
      testPlan: buildTestPlan(op),
      landing: buildLandingHandoff(op),
      // Los anuncios se recortan: la ficha enseña evidencia, no un volcado.
      ads: ads.slice(0, MAX_ADS).map((a) => ({
        id: a.id, advertiserName: a.advertiserName, platform: a.platform, format: a.format,
        adCopy: a.adCopy ? a.adCopy.slice(0, 400) : null, startedAt: a.startedAt, active: a.active,
        activeDays: a.activeDays, previewUrl: a.previewUrl, landingUrl: a.landingUrl, imageUrl: a.imageUrl,
      })),
      adCount: ads.length,
      competitors: competidores,
      // La lectura de creatividades se recalcula sin IA al abrir la ficha: es
      // instantánea, gratis y no depende de que hubiera clave el día de la
      // búsqueda.
      creatives: deterministicCreatives(ads.map((a) => a.adCopy).filter((c): c is string => !!c)),
      history: listSnapshots(id),
    });
  }

  const pedidos = (req.nextUrl.searchParams.get("status") ?? "new,saved,watching")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is OpportunityStatus => (ESTADOS as string[]).includes(s));

  return NextResponse.json({
    ok: true,
    opportunities: withVerdictAll(listProductsByStatus(pedidos.length > 0 ? pedidos : ESTADOS, 200)),
  });
}

/** Correcciones a mano de Pedro. Su valor manda sobre el del proveedor. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  let body: { id?: string; canonicalName?: string; category?: string; supplierCost?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ ok: false, error: "falta id" }, { status: 400 });
  if (!getProduct(body.id)) return NextResponse.json({ ok: false, error: "no encontrada" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (typeof body.canonicalName === "string" && body.canonicalName.trim()) patch.canonicalName = body.canonicalName.trim().slice(0, 200);
  if (typeof body.category === "string") patch.category = body.category.trim().slice(0, 80);
  if (typeof body.supplierCost === "number" && Number.isFinite(body.supplierCost) && body.supplierCost >= 0) {
    patch.supplierCost = body.supplierCost;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ ok: false, error: "nada que cambiar" }, { status: 400 });

  applyManualOverride(body.id, { ...patch, editedBy: auth.user.name, editedAt: Math.floor(Date.now() / 1000) });
  const actualizado = getProduct(body.id);
  return NextResponse.json({ ok: true, opportunity: actualizado ? withVerdict(actualizado) : null });
}
