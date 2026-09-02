// ============================================================
// Diagnóstico de la base de datos y del sistema, por terminal.
//
//   npm run db:health            → chequeo rápido (quick_check)
//   npm run db:health -- --full  → integrity_check completo
//
// Pensado para el NAS (el contenedor NO trae sqlite3: esto lo sustituye).
// Salida SANITIZADA: nada de teléfonos, direcciones ni credenciales.
// Solo lectura: no ejecuta VACUUM, no repara, no borra.
// ============================================================

import "./env-loader";

async function main(): Promise<void> {
  const full = process.argv.includes("--full");
  const core = await import("../src/lib/system/health-core");

  console.log("\n════════ SALUD DEL SISTEMA (solo lectura) ════════\n");

  // --- SQLite ---
  const db = core.getDatabaseHealth({ full });
  const icon = (s: string) => (s === "healthy" ? "✓" : s === "critical" ? "✗" : "⚠️");
  console.log(`SQLite: ${icon(db.status)} ${db.status.toUpperCase()}`);
  console.log(`  Integridad (${full ? "integrity_check" : "quick_check"}): ${db.integrity}`);
  console.log(`  Journal: ${db.journalMode.toUpperCase()}`);
  console.log(`  Tamaño DB: ${core.formatBytes(db.dbSizeBytes)} · WAL: ${core.formatBytes(db.walSizeBytes)}`);
  if (db.walWarning) console.log(`  ⚠️ ${db.walWarning}`);
  console.log(`  Páginas: ${db.pageCount ?? "?"} · freelist: ${db.freelistCount ?? "?"}`);
  console.log(`  Versión de esquema: ${db.schemaVersion} (esperada: ${db.expectedSchemaVersion})`);
  const fecha = (t: number | null) =>
    t ? new Date(t * 1000).toLocaleString("es-ES") : "nunca";
  console.log(`  Última escritura: ${fecha(db.lastWriteAt)}`);
  console.log("  Filas:");
  for (const [tabla, n] of Object.entries(db.rowCounts)) {
    console.log(`    ${tabla}: ${n}`);
  }

  // --- Outbox ---
  const outbox = core.getOutboxHealth();
  console.log(`\nOutbox: ${icon(outbox.status)} ${outbox.status.toUpperCase()} — ${outbox.message}`);
  console.log(
    `  Pendientes: ${outbox.pending} (retenidos: ${outbox.retained}) · enviados 24h: ${outbox.sentLast24h}`
  );
  console.log(`  Último envío: ${fecha(outbox.lastSentAt)}`);

  // --- Backups ---
  const backups = core.getBackupHealth();
  console.log(`\nBackups: ${icon(backups.status)} ${backups.status.toUpperCase()} — ${backups.message}`);
  if (backups.lastBackupAt) {
    console.log(
      `  Última copia: ${backups.lastBackupFile} (${core.formatBytes(backups.lastBackupSizeBytes)}) · integridad: ${backups.integrity}`
    );
  }

  // --- Schedulers ---
  console.log("\nSchedulers:");
  for (const s of core.getSchedulersHealth()) {
    console.log(`  ${icon(s.status)} ${s.name}: ${s.message}`);
  }

  const algúnCritico =
    db.status === "critical" || outbox.status === "critical" || backups.status === "critical";
  console.log(
    algúnCritico
      ? "\n✗ Hay problemas críticos: revisa arriba.\n"
      : "\n✓ Sin problemas críticos.\n"
  );
  process.exit(algúnCritico ? 1 : 0);
}

main().catch((err) => {
  console.error("\n✗", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
