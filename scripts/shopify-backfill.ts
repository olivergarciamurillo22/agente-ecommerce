// ============================================================
// Backfill del histórico de Shopify → eje de cierre local (E3) y enlace con
// Dropea por el tag `dropea_id:NNNNNNN` (E4).
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
  console.log("\n──────── Enlace con Dropea (E4, eje independiente) ────────");
  console.log(`  ${apply ? "enlazados" : "se enlazarían"} por tag dropea_id : ${apply ? report.dropeaLinked : report.dropeaLink.link}`);
  if (apply && report.dropeaLinked !== report.dropeaLink.link) {
    console.log(`    ⚠️  planificados ${report.dropeaLink.link} pero escritos ${report.dropeaLinked}:`);
    console.log("        el id ya era de otro pedido o alguien enlazó antes. Mira integration_events.");
  }
  console.log(`  sin enlace              : ${report.dropeaLink.already_linked + report.dropeaLink.no_tag + report.dropeaLink.tag_unusable + report.dropeaLink.no_local_order + report.dropeaLink.not_cod}`);
  console.log(`    · ya estaba enlazado    : ${report.dropeaLink.already_linked}`);
  console.log(`    · sin tag dropea_id     : ${report.dropeaLink.no_tag}   (lo normal: son de Dropi PRO)`);
  console.log(`    · tag ambiguo o roto    : ${report.dropeaLink.tag_unusable}${report.dropeaLink.tag_unusable > 0 ? "   ⚠️  revisa integration_events" : ""}`);
  console.log(`    · no existe en local    : ${report.dropeaLink.no_local_order}`);
  console.log(`    · no es COD             : ${report.dropeaLink.not_cod}`);
  console.log("\n──────── Cobertura ────────");
  if (report.coverage === "full") {
    console.log("  ✓ Scope read_all_orders verificado: la API enseña TODO el histórico.");
  } else if (report.coverage === "last_60_days_only") {
    console.log("  ⚠️  FALTA el scope read_all_orders: la API solo devuelve los ÚLTIMOS 60 DÍAS,");
    console.log("      en silencio. Este recorrido NO es el histórico completo. Pide el scope");
    console.log("      en la app de Shopify y vuelve a ejecutar con --reset-checkpoint.");
  } else {
    console.log(`  ⚠️  No se pudieron comprobar los scopes (${report.scopeCheck.error}).`);
    console.log("      No se puede afirmar cobertura completa de este recorrido.");
  }
  console.log("\n──────── Resumen ────────");
  console.log(`  Páginas procesadas : ${report.pagesProcessed}`);
  console.log(`  Pedidos vistos     : ${report.ordersSeen}`);
  console.log(`  Estado             : ${report.done ? (report.coverage === "full" ? "COMPLETO (todo el histórico recorrido)" : "recorrido lo accesible (ver Cobertura)") : `PENDIENTE (quedan páginas — vuelve a ejecutar${apply ? "" : " con --apply"} para continuar)`}`);
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
