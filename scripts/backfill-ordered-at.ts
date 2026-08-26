// ============================================================
// T1 — Backfill de `ordered_at` en pedidos ya existentes.
//
//   npm run orders:backfill-ordered-at                # dry-run (no escribe nada)
//   npm run orders:backfill-ordered-at -- --apply      # escribe de verdad
//
// Por defecto SIEMPRE dry-run: hace falta --apply explícito para escribir.
// Reconstruye `ordered_at` (fecha real de compra en Shopify) a partir del
// `raw_payload` que ya se había guardado con cada pedido — nunca llama a la
// API de Shopify ni inventa una fecha. Si una fila no tiene `raw_payload`
// utilizable, se queda en NULL y se cuenta en el desglose: eso es
// información real que falta, no un fallo del script.
//
// SALVAGUARDA: este script no importa nada de WhatsApp ni de Baileys. Ver el
// test "T1 salvaguarda estructural" en tests/run-tests.ts.
// ============================================================

import "./env-loader";

function hasFlag(nombre: string): boolean {
  return process.argv.slice(2).includes(`--${nombre}`);
}

async function main(): Promise<void> {
  const { runBackfillOrderedAt } = await import("../src/lib/shopify/backfill-ordered-at");

  const apply = hasFlag("apply");

  console.log("\n════════ BACKFILL ordered_at (T1) ════════\n");
  console.log(`  Modo : ${apply ? "⚠️  APLICANDO CAMBIOS DE VERDAD" : "DRY-RUN (no se escribe nada)"}`);

  const report = runBackfillOrderedAt({
    dryRun: !apply,
    onItem: (item) => {
      if (item.resolution.kind === "resolved") return; // el resumen ya lo cuenta; no hace falta línea por pedido
      console.log(`  · #${item.shopifyOrderNumber} (id local ${item.id}) → ${item.resolution.kind}`);
    },
  });

  console.log("\n──────── Resumen ────────");
  console.log(`  Filas con ordered_at pendiente (antes de esta pasada) : ${report.total}`);
  console.log(`  ${apply ? "Resueltas y escritas" : "Se resolverían"}                                  : ${report.resolved}`);
  console.log(`  Sin raw_payload guardado                                : ${report.unresolvedNoPayload}`);
  console.log(`  raw_payload no es JSON válido                           : ${report.unresolvedUnparseable}`);
  console.log(`  raw_payload sin created_at utilizable                    : ${report.unresolvedNoDate}`);
  const totalUnresolved = report.unresolvedNoPayload + report.unresolvedUnparseable + report.unresolvedNoDate;
  console.log(`  TOTAL que quedará (o queda) sin resolver                : ${totalUnresolved}`);

  if (!apply) {
    console.log("\n  Esto ha sido un dry-run: NADA se ha escrito.");
    console.log("  Repite con --apply cuando el desglose de arriba coincida con lo esperado.\n");
  } else {
    console.log("");
  }
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
