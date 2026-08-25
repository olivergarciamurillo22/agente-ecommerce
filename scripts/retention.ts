// ============================================================
// Retención de datos y reducción de PII.
//
//   npm run retention                 # dry-run: dice qué haría
//   npm run retention -- --apply      # aplica de verdad
//
// Por defecto SIEMPRE dry-run, como el resto de scripts que tocan datos.
//
// SALVAGUARDA ESTRUCTURAL: no importa nada de WhatsApp ni de Baileys.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const R = await import("../src/lib/system/retention");
  const apply = process.argv.includes("--apply");

  console.log("\n════════ RETENCIÓN DE DATOS ════════\n");
  console.log(`  Modo : ${apply ? "⚠️  APLICANDO DE VERDAD" : "DRY-RUN (no se borra nada)"}`);
  console.log(`  Payloads de Shopify : se reducen tras ${R.rawPayloadRetentionDays()} días (solo pedidos ya cerrados)`);
  console.log(`  Mensajes de WhatsApp: se borran tras ${R.messagesRetentionDays()} días`);
  console.log(`  Entregas de webhook : se borran tras ${R.webhookEventsRetentionDays()} días`);

  const r = R.runRetention({ dryRun: !apply });

  console.log("\n──────── Resultado ────────");
  console.log(`  Payloads ${apply ? "reducidos" : "a reducir"}      : ${r.rawPayloadsReduced}`);
  console.log(`  Mensajes ${apply ? "borrados" : "a borrar"}       : ${r.messagesDeleted}`);
  console.log(`  Webhooks ${apply ? "borrados" : "a borrar"}       : ${r.webhookEventsDeleted}`);
  if (r.errors.length) {
    console.log("\n  ⚠️  Partes que fallaron (las demás sí se aplicaron):");
    for (const e of r.errors) console.log(`    · ${e}`);
  }

  console.log("\n  NO se borra nunca: pedidos, eje de cierre, histórico de estados,");
  console.log("  enlaces con proveedor, costes ni contabilidad. Solo el acompañamiento.\n");
  if (!apply) console.log("  Repite con --apply cuando el desglose cuadre.\n");
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
