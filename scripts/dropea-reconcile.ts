// ============================================================
// E8 — Reconciliador de Dropea por API.
//
//   npm run dropea:reconcile                    # dry-run (no escribe nada)
//   npm run dropea:reconcile -- --apply         # escribe de verdad
//   npm run dropea:reconcile -- --apply --max-items=5
//   npm run dropea:reconcile -- --reset-checkpoint --apply
//
// Por defecto SIEMPRE dry-run: hace falta --apply explícito para escribir.
// Sin --apply, NUNCA toca la DB ni el checkpoint — solo informa de qué
// haría, con el desglose completo por motivo (no un contador plano).
//
// SALVAGUARDA ESTRUCTURAL: este script no importa nada de WhatsApp ni de
// Baileys, y el módulo que hace el trabajo (src/lib/suppliers/dropea/
// reconcile.ts) solo puede LEER de Dropea. Ver el test "E8 salvaguarda
// estructural" en tests/run-tests.ts.
// ============================================================

import "./env-loader";

function hasFlag(nombre: string): boolean {
  return process.argv.slice(2).includes(`--${nombre}`);
}

function arg(nombre: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

async function main(): Promise<void> {
  const { runDropeaReconcile, dropeaReconcileConfigured } = await import("../src/lib/suppliers/dropea/reconcile");

  const apply = hasFlag("apply");
  const resetCheckpoint = hasFlag("reset-checkpoint");
  const maxItemsArg = arg("max-items");
  const maxItems = maxItemsArg ? parseInt(maxItemsArg, 10) : undefined;

  console.log("\n════════ RECONCILIADOR DROPEA (E8) ════════\n");
  console.log(`  Modo            : ${apply ? "⚠️  APLICANDO CAMBIOS DE VERDAD" : "DRY-RUN (no se escribe nada)"}`);
  console.log(`  Checkpoint      : ${resetCheckpoint ? "reiniciado (recorre la lista completa)" : "continúa donde lo dejó la última vez"}`);
  if (maxItems) console.log(`  Tope de pedidos : ${maxItems}`);

  if (!dropeaReconcileConfigured()) {
    console.log("\n✗ Dropea no está configurada para lectura (falta DROPEA_API_KEY o DROPEA_API_ENABLED=0).\n");
    process.exit(1);
  }

  const report = await runDropeaReconcile({
    dryRun: !apply,
    resetCheckpoint,
    maxItems,
    onItem: (r) => {
      const marca = r.outcome === "fetch_failed" ? "✗" : r.localOrderId ? "✓" : "·";
      console.log(`  ${marca} dropea#${r.resourceId} → ${r.outcome}${r.matchedVia ? ` (${r.matchedVia})` : ""}${r.closureStatus ? ` | cierre: ${r.closureStatus}` : ""}${r.error ? ` | ${r.error}` : ""}`);
    },
  });

  const c = report.counts;
  console.log("\n──────── Desglose del enlace ────────");
  console.log(`  ya enlazados (sin cambios)           : ${c.already_linked_same}`);
  console.log(`  ${apply ? "enlazados" : "se enlazarían"} por shopify_order_id     : ${c.linked_by_shopify_order_id}`);
  console.log(`  ${apply ? "enlazados" : "se enlazarían"} por shopify_order_number : ${c.linked_by_shopify_order_number}`);
  console.log(`  ambiguos (más de un pedido local)    : ${c.ambiguous_multiple_matches}${c.ambiguous_multiple_matches > 0 ? "   ⚠️  revisar a mano" : ""}`);
  console.log(`  sin external_order_id                : ${c.no_external_order_id}`);
  console.log(`  sin correspondencia local             : ${c.no_local_match}`);
  console.log(`  ya enlazado a OTRO id (conflicto)     : ${c.already_linked_conflict}${c.already_linked_conflict > 0 ? "   ⚠️  revisar a mano" : ""}`);
  console.log(`  fallo al consultar la API              : ${c.fetch_failed}${c.fetch_failed > 0 ? "   ⚠️  ver detalle arriba" : ""}`);

  console.log("\n──────── Relleno del eje de cierre ────────");
  console.log(`  ${apply ? "aplicados" : "se aplicarían"}                        : ${report.closureApplied}`);
  console.log(`  sin señal utilizable (estado/fecha)   : ${report.closureSkippedNoSignal}`);
  console.log(`  bloqueados por un terminal ya fijado   : ${report.closureSkippedBlockedTerminal}`);

  console.log("\n──────── Resumen ────────");
  console.log(`  Pedidos en total (histórico de webhooks) : ${report.total}`);
  console.log(`  Procesados en esta ejecución              : ${report.processed}`);
  console.log(`  Estado                                    : ${report.done ? "COMPLETO" : `PENDIENTE (vuelve a ejecutar${apply ? "" : " con --apply"} para continuar)`}`);
  if (!apply) {
    console.log("\n  Esto ha sido un dry-run: NADA se ha escrito ni el checkpoint se ha movido.");
    console.log("  Repite con --apply cuando el desglose de arriba coincida con lo esperado.\n");
  } else {
    console.log("");
  }
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
