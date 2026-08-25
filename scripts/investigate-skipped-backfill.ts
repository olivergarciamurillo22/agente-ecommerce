// ============================================================
// T4 — Investigación de pedidos saltados por el backfill (skip_has_own_source).
//
//   npm run orders:investigate-skipped-backfill
//
// SOLO LECTURA. Este script NO tiene flag --apply — no existe ningún modo
// de escritura que activar por error. Pide a Shopify el estado ACTUAL de
// cada pedido que el backfill (E3) saltaría hoy por ya tener su propio
// closure_source/closure_status (normalmente porque el webhook en vivo, E2,
// llegó primero), lo compara con lo que hay guardado localmente, e informa
// las discrepancias. No corrige nada — el informe es para que Pedro decida.
//
// SALVAGUARDA: este script no importa nada de WhatsApp ni de Baileys. Ver
// el test "T4 salvaguarda estructural" en tests/run-tests.ts.
// ============================================================

import "./env-loader";

function fmtDate(epochSec: number | null | undefined): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main(): Promise<void> {
  const { runInvestigation, DEFAULT_HIGHLIGHT_ORDER_NUMBERS } = await import(
    "../src/lib/shopify/investigate-skipped-backfill"
  );
  const { shopifyAdminConfigured } = await import("../src/lib/shopify/admin");

  console.log("\n════════ INVESTIGACIÓN — pedidos saltados por el backfill (T4) ════════\n");
  console.log("  Modo : SOLO LECTURA (no existe --apply en este script)\n");

  if (!shopifyAdminConfigured()) {
    console.log("✗ Admin API de Shopify no configurada (falta SHOPIFY_STORE_DOMAIN o credenciales).\n");
    process.exit(1);
  }

  const report = await runInvestigation({});

  console.log(`  Candidatos (skip_has_own_source en la DB local) : ${report.totalCandidates}`);
  console.log(`  Coinciden con lo que dice Shopify ahora           : ${report.matches}`);
  console.log(`  DISCREPANCIA (local ≠ lo que dice Shopify ahora)  : ${report.discrepancies}${report.discrepancies > 0 ? "   ⚠️" : ""}`);
  console.log(`  Sin señal nueva de Shopify (sigue abierto/no encontrado) : ${report.noLiveSignal}`);

  const discrepancias = report.items.filter((i) => i.kind === "discrepancy");
  if (discrepancias.length > 0) {
    console.log("\n──────── Discrepancias (local vs. Shopify AHORA) ────────");
    for (const item of discrepancias) {
      console.log(
        `  ✗ #${item.local.shopifyOrderNumber} — local: ${item.local.closureStatus} (${item.local.closureSource ?? "sin fuente"}, ${fmtDate(item.local.closureAt)}) ` +
          `| Shopify ahora: ${item.liveSignal?.status} (${fmtDate(item.liveSignal?.at)}, fulfillment_status=${item.liveFulfillmentStatus ?? "null"})`
      );
    }
  }

  const señalados = report.items.filter((i) => i.highlighted);
  console.log(`\n──────── Pedidos señalados aparte (${DEFAULT_HIGHLIGHT_ORDER_NUMBERS.join(", ")}) ────────`);
  if (señalados.length === 0) {
    console.log("  Ninguno de los señalados está en el universo de skip_has_own_source (o no se encontró localmente).");
  }
  for (const item of señalados) {
    console.log(
      `  · #${item.local.shopifyOrderNumber} — local: ${item.local.closureStatus} | ` +
        `Shopify ahora: fulfillment_status=${item.liveFulfillmentStatus ?? "null"}, señal=${item.liveSignal?.status ?? "ninguna"} | ` +
        `${item.notFoundInShopify ? "NO encontrado en Shopify" : item.kind}`
    );
  }

  console.log("\n  Esto es un informe. NADA se ha escrito — ni en la DB local ni en Shopify.\n");
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
