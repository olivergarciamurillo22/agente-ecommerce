import { NextResponse, type NextRequest } from "next/server";
import { getSystemOverview } from "@/lib/system/overview";
import { requireOwner } from "@/lib/auth/guard";

// Estado agregado de TODO el sistema para el Control Center.
// READ-ONLY y sanitizado: sin teléfonos completos, tokens ni payloads.
// Queda detrás del Basic Auth del panel (no está en PUBLIC_PREFIXES).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = requireOwner(req); if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(getSystemOverview());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 }
    );
  }
}
