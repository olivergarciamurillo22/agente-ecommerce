import { NextRequest, NextResponse } from "next/server";
import { getAnalytics, getUserMessagesSince, getInsight, setInsight } from "../../../lib/db";
import { classifyDudas, type Duda } from "../../../lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const daysParam = parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10);
  const days = Math.min(Math.max(Number.isNaN(daysParam) ? 7 : daysParam, 1), 90);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;

  const analytics = getAnalytics(sinceTs);

  // Dudas frecuentes con IA, cacheadas por día para no gastar en cada carga.
  const today = new Date().toISOString().slice(0, 10);
  const periodKey = `dudas:${days}d:${today}`;
  let dudas: Duda[] = [];
  const cached = getInsight(periodKey);
  if (cached) {
    try {
      dudas = JSON.parse(cached.data_json) as Duda[];
    } catch {
      dudas = [];
    }
  } else {
    const mensajes = getUserMessagesSince(sinceTs, 250);
    dudas = await classifyDudas(mensajes);
    if (dudas.length > 0) setInsight(periodKey, JSON.stringify(dudas));
  }

  return NextResponse.json({ rangeDays: days, ...analytics, dudas });
}
