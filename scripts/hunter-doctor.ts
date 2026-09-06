// ============================================================
// npm run hunter:doctor — ¿está el AI Winner Radar listo para trabajar?
//
// SOLO LECTURA y sin salir a la red salvo las sondas de salud que cada
// proveedor define (una llamada mínima). No revela ninguna clave: solo dice
// si está, si funciona y qué falta.
//
// Salidas: 0 = se puede buscar · 1 = no se puede · 2 = error de ejecución.
// ============================================================

import "./env-loader";

const ICONO = { ok: "●", warn: "◐", fail: "○" } as const;

function linea(nombre: string, estado: string, detalle: string, icono: keyof typeof ICONO = "ok"): void {
  console.log(`  ${ICONO[icono]} ${nombre.padEnd(26)} ${estado}`);
  if (detalle) console.log(`      ${detalle}`);
}

async function main(): Promise<void> {
  console.log("\n════════ CASAMABLE · AI WINNER RADAR — DOCTOR ════════\n");

  const { radarReadiness } = await import("../src/lib/hunter/providers/registry");
  const { llmConfigured } = await import("../src/lib/hunter/intelligence");
  const { getInternalRates, getCategoryPerformance } = await import("../src/lib/hunter/providers/internal");

  const readiness = await radarReadiness();

  if (readiness.fixtureMode) {
    console.log("  ⚠️  MODO DE EJEMPLO ACTIVO (HUNTER_FIXTURE_MODE=1).");
    console.log("      Los resultados son inventados. No sirven para decidir nada.\n");
  }
  if (readiness.fixtureRefusedInProduction) {
    console.log("  ⚠️  HUNTER_FIXTURE_MODE está pedido pero se IGNORA en producción.\n");
  }

  for (const p of readiness.providers) {
    const icono = p.status === "CONNECTED" || p.status === "READY" ? "ok" : p.status === "NOT_CONFIGURED" || p.status === "PARTIAL" || p.status === "NOT_APPROVED" ? "warn" : "fail";
    const nombre = {
      winninghunter: "WINNINGHUNTER",
      meta_ad_library: "META_AD_LIBRARY",
      tiktok_research: "TIKTOK_RESEARCH",
      casamable_internal: "INTERNAL_DATA",
      supplier: "SUPPLIER_DATA",
      fixture: "FIXTURE",
    }[p.id];
    linea(nombre, p.status, p.detail, icono as keyof typeof ICONO);
    const disponibles = Object.entries(p.capabilities).filter(([, v]) => v !== "UNAVAILABLE");
    if (disponibles.length > 0) {
      console.log(`      capacidades: ${disponibles.map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
  }

  linea("LLM", llmConfigured() ? "CONFIGURED" : "NOT_CONFIGURED",
    llmConfigured()
      ? "Se reutiliza OpenRouter, ya configurado en Casamable. No hace falta nada nuevo."
      : "Sin OPENROUTER_API_KEY el radar funciona igual, con análisis determinista y sin resúmenes.",
    llmConfigured() ? "ok" : "warn");

  // Tasas propias: sin ellas no hay economía y el Casamable Score se queda corto.
  const rates = getInternalRates();
  const perf = getCategoryPerformance(null);
  const tasas = [
    `entrega=${rates.deliveryRate.value === null ? "—" : `${Math.round(rates.deliveryRate.value * 100)} %`}`,
    `envío=${rates.shippingRate.value === null ? "—" : `${Math.round(rates.shippingRate.value * 100)} %`}`,
    `CPA=${rates.rawCPA.value === null ? "—" : `${rates.rawCPA.value.toFixed(2)} €`}`,
  ].join(" · ");
  linea("ECONOMIA_INTERNA", perf.sample >= 8 ? "READY" : "POCA_MUESTRA", `${tasas} (${perf.sample} cierres conocidos)`,
    perf.sample >= 8 ? "ok" : "warn");

  console.log("\n════════ VEREDICTO ════════");
  if (readiness.canSearch) {
    console.log(`  ● SE PUEDE BUSCAR — ${readiness.reason}\n`);
    process.exit(0);
  }
  console.log(`  ○ NO SE PUEDE BUSCAR — ${readiness.reason}`);
  console.log("     Qué pedirle a Pedro: docs/product-hunter/PEDRO-API-KEYS.md\n");
  process.exit(1);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
