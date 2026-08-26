// ============================================================
// MODO DE LLAMADAS — npm run calls:mode [-- pilot|production|status]
//
// Cambia SOLO settings.calls_pilot_mode (el interruptor propio del 26-08).
// No toca el kill switch, ni la allowlist, ni el cap, ni TEST_MODE.
//
//   npm run calls:mode                    → estado actual (no cambia nada)
//   npm run calls:mode -- pilot           → fail-closed: allowlist vacía = NADIE
//   npm run calls:mode -- production      → vacía = sin restricción (decisión explícita)
//
// Pensado para el NAS (dentro del contenedor), sin abrir sqlite a mano.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const db = await import("../src/lib/db");
  const cfg = await import("../src/lib/calls/config");
  const orden = (process.argv[2] ?? "status").toLowerCase();

  if (orden === "pilot" || orden === "piloto") {
    db.setSetting("calls_pilot_mode", "1");
  } else if (orden === "production" || orden === "produccion" || orden === "producción") {
    db.setSetting("calls_pilot_mode", "0");
  } else if (orden !== "status") {
    console.error(`\n✗ Orden desconocida: "${orden}". Usa pilot | production | status\n`);
    process.exit(1);
  }

  const piloto = cfg.callsPilotMode();
  const allowlist = cfg.callsAllowlist();
  console.log("\n════════ MODO DE LLAMADAS ════════");
  console.log(`  Kill switch      : ${cfg.aiCallsEnabled() ? "ABIERTO (ai_calls_enabled=1)" : "cerrado"}`);
  console.log(`  Shadow           : ${cfg.callsShadowMode() ? "ON (simula sin llamar)" : "off"}`);
  console.log(`  Modo             : ${piloto ? "PILOTO (fail-closed)" : "PRODUCCIÓN (calls_pilot_mode=0)"}`);
  console.log(`  Allowlist        : ${allowlist.length ? `${allowlist.length} número(s)` : "vacía"}`);
  console.log(`  Cap diario       : ${cfg.callsDailyCap()}`);
  const efecto = !cfg.aiCallsEnabled()
    ? "nadie (kill switch cerrado)"
    : cfg.callsShadowMode()
      ? "nadie de verdad (shadow)"
      : allowlist.length
        ? "solo la allowlist"
        : piloto
          ? "NADIE (piloto + allowlist vacía = fail-closed)"
          : "cualquier pedido elegible (producción, con cap y franja delante)";
  console.log(`  → Se llamará a   : ${efecto}\n`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
