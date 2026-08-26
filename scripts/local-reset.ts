// ============================================================
// Borra la DB LOCAL para empezar de cero. SOLO en el Mac.
//
//   npm run local:reset            # pregunta qué borraría (dry-run)
//   npm run local:reset -- --yes   # borra de verdad
//
// SE NIEGA si APP_MODE=production o si DATA_DIR parece del NAS: este
// comando no puede tocar producción ni por accidente.
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");

if (process.env.APP_MODE === "production") {
  console.error("\n✗ APP_MODE=production: local:reset se NIEGA a ejecutarse.\n");
  process.exit(1);
}
if (/\/volume1\/|\/app\/data|nas-data/.test(dataDir)) {
  console.error(`\n✗ DATA_DIR (${dataDir}) parece del NAS/producción: local:reset se NIEGA.\n`);
  process.exit(1);
}

const objetivo = [path.join(dataDir, "messages.db"), path.join(dataDir, "messages.db-wal"), path.join(dataDir, "messages.db-shm")];
const existentes = objetivo.filter((f) => fs.existsSync(f));

if (existentes.length === 0) {
  console.log(`\n✓ Nada que borrar en ${dataDir}.\n`);
  process.exit(0);
}
if (!process.argv.includes("--yes")) {
  console.log(`\nBorraría (SOLO la DB local del Mac):`);
  for (const f of existentes) console.log(`  · ${f}`);
  console.log("\nRepite con -- --yes para borrar de verdad.\n");
  process.exit(0);
}
for (const f of existentes) fs.unlinkSync(f);
console.log(`\n✓ DB local borrada (${existentes.length} fichero(s)). La próxima ejecución la recrea vacía.\n`);
