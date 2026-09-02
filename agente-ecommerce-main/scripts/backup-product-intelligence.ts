import "./env-loader";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), "data");
const backupRoot = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.resolve(process.cwd(), "backups");
const backupDir = path.join(backupRoot, "product-intelligence");
const retentionDays = Math.max(1, Number(process.env.PRODUCT_INTELLIGENCE_BACKUP_RETENTION_DAYS || 14));
const names = ["product-intelligence.json", "product-intelligence-state.json", "product-intelligence-creative-cache.json"];
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function main() {
  fs.mkdirSync(backupDir, { recursive: true }); const files: Array<{ name: string; bytes: number; sha256: string }> = []; const suffix = stamp();
  for (const name of names) {
    const source = path.join(dataDir, name); if (!fs.existsSync(source)) continue;
    JSON.parse(fs.readFileSync(source, "utf8"));
    const destinationName = `${path.basename(name, ".json")}-${suffix}.json`; const destination = path.join(backupDir, destinationName);
    fs.copyFileSync(source, destination); const content = fs.readFileSync(destination);
    files.push({ name: destinationName, bytes: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") });
  }
  const manifest = { createdAt: new Date().toISOString(), source: "PRODUCT_INTELLIGENCE", files };
  fs.writeFileSync(path.join(backupDir, `manifest-${suffix}.json`), JSON.stringify(manifest, null, 2));
  const cutoff = Date.now() - retentionDays * 86400000; let removed = 0;
  for (const file of fs.readdirSync(backupDir)) { const target = path.join(backupDir, file); if (fs.statSync(target).mtimeMs < cutoff) { fs.rmSync(target, { force: true }); removed++; } }
  console.log(`[product-intelligence-backup] files=${files.length} retention_days=${retentionDays} removed=${removed}`);
}
try { main(); } catch (error) { console.error(`[product-intelligence-backup] failed safely: ${error instanceof Error ? error.message : "unknown error"}`); process.exit(1); }
