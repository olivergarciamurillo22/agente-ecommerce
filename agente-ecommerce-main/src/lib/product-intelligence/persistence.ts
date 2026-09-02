import fs from "node:fs";
import path from "node:path";

export function intelligenceDataDir(): string {
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true }); return dir;
}

function validJson<T>(file: string): T | undefined { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return undefined; } }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function withLock<T>(target: string, operation: () => T): T {
  const lock = `${target}.lock`; let descriptor: number | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { descriptor = fs.openSync(lock, "wx"); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch { /* another writer released it */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (descriptor === undefined) throw new Error("Product Intelligence repository lock timeout");
  try { return operation(); } finally { try { fs.closeSync(descriptor); } catch { /* already closed */ } try { fs.unlinkSync(lock); } catch { /* lock already cleared */ } }
}

export function readJsonRecovering<T>(target: string, fallback: () => T): T {
  if (!fs.existsSync(target)) return fallback();
  const parsed = validJson<T>(target); if (parsed !== undefined) return parsed;
  const corrupt = path.join(path.dirname(target), `${path.basename(target, ".json")}.corrupt.${stamp()}.json`);
  fs.renameSync(target, corrupt);
  const backup = validJson<T>(`${target}.bak`);
  if (backup !== undefined) return backup;
  console.error(`[product-intelligence] corrupted repository preserved as ${path.basename(corrupt)}`);
  return fallback();
}

export function writeJsonAtomic<T>(target: string, value: T): void {
  withLock(target, () => {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`; const payload = JSON.stringify(value, null, 2);
    if (fs.existsSync(target) && validJson(target) !== undefined) fs.copyFileSync(target, `${target}.bak`);
    const descriptor = fs.openSync(temporary, "w");
    try { fs.writeFileSync(descriptor, payload); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    try { const dir = fs.openSync(path.dirname(target), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* directory fsync is platform dependent */ }
  });
}

export function persistenceHealth(): { healthy: boolean; dataDir: string; files: Array<{ name: string; status: "missing" | "valid" | "corrupt"; bytes: number }> } {
  const dataDir = intelligenceDataDir(); const names = ["product-intelligence.json", "product-intelligence-state.json", "product-intelligence-creative-cache.json"];
  const files = names.map((name) => { const target = path.join(/* turbopackIgnore: true */ dataDir, name); if (!fs.existsSync(/* turbopackIgnore: true */ target)) return { name, status: "missing" as const, bytes: 0 }; const bytes = fs.statSync(/* turbopackIgnore: true */ target).size; return { name, status: validJson(target) === undefined ? "corrupt" as const : "valid" as const, bytes }; });
  return { healthy: files.every((file) => file.status !== "corrupt"), dataDir, files };
}
