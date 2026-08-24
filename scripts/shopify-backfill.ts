// ============================================================
// Backfill del histórico de Shopify → eje de cierre local (E3).
//
//   npm run shopify:backfill                    # dry-run (no escribe nada)
//   npm run shopify:backfill -- --apply         # escribe de verdad
//   npm run shopify:backfill -- --apply --max-pages=1
//   npm run shopify:backfill -- --reset-checkpoint --apply
//
// Por defecto SIEMPRE dry-run: hace falta --apply explícito para escribir.
// Sin --apply, NUNCA toca la DB ni el checkpoint — solo informa de qué
// haría, con el desglose completo (no solo "N procesados").
//
// SALVAGUARDA ESTRUCTURAL: este script no importa nada de WhatsApp ni de
// Baileys. Ver la cabecera de src/lib/shopify/backfill.ts y el test "E3
// salvaguarda estructural" en tests/run-tests.ts.
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
  const { runShopifyBackfill } = await import("../src/lib/shopify/backfill");
  const { shopifyAdminConfigured } = await import("../src/lib/shopify/admin");

  const apply = hasFlag("apply");
  const resetCheckpoint = hasFlag("reset-checkpoint");
  const maxPagesArg = arg("max-pages");
  const maxPages = maxPagesArg ? parseInt(maxPagesArg, 10) : undefined;

  console.log("\n════════ BACKFILL SHOPIFY → eje de cierre ════════\n");
  console.log(`  Modo            : ${apply ? "⚠️  APLICANDO CAMBIOS DE VERDAD" : "DRY-RUN (no se escribe nada)"}`);
  console.log(`  Checkpoint      : ${resetCheckpoint ? "reiniciado (empieza desde el principio)" : "continúa donde lo dejó la última vez"}`);
  if (maxPages) console.log(`  Tope de páginas : ${maxPages}`);

  if (!shopifyAdminConfigured()) {
    console.log("\n✗ Admin API de Shopify no configurada (falta SHOPIFY_STORE_DOMAIN o credenciales).\n");
    process.exit(1);
  }

  const report = await runShopifyBackfill({
    dryRun: !apply,
    resetCheckpoint,
    maxPages,
    onPage: (n, enPagina) => console.log(`  · página ${n}: ${enPagina} pedido(s)`),
  });

  console.log("\n──────── Desglose ────────");
  console.log(`  unknown → cancelled    : ${report.summary.toCancelled}  (nuevos: ${report.counts.insert_cancelled}, actualizados: ${report.counts.update_cancelled})`);
  console.log(`  unknown → in_progress  : ${report.summary.toInProgress}  (nuevos: ${report.counts.insert_in_progress}, actualizados: ${report.counts.update_in_progress})`);
  console.log(`  sin cambios            : ${report.summary.unchanged}`);
  console.log(`    · no es COD            : ${report.counts.skip_not_cod}`);
  console.log(`    · sin señal de cierre  : ${report.counts.skip_no_signal}`);
  console.log(`    · ya tenía fuente propia (webhook) : ${report.counts.skip_has_own_source}`);
  console.log("\n──────── Resumen ────────");
  console.log(`  Páginas procesadas : ${report.pagesProcessed}`);
  console.log(`  Pedidos vistos     : ${report.ordersSeen}`);
  console.log(`  Estado             : ${report.done ? "COMPLETO (todo el histórico recorrido)" : `PENDIENTE (quedan páginas — vuelve a ejecutar${apply ? "" : " con --apply"} para continuar)`}`);
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
