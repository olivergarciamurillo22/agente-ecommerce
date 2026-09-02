import { NextResponse } from "next/server";
import { resumeResearch, runResearch } from "@/lib/product-intelligence/engine";
import { UnconfiguredProvider } from "@/lib/product-intelligence/provider";
import { getSession, listSessions, updateSessionStatus } from "@/lib/product-intelligence/repository";
import { MetaAdLibraryProvider } from "@/lib/product-intelligence/providers/meta-ad-library-provider";
import { getProviderHealth, listSignals, listWatchlist, removeWatchlist, saveProviderHealth, setWatchlist } from "@/lib/product-intelligence/state";
import { autoHuntEnabled, productIntelligenceEnabled } from "@/lib/product-intelligence/config";
import { redactProductIntelligence } from "@/lib/product-intelligence/redaction";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!productIntelligenceEnabled()) return NextResponse.json({ enabled: false, sessions: [], signals: [], watchlist: [], provider: { source: "META_AD_LIBRARY", available: false, configured: false, researchAvailable: false, reason: "Product Intelligence disabled" } });
  const provider = new MetaAdLibraryProvider();
  const configured = provider.status(); const stored = getProviderHealth();
  const health = stored && stored.configured === configured.configured ? stored : configured;
  return NextResponse.json({ sessions: listSessions(), provider: health, signals: listSignals(), watchlist: listWatchlist() });
}

export async function POST(request: Request) {
  if (!productIntelligenceEnabled()) return NextResponse.json({ error: "Product Intelligence disabled" }, { status: 503 });
  const body = await request.json().catch(() => ({})) as { query?: unknown; action?: unknown; productId?: unknown; watchlistStatus?: unknown };
  if (body.action === "meta-health") {
    const health = await new MetaAdLibraryProvider().healthCheck(); saveProviderHealth(health);
    return NextResponse.json({ provider: health });
  }
  if (body.action === "watchlist" && typeof body.productId === "string" && typeof body.watchlistStatus === "string") return NextResponse.json({ item: setWatchlist(body.productId, body.watchlistStatus as Parameters<typeof setWatchlist>[1]) });
  if (body.action === "watchlist-remove" && typeof body.productId === "string") { removeWatchlist(body.productId); return NextResponse.json({ removed: true }); }
  if (["PAUSED", "STOPPED"].includes(String(body.action)) && typeof body.productId === "string") return NextResponse.json({ session: updateSessionStatus(body.productId, String(body.action) as "PAUSED" | "STOPPED") });
  if (body.query !== undefined && (typeof body.query !== "string" || !body.query.trim())) return NextResponse.json({ error: "La búsqueda no es válida" }, { status: 400 });
  const meta = new MetaAdLibraryProvider(body.query === undefined ? { maxPages: 2, maxCalls: 20 } : {});
  const metaStatus = getProviderHealth() ?? meta.status();
  const connected = metaStatus.code === "META_CONNECTED" && metaStatus.researchAvailable;
  if (body.action === "RESUME" && typeof body.productId === "string") {
    if (!connected) return NextResponse.json({ error: "Meta provider waiting for authorization" }, { status: 409 });
    const stored = getSession(body.productId); if (!stored) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    try { return NextResponse.json({ session: await resumeResearch(meta, stored) }); }
    catch (error) { return NextResponse.json({ error: "Product Intelligence session failed safely", detail: redactProductIntelligence(error) }, { status: 503 }); }
  }
  if (body.query === undefined && !autoHuntEnabled()) return NextResponse.json({ error: "Auto Hunt disabled by kill switch", status: "STOPPED" }, { status: 409 });
  if (!connected && body.query === undefined) return NextResponse.json({ error: "Meta provider waiting for authorization", status: "WAITING_FOR_META_AUTHORIZATION" }, { status: 409 });
  let session;
  try { session = await runResearch(connected ? meta : new UnconfiguredProvider(), typeof body.query === "string" ? body.query : undefined); }
  catch (error) { return NextResponse.json({ error: "Product Intelligence failed safely", detail: redactProductIntelligence(error) }, { status: 503 }); }
  session.source = connected ? "META_AD_LIBRARY" : "JSON_IMPORT";
  if (!connected) session.status = "WAITING_FOR_META_AUTHORIZATION";
  return NextResponse.json({ session }, { status: 201 });
}
