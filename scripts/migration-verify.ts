// ============================================================
// VERIFICACIÓN DE MIGRACIÓN SOBRE UNA COPIA (07-09-2026).
//
//   npm run migration:verify -- --db /ruta/a/copia-de-produccion.db
//   npm run migration:verify -- --db copia.db --json informe.json
//   npm run migration:verify -- --fixture          # humo con el fixture de 116 pedidos
//
// Qué hace, en este orden:
//   1. COPIA el fichero a un directorio temporal (jamás toca el original).
//   2. Lee user_version, integrity_check y recuento de filas por tabla ANTES.
//   3. Abre la copia con el MISMO código que producción: build() de
//      src/lib/db.ts (assertSchemaNotNewer → CREATE IF NOT EXISTS → cadena de
//      migrate*() → estampa user_version = SCHEMA_VERSION). No es una
//      reimplementación de la cadena: es la cadena.
//   4. integrity_check y recuentos DESPUÉS, tiempo de ejecución, y un informe
//      antes/después (consola + JSON opcional).
//
// NO SUSTITUYE la prueba contra datos reales: el valor de esta herramienta es
// que, cuando Pedro traiga una copia real del NAS, correrla sea un comando.
// Con --fixture solo prueba la MECÁNICA sobre datos sintéticos.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}
function hasFlag(nombre: string): boolean {
  return process.argv.slice(2).includes(`--${nombre}`);
}

export interface TableCounts { [table: string]: number }

export interface MigrationVerifyReport {
  source: string;
  copy: string;
  before: { userVersion: number; integrity: string; tables: number; counts: TableCounts };
  after: { userVersion: number; integrity: string; tables: number; counts: TableCounts };
  expectedSchemaVersion: number;
  durationMs: number;
  /** Tablas nuevas creadas por la migración. */
  addedTables: string[];
  /** Tablas cuyo recuento cambió (no debería pasar en una migración aditiva). */
  countDiffs: Array<{ table: string; before: number; after: number }>;
  ok: boolean;
  problems: string[];
}

function snapshot(file: string): { userVersion: number; integrity: string; tables: number; counts: TableCounts } {
  const db = new Database(file, { readonly: true });
  try {
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const counts: TableCounts = {};
    for (const t of tables) counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    return { userVersion, integrity, tables: tables.length, counts };
  } finally {
    db.close();
  }
}

/**
 * Núcleo reutilizable: `open` abre la copia con la ruta de producción. En la
 * CLI es build() de src/lib/db.ts (proceso nuevo con DATA_DIR apuntando a la
 * copia). En los tests, que ya tienen la DB del proceso abierta, se inyecta
 * la cadena de migrate*() explícita sobre la copia.
 */
