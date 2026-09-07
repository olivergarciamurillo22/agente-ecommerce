import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const EXPECTED = { orders: 116, conversations: 63, messages: 349, outbox: 180, integration_events: 1700 } as const;

export interface MigrationV43Report {
  durationMs: number;
  integrity: string;
  counts: Record<keyof typeof EXPECTED, number>;
  schemaVersion: number;
}

function seed(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orders (id INTEGER PRIMARY KEY);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER REFERENCES conversations(id));
    CREATE TABLE outbox (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id));
    CREATE TABLE integration_events (id INTEGER PRIMARY KEY);
  `);
  const fill = db.transaction(() => {
    const order = db.prepare("INSERT INTO orders(id) VALUES (?)");
    const conversation = db.prepare("INSERT INTO conversations(id) VALUES (?)");
    const message = db.prepare("INSERT INTO messages(id, conversation_id) VALUES (?, ?)");
    const outbox = db.prepare("INSERT INTO outbox(id, order_id) VALUES (?, ?)");
    const event = db.prepare("INSERT INTO integration_events(id) VALUES (?)");
    for (let i = 1; i <= EXPECTED.orders; i++) order.run(i);
    for (let i = 1; i <= EXPECTED.conversations; i++) conversation.run(i);
    for (let i = 1; i <= EXPECTED.messages; i++) message.run(i, ((i - 1) % EXPECTED.conversations) + 1);
    for (let i = 1; i <= EXPECTED.outbox; i++) outbox.run(i, ((i - 1) % EXPECTED.orders) + 1);
    for (let i = 1; i <= EXPECTED.integration_events; i++) event.run(i);
  });
  fill();
  db.pragma("user_version = 17");
}

/**
 * Escribe el fixture sintético (esquema 17, 116 pedidos…) en un fichero y
 * devuelve su ruta. Lo usa `npm run migration:verify -- --fixture` como
 * prueba de humo de la herramienta. Datos SINTÉTICOS: no sustituyen una
 * copia real de producción.
 */
export function createSchema17FixtureFile(file: string): string {
  const db = new Database(file);
  try {
    seed(db);
  } finally {
    db.close();
  }
  return file;
}

export async function runMigrationV43Test(): Promise<MigrationV43Report> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "casamable-migration-v43-"));
  const dbFile = path.join(dir, "fixture-schema17.db");
  const fixture = new Database(dbFile);
  try {
    seed(fixture);
    const migrations = await import("../src/lib/db");
    const started = performance.now();
    migrations.migrateWorkspaceAuth(fixture);
    fixture.pragma("user_version = 18");
    migrations.migrateProductCandidates(fixture);
    fixture.pragma("user_version = 19");
    migrations.migrateHunterPredictive(fixture);
    fixture.pragma("user_version = 20");
    migrations.migrateHunterDiscovery(fixture);
    fixture.pragma("user_version = 21");
    migrations.migrateAddressValidation(fixture);
    fixture.pragma("user_version = 22");
    migrations.migrateAutoDispatch(fixture);
    fixture.pragma("user_version = 23");
    migrations.migrateDispatchChannels(fixture);
    fixture.pragma("user_version = 24");
    // Segunda pasada: las siete migraciones deben ser idempotentes.
    migrations.migrateWorkspaceAuth(fixture);
    migrations.migrateProductCandidates(fixture);
    migrations.migrateHunterPredictive(fixture);
    migrations.migrateHunterDiscovery(fixture);
    migrations.migrateAddressValidation(fixture);
    migrations.migrateAutoDispatch(fixture);
    migrations.migrateDispatchChannels(fixture);
    const durationMs = Math.round((performance.now() - started) * 100) / 100;

    const counts = Object.fromEntries(Object.keys(EXPECTED).map((table) => {
      const row = fixture.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return [table, row.n];
    })) as Record<keyof typeof EXPECTED, number>;
    for (const [table, expected] of Object.entries(EXPECTED)) {
      if (counts[table as keyof typeof EXPECTED] !== expected) throw new Error(`${table}: se esperaban ${expected} filas`);
    }
    for (const table of ["users", "sessions", "audit_log", "product_candidates", "candidate_events", "hunter_predictive_estimates", "adlib_queries", "adlib_candidates", "adlib_candidate_snapshots", "address_validations", "address_alerts", "dispatch_cooldowns", "intent_classifications", "dispatch_channels"]) {
      if (!fixture.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`falta ${table}`);
    }
    const integrity = String(fixture.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
    return { durationMs, integrity, counts, schemaVersion: Number(fixture.pragma("user_version", { simple: true })) };
  } finally {
    fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  runMigrationV43Test().then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
