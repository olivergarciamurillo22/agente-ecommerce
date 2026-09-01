// ============================================================
// Calculadora COD — datos automáticos + escenarios.
//
//   GET  → auto-inputs (tasas reales con denominador, CPA de Meta,
//          defaults de settings, productos) + escenarios guardados
//          (?cpaDays=7&campaignId=...)
//   POST → { action:"save_scenario", id?, name, productSku?, modelType, assumptions }
//          { action:"duplicate_scenario", id }
//          { action:"delete_scenario", id }
//
// El CÁLCULO no vive aquí: es puro y corre en el cliente (respuesta
// instantánea al mover sliders). Guardar escenarios jamás toca datos
// reales (ni product_costs, ni settings, ni nada externo).
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { getCodAutoInputs } from "@/lib/cod-calculator/auto-inputs";
import { deleteCodScenario, duplicateCodScenario, listCodScenarios, saveCodScenario } from "@/lib/cod-calculator/scenarios";
import type { CODCalculatorInputs, CODModelType } from "@/lib/cod-calculator/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const cpaDays = Math.min(30, Math.max(1, parseInt(req.nextUrl.searchParams.get("cpaDays") ?? "7", 10) || 7));
    const campaignId = req.nextUrl.searchParams.get("campaignId") ?? undefined;
    return NextResponse.json({
      ok: true,
      auto: getCodAutoInputs({ cpaDays, campaignId }),
      scenarios: listCodScenarios(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error interno" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    id?: number;
    name?: string;
    productSku?: string | null;
    modelType?: CODModelType;
    assumptions?: CODCalculatorInputs & Record<string, unknown>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  try {
    switch (body.action) {
      case "save_scenario": {
        if (!body.name || !body.modelType || !body.assumptions) {
          return NextResponse.json({ ok: false, error: "faltan name/modelType/assumptions" }, { status: 400 });
        }
        const id = saveCodScenario({
          id: body.id,
          name: body.name,
          productSku: body.productSku,
          modelType: body.modelType,
          assumptions: body.assumptions,
        });
        return NextResponse.json({ ok: true, id, scenarios: listCodScenarios() });
      }
      case "duplicate_scenario": {
        if (!body.id) return NextResponse.json({ ok: false, error: "falta id" }, { status: 400 });
        const id = duplicateCodScenario(body.id);
        if (id === null) return NextResponse.json({ ok: false, error: "escenario no encontrado" }, { status: 404 });
        return NextResponse.json({ ok: true, id, scenarios: listCodScenarios() });
      }
      case "delete_scenario": {
        if (!body.id) return NextResponse.json({ ok: false, error: "falta id" }, { status: 400 });
        deleteCodScenario(body.id);
        return NextResponse.json({ ok: true, scenarios: listCodScenarios() });
      }
      default:
        return NextResponse.json({ ok: false, error: "acción desconocida" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error interno" }, { status: 500 });
  }
}
