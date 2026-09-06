// ============================================================
// npm run hunter:doctor — ¿está el Winner Radar listo para trabajar?
//
// SOLO LECTURA y sin salir a la red salvo las sondas de salud que cada
// proveedor define (una llamada mínima). NO REVELA NINGUNA CLAVE: solo dice
// si está, si funciona y qué falta.
//
// Salidas: 0 = se puede buscar · 1 = no se puede · 2 = error de ejecución.
// ============================================================

import "./env-loader";

const ICONO = { ok: "●", warn: "◐", fail: "○" } as const;
type Icono = keyof typeof ICONO;

function linea(nombre: string, estado: string, detalle: string, icono: Icono = "ok"): void {
  console.log(`  ${ICONO[icono]} ${nombre.padEnd(20)} ${estado}`);
  if (detalle) console.log(`      ${detalle}`);
}

async function main(): Promise<void> {
  console.log("\n════════ CASAMABLE · WINNER RADAR — DOCTOR ════════\n");

  const { radarReadiness, providerMode, radarEnabled } = await import("../src/lib/hunter/providers/registry");
  const { llmHealth } = await import("../src/lib/hunter/llm");
  const { getInternalRates, getCategoryPerformance } = await import("../src/lib/hunter/providers/internal");

  const readiness = await radarReadiness();

  if (!radarEnabled()) {
    console.log("  ⚠️  MÓDULO APAGADO (WINNER_RADAR_ENABLED=0).\n");
  }
  if (readiness.fixtureMode) {
    console.log("  ⚠️  MODO DE EJEMPLO ACTIVO (HUNTER_FIXTURE_MODE=1).");
    console.log("      Los resultados son inventados. No sirven para decidir nada.\n");
  }
  if (readiness.fixtureRefusedInProduction) {
    console.log("  ⚠️  HUNTER_FIXTURE_MODE está pedido pero se IGNORA en producción.\n");
  }

  // ── Quién manda como fuente ──
  const modo = providerMode();
  linea("PROVIDER", modo, modo === "meta"
    ? "Biblioteca de Anuncios de Meta como fuente principal. Sin suscripciones de pago."
    : modo === "wh"
      ? "WinningHunter como fuente principal. Meta queda fuera de esta búsqueda."
      : "Todas las fuentes con credencial, Meta primero.");

  const NOMBRE: Record<string, string> = {
    winninghunter: "WINNINGHUNTER",
    meta_ad_library: "META",
    tiktok_research: "TIKTOK",
    casamable_internal: "DATOS_PROPIOS",
    supplier: "COSTES_PROVEEDOR",
    fixture: "EJEMPLO",
  };
  for (const p of readiness.providers) {
    const icono: Icono =
      p.status === "CONNECTED" || p.status === "READY" ? "ok"
      : p.status === "NOT_CONFIGURED" || p.status === "PARTIAL" || p.status === "NOT_APPROVED" ? "warn"
      : "fail";
    linea(NOMBRE[p.id] ?? p.id, p.status, p.detail, icono);
    const disponibles = Object.entries(p.capabilities).filter(([, v]) => v !== "UNAVAILABLE");
    if (disponibles.length > 0) {
      console.log(`      capacidades: ${disponibles.map(([k, v]) => `${k}=${v}`).join(" ")}`);
    }
  }

  // ── Modelo: se COMPRUEBA, no se supone ──
  // Decir CONNECTED por ver la variable no vacía es una mentira
  // tranquilizadora: con una clave caducada el radar seguiría funcionando en
  // determinista y el diagnóstico diría que todo va bien. La sonda usa
  // `models.list()`, que no gasta ni un token.
  const salud = await llmHealth();
  linea(
    salud.backend === "openai" ? "OPENAI" : salud.backend === "openrouter" ? "OPENROUTER" : "MODELO_IA",
    salud.status,
    salud.detail,
    salud.status === "CONNECTED" ? "ok" : salud.status === "NOT_CONFIGURED" ? "warn" : "fail"
  );

  // ── Histórico: sin él no hay momentum ni tiempo estimado real ──
  let historial = "SIN_DATOS";
  let detalleHistorial = "Todavía no hay búsquedas terminadas: la primera dará una horquilla de tiempo, no un segundero.";
  let iconoHistorial: Icono = "warn";
  try {
    const repo = await import("../src/lib/hunter/repo");
    const terminadas = repo.listSearchRuns(50).filter((r) => r.state === "complete" || r.state === "partial");
    const porConsulta = repo.historicalSecondsPerQuery();
    if (terminadas.length > 0) {
      historial = "READY";
      iconoHistorial = "ok";
      detalleHistorial = `${terminadas.length} búsqueda(s) terminadas` +
        (porConsulta ? ` · ${porConsulta.toFixed(1)} s por consulta de media` : " · aún sin media fiable (hacen falta 2)");
    }
  } catch (e) {
    historial = "ERROR";
    iconoHistorial = "fail";
    detalleHistorial = `no se pudo leer el histórico: ${e instanceof Error ? e.message : String(e)}`;
  }
  linea("HISTORY", historial, detalleHistorial, iconoHistorial);

  // Los trabajos de fondo usan los mismos leases que el resto del repo.
  let jobs = "READY";
  let iconoJobs: Icono = "ok";
  let detalleJobs = "Snapshots y avisos con lease propio: dos contenedores no pueden duplicar fotos.";
  try {
    await import("../src/lib/hunter/jobs");
  } catch (e) {
    jobs = "ERROR";
    iconoJobs = "fail";
    detalleJobs = e instanceof Error ? e.message : String(e);
  }
  linea("JOBS", jobs, detalleJobs, iconoJobs);

  // Tasas propias: sin ellas no hay economía y el Casamable Score se queda corto.
  const rates = getInternalRates();
  const perf = getCategoryPerformance(null);
  const tasas = [
    `entrega=${rates.deliveryRate.value === null ? "—" : `${Math.round(rates.deliveryRate.value * 100)} %`}`,
    `envío=${rates.shippingRate.value === null ? "—" : `${Math.round(rates.shippingRate.value * 100)} %`}`,
    `CPA=${rates.rawCPA.value === null ? "—" : `${rates.rawCPA.value.toFixed(2)} €`}`,
  ].join(" · ");
  linea("ECONOMIA_PROPIA", perf.sample >= 8 ? "READY" : "POCA_MUESTRA", `${tasas} (${perf.sample} cierres conocidos)`,
    perf.sample >= 8 ? "ok" : "warn");

  console.log("\n════════ VEREDICTO ════════");
  if (readiness.canSearch) {
    console.log(`  ● SE PUEDE BUSCAR — ${readiness.reason}\n`);
    process.exit(0);
  }
  console.log(`  ○ NO SE PUEDE BUSCAR — ${readiness.reason}`);
  if (readiness.nextStep) console.log(`     Siguiente paso: ${readiness.nextStep}`);
  console.log("     Guía: docs/product-hunter/PEDRO-API-KEYS.md\n");
  process.exit(1);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
