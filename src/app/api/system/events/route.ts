import { NextRequest, NextResponse } from "next/server";
import { listIntegrationEvents } from "@/lib/system/repo";
import type { EventIntegration, EventSeverity } from "@/lib/system/types";

// Feed técnico de eventos (paginado hacia atrás con beforeId).
// Los mensajes ya se guardaron sanitizados; aquí solo se listan.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SEVERITIES = new Set(["info", "warning", "critical"]);
const INTEGRATIONS = new Set([
  "system",
  "shopify",
  "whatsapp",
  "dropea",
  "dropi",
  "tracking",
  "sqlite",
  "backup",
]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = req.nextUrl.searchParams;
    const severity = sp.get("severity");
    const integration = sp.get("integration");
    const beforeId = parseInt(sp.get("beforeId") ?? "", 10);
    const limit = parseInt(sp.get("limit") ?? "", 10);

    const events = listIntegrationEvents({
      limit: Number.isFinite(limit) ? limit : 100,
      severity: severity && SEVERITIES.has(severity) ? (severity as EventSeverity) : undefined,
      integration:
        integration && INTEGRATIONS.has(integration)
          ? (integration as EventIntegration)
          : undefined,
      beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
    });
    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status: 500 }
    );
  }
}
