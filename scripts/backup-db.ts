// ============================================================
// Backup CONSISTENTE de data/messages.db.
//
//   npm run backup
//
// Usa la API de backup online de SQLite (db.backup()), NO un `cp`: con WAL
// activo, copiar el .db a pelo puede dar una copia corrupta o a medias
// porque parte de los datos vive en el -wal todavía sin fusionar. Esta API
// produce un único fichero coherente aunque el bot esté escribiendo.
//
// Guarda en BACKUP_DIR (por defecto ./backups) y mantiene los últimos
// BACKUP_RETENTION_DAYS (por defecto 7).
// ============================================================

import "./env-loader";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "messages.db");
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.resolve(process.cwd(), "backups");
const RETENTION_DAYS = Math.max(1, parseInt(process.env.BACKUP_RETENTION_DAYS ?? "7", 10) || 7);

/** Marca temporal en hora local: 2026-08-20_1530 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`[backup] no hay base de datos en ${DB_PATH} — nada que copiar`);
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const destino = path.join(BACKUP_DIR, `messages-${stamp()}.db`);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // backup() es asíncrono y seguro con escrituras concurrentes.
    await db.backup(destino);
  } finally {
    db.close();
  }

  // Verificación: la copia debe abrirse y pasar el chequeo de integridad.
  const check = new Database(destino, { readonly: true });
  try {
    const r = check.pragma("integrity_check", { simple: true });
    if (r !== "ok") {
      fs.rmSync(destino, { force: true });
      throw new Error(`la copia no pasó integrity_check (${String(r)}) — descartada`);
    }
    const pedidos = (check.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
    const mb = (fs.statSync(destino).size / 1024 / 1024).toFixed(2);
    console.log(`[backup] ✓ ${path.basename(destino)} (${mb} MB, ${pedidos} pedidos, integridad OK)`);
  } finally {
    check.close();
  }

  // Abrir la copia para verificarla crea ficheros auxiliares -shm/-wal que no
  // forman parte del backup: se borran para dejar UN solo fichero por copia
  // (restaurar es entonces copiar ese .db y nada más).
  for (const sufijo of ["-shm", "-wal"]) {
    fs.rmSync(destino + sufijo, { force: true });
  }

  // Retención: borrar copias más viejas que RETENTION_DAYS.
  const corte = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let borrados = 0;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!/^messages-.*\.db$/.test(f)) continue;
    const full = path.join(BACKUP_DIR, f);
    if (fs.statSync(full).mtimeMs < corte) {
      fs.rmSync(full, { force: true });
      borrados++;
    }
  }
  const quedan = fs.readdirSync(BACKUP_DIR).filter((f) => /^messages-.*\.db$/.test(f)).length;
  console.log(
    `[backup] retención ${RETENTION_DAYS} días: ${borrados} copia(s) antigua(s) borrada(s), ${quedan} conservada(s)`
  );
}

main().catch((err) => {
  console.error("[backup] ✗ falló:", err instanceof Error ? err.message : err);
  process.exit(1);
});
