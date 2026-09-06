import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/guard";
import { radarReadiness } from "@/lib/hunter/providers/registry";
import { providerUsageToday } from "@/lib/hunter/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Estado de cada fuente. NUNCA devuelve claves ni fragmentos: solo estado,
// motivo legible y créditos restantes cuando el proveedor los expone.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req);
  if (!auth.ok) return auth.response;
  const readiness = await radarReadiness();
  return NextResponse.json({ ok: true, readiness, usageToday: providerUsageToday() });
}
