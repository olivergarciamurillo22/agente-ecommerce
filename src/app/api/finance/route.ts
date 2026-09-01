// Finanzas del Control Center v2 (§38–§39): la pantalla más clara del panel.
// GET  → resumen financiero de la ventana pedida (preset o rango custom).
// POST → alta manual del gasto en ads de un día (fallback de §39).
import { NextResponse } from "next/server";
import { upsertDailyAdSpend } from "@/lib/db";
import { getFinanceOverviewMeasured, type FinancePreset } from "@/lib/system/finance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRESETS: FinancePreset[] = ["today", "7d", "30d", "month", "custom"];

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rawPreset = url.searchParams.get("preset") ?? "today";
    const preset: FinancePreset = (PRESETS as string[]).includes(rawPreset)
      ? (rawPreset as FinancePreset)
      : "today";

    let custom: { from: number; to: number } | undefined;
    if (preset === "custom") {
      const from = Number.parseInt(url.searchParams.get("from") ?? "", 10);
      const to = Number.parseInt(url.searchParams.get("to") ?? "", 10);
      if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
        custom = { from, to };
      }
    }

    const measured = getFinanceOverviewMeasured(preset, Date.now(), custom);
    if (measured.status === "error" || measured.value === null) {
      return NextResponse.json(
        { ok: false, error: measured.error ?? "la métrica financiera no se pudo calcular" },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, data: measured.value });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error interno" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "cuerpo JSON inválido" }, { status: 400 });
    }
    const { day, amount } = (body ?? {}) as { day?: unknown; amount?: unknown };
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json({ ok: false, error: "día inválido: se espera YYYY-MM-DD" }, { status: 400 });
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ ok: false, error: "importe inválido: se espera un número ≥ 0" }, { status: 400 });
    }
    upsertDailyAdSpend(day, amount, "manual");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "error interno" },
      { status: 500 }
    );
  }
}