export async function verifyMigrationOnCopy(
  source: string,
  /** Abre y migra la copia; devuelve el SCHEMA_VERSION que espera el código que la migró. */
  open: (copyFile: string) => Promise<number> | number,
  keepCopy = false
): Promise<MigrationVerifyReport> {
  if (!fs.existsSync(source)) throw new Error(`no existe: ${source}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "casamable-migration-verify-"));
  const copy = path.join(dir, "messages.db");
  fs.copyFileSync(source, copy);
  // Un -wal/-shm huérfano del original no se copia: la copia es un fichero limpio.
  const before = snapshot(copy);
  const problems: string[] = [];
  const started = performance.now();
  let expectedSchemaVersion = -1;
  try {
    expectedSchemaVersion = await open(copy);
  } catch (err) {
    problems.push(`la apertura/migración lanzó: ${err instanceof Error ? err.message : String(err)}`);
  }
  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  const after = snapshot(copy);
  const addedTables = Object.keys(after.counts).filter((t) => !(t in before.counts));
  const countDiffs = Object.keys(before.counts)
    .filter((t) => t in after.counts && after.counts[t] !== before.counts[t])
    .map((t) => ({ table: t, before: before.counts[t], after: after.counts[t] }));
  const removed = Object.keys(before.counts).filter((t) => !(t in after.counts));
  if (removed.length) problems.push(`tablas desaparecidas: ${removed.join(", ")}`);
  if (after.integrity !== "ok") problems.push(`integrity_check después: ${after.integrity}`);
  if (before.integrity !== "ok") problems.push(`integrity_check ANTES ya no era ok: ${before.integrity} (la copia de origen está dañada)`);
  if (after.userVersion !== expectedSchemaVersion) problems.push(`user_version después = ${after.userVersion}, se esperaba ${expectedSchemaVersion}`);
  if (countDiffs.length) problems.push(`recuentos que cambiaron (una migración aditiva no debería tocar filas): ${countDiffs.map((d) => `${d.table} ${d.before}→${d.after}`).join(", ")}`);
  let copyLabel = copy;
  if (!keepCopy) {
    // En Windows el -shm puede seguir mapeado unos ms tras cerrar: la limpieza
    // es best-effort y nunca convierte una verificación correcta en un fallo.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      copyLabel = "(borrada)";
    } catch {
      copyLabel = `${copy} (temporal; no se pudo borrar, sin importancia)`;
    }
  }
  return { source, copy: copyLabel, before, after, expectedSchemaVersion, durationMs, addedTables, countDiffs, ok: problems.length === 0, problems };
}

/** Ruta de producción: build() de db.ts sobre la copia (solo en proceso nuevo). */
async function openWithRealBuild(copyFile: string): Promise<number> {
  // DATA_DIR se fija ANTES de importar db.ts: el módulo lee la ruta al cargar.
  process.env.DATA_DIR = path.dirname(copyFile);
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
  const db = await import("../src/lib/db");
  const handle = db.systemDbHandle();
  handle.pragma("wal_checkpoint(TRUNCATE)");
  handle.close();
  return db.SCHEMA_VERSION;
}

function print(report: MigrationVerifyReport): void {
  console.log("\n════════ VERIFICACIÓN DE MIGRACIÓN SOBRE COPIA ════════\n");
  console.log(`  Origen        : ${report.source}`);
  console.log(`  Copia         : ${report.copy}`);
  console.log(`  user_version  : ${report.before.userVersion} → ${report.after.userVersion} (esperado ${report.expectedSchemaVersion})`);
  console.log(`  integrity     : ${report.before.integrity} → ${report.after.integrity}`);
  console.log(`  tablas        : ${report.before.tables} → ${report.after.tables}${report.addedTables.length ? `  (+ ${report.addedTables.join(", ")})` : ""}`);
  console.log(`  duración      : ${report.durationMs} ms`);
  console.log("\n  Recuentos (antes → después):");
  for (const t of Object.keys(report.after.counts).sort()) {
    const b = report.before.counts[t];
    console.log(`    ${t.padEnd(32)} ${b === undefined ? "(nueva)".padStart(8) : String(b).padStart(8)} → ${String(report.after.counts[t]).padStart(8)}`);
  }
  console.log();
  if (report.ok) {
    console.log("  ✓ La copia migra limpia: mismas filas, integridad ok, esquema esperado.");
  } else {
    console.log("  ✗ PROBLEMAS:");
    for (const p of report.problems) console.log(`    · ${p}`);
  }
  console.log("\n  Esto verifica la MECÁNICA sobre esta copia. No sustituye a correrlo sobre una copia REAL de producción.\n");
}

/** Tablas que aparecieron DESPUÉS del esquema 17 (migraciones 18→29). Se quitan para fabricar un "17 realista". */
const TABLES_AFTER_17 = [
  "users", "sessions", "audit_log", "work_items", "confirmation_resends",
  "product_candidates", "candidate_events",
  "hunter_predictive_estimates",
  "adlib_queries", "adlib_candidates", "adlib_candidate_snapshots",
  "address_validations", "address_alerts",
  "dispatch_cooldowns", "intent_classifications",
  "dispatch_channels",
  "ai_cancellations",
  "ai_call_log",
  "discovery_jobs",
];

/**
 * Fixture REALISTA en esquema 17: se construye con el código real de hoy
 * (build() + insertOrderIfNew/getOrCreateConversation/insertMessage), luego
 * se rebaja: se eliminan las tablas de las migraciones 18→29 y se estampa
 * user_version=17. Datos sintéticos, forma real. Solo para probar la
 * MECÁNICA de la herramienta; no sustituye una copia de producción.
 */
async function createRealisticSchema17Fixture(dir: string): Promise<string> {
  process.env.DATA_DIR = dir;
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
  const db = await import("../src/lib/db");
  for (let i = 1; i <= 116; i++) {
    const phone = `346000${String(100000 + i).slice(-6)}`;
    db.insertOrderIfNew({
      shopify_order_id: `fixture-${i}`, shopify_order_number: `F${1000 + i}`, customer_name: `Cliente ${i}`, phone, email: null,
      product_summary: "1x Organizador de ropa", total_price: "34.99", currency: "EUR",
      address_line1: `Calle Fixture ${i}`, address_line2: null, city: "Madrid", province: "Madrid", postal_code: "28001", country: "ES",
      status: i % 3 === 0 ? "confirmed" : "awaiting_reply",
    });
    if (i <= 63) {
      const convo = db.getOrCreateConversation(phone, `Cliente ${i}`);
      const mensajes = i <= 34 ? 6 : 5; // 34×6 + 29×5 = 349
      for (let m = 0; m < mensajes; m++) db.insertMessage(convo.id, m % 2 === 0 ? "user" : "assistant", `mensaje ${m + 1}`);
    }
  }
  const handle = db.systemDbHandle();
  handle.pragma("wal_checkpoint(TRUNCATE)");
  handle.close();
  const raw = new Database(path.join(dir, "messages.db"));
  raw.pragma("foreign_keys = OFF");
  for (const t of TABLES_AFTER_17) raw.exec(`DROP TABLE IF EXISTS "${t}"`);
  raw.pragma("user_version = 17");
  raw.close();
  return path.join(dir, "messages.db");
}

async function main(): Promise<void> {
  if (hasFlag("fixture")) {
    // El fixture se fabrica en ESTE proceso (importa db.ts con DATA_DIR del
    // fixture) y la verificación corre en un proceso HIJO limpio, exactamente
    // como la correrá Pedro con su copia: build() real sobre la copia.
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "casamable-fixture-"));
    const fixture = await createRealisticSchema17Fixture(dir);
    console.log("  (modo --fixture: datos SINTÉTICOS con forma real, esquema 17, 116 pedidos / 63 conversaciones / 349 mensajes; NO son datos de producción)");
    const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const args = [tsxCli, fileURLToPath(import.meta.url), "--db", fixture, ...(arg("json") ? ["--json", arg("json") as string] : [])];
    const child = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, DATA_DIR: undefined } });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exit(child.status ?? 1);
  }
  const source = arg("db");
  if (!source) {
    console.error("Uso: npm run migration:verify -- --db <copia.sqlite> [--json informe.json] [--keep]   |   --fixture");
    process.exit(2);
  }
  const report = await verifyMigrationOnCopy(path.resolve(source), openWithRealBuild, hasFlag("keep"));
  print(report);
  const jsonPath = arg("json");
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`  Informe JSON: ${jsonPath}\n`);
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && /migration-verify\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("\n✗", err instanceof Error ? err.message : err, "\n");
    process.exit(1);
  });
}
