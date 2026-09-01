// ============================================================
// Sincroniza insights de Meta Ads a los snapshots locales.
//
//   npm run meta-ads:sync                 → últimos 7 días
//   npm run meta-ads:sync -- --days=30    → ventana mayor (backfill)
//
// READ-ONLY hacia Meta. Escribe SOLO tablas locales de métricas
// (meta_ads_daily y daily_ad_spend); no toca pedidos ni manda nada.
// ============================================================

import "./env-loader";

function arg(nombre: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

async function main(): Promise<void> {
  const { syncMetaAdsInsights } = await import("../src/lib/meta-ads/sync");
  const dias = Math.min(90, Math.max(1, parseInt(arg("days") ?? "7", 10) || 7));

  console.log(`\n════════ META ADS · sync (últimos ${dias} días) ════════\n`);
  const report = await syncMetaAdsInsights({ lookbackDays: dias });

  if (report.skipped) {
    console.log(`○ Omitido: ${report.skippedReason}\n`);
    process.exit(1);
  }
  console.log(`Rango: ${report.since} → ${report.until}`);
  for (const [nivel, n] of Object.entries(report.rowsByLevel)) {
    console.log(`  · ${nivel}: ${n} fila(s)`);
  }
  console.log(`  · gasto volcado a Finanzas: ${report.spendDaysBridged} día(s) (source=meta_api)`);
  if (report.errors.length > 0) {
    console.log(`\n◐ Errores:\n  ${report.errors.join("\n  ")}\n`);
    process.exit(1);
  }
  console.log("\n● Sync completada.\n");
}

main().catch((err) => {
  console.error(`\n✗ Error: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
