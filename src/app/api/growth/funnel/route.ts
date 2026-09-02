import { NextResponse } from "next/server";
import { getGrowthFunnel } from "@/lib/system/growth-funnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: getGrowthFunnel() });
  } catch {
    return NextResponse.json({ ok: false, error: "No se pudo calcular el embudo." }, { status: 500 });
  }
}
