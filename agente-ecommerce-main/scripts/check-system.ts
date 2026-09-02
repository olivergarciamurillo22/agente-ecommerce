// Verifica que el sistema cumple los requisitos del kit.
// Ejecutar con: npm run check
// Cross-platform: funciona en Mac, Windows y Linux.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

interface CheckResult {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

const checks: CheckResult[] = [];

// 1. Node.js version
{
  const v = process.versions.node;
  const major = parseInt(v.split(".")[0], 10);
  checks.push({
    ok: major >= 20,
    label: `Node.js ${v}`,
    detail: major >= 20 ? "Versión OK (≥20)" : `Necesitas Node ≥20 (tienes ${v})`,
    fix: major >= 20 ? undefined : "Descarga el LTS más reciente: https://nodejs.org/es/download",
  });
}

// 2. Sistema operativo
{
  const platform = process.platform;
  const supported = ["darwin", "win32", "linux"];
  checks.push({
    ok: supported.includes(platform),
    label: `SO: ${platform} (${os.arch()})`,
    detail: supported.includes(platform) ? "Soportado" : "SO no probado",
  });
}

// 3. npm disponible
{
  try {
    const v = execSync("npm --version", { encoding: "utf-8" }).trim();
    checks.push({
      ok: true,
      label: `npm ${v}`,
      detail: "Disponible",
    });
  } catch {
    checks.push({
      ok: false,
      label: "npm",
      detail: "No encontrado",
      fix: "Reinstala Node.js (npm viene incluido): https://nodejs.org/es/download",
    });
  }
}

// 4. Espacio libre en el directorio actual
{
  try {
    const stat = fs.statfsSync(process.cwd());
    const freeMB = Math.floor((stat.bavail * stat.bsize) / (1024 * 1024));
    checks.push({
      ok: freeMB >= 500,
      label: `Espacio libre: ${freeMB} MB`,
      detail: freeMB >= 500 ? "Suficiente" : "Necesitas al menos 500 MB libres",
    });
  } catch {
    // statfsSync no está en Node 18; en Node 20+ sí. Si falla, no es bloqueante.
    checks.push({
      ok: true,
      label: "Espacio en disco",
      detail: "No se pudo medir (no es bloqueante)",
    });
  }
}

// 5. Archivos clave del kit
{
  const required = ["package.json", "src/lib/db.ts", "scripts/start-bot.ts"];
  const missing = required.filter((f) => !fs.existsSync(path.resolve(process.cwd(), f)));
  checks.push({
    ok: missing.length === 0,
    label: "Estructura del kit",
    detail: missing.length === 0 ? "Completa" : `Faltan: ${missing.join(", ")}`,
    fix: missing.length === 0 ? undefined : "Vuelve a descomprimir el ZIP del kit.",
  });
}

// 6. .env.local existe
{
  const envLocal = fs.existsSync(path.resolve(process.cwd(), ".env.local"));
  const envExample = fs.existsSync(path.resolve(process.cwd(), ".env.example"));
  checks.push({
    ok: envLocal,
    label: ".env.local",
    detail: envLocal
      ? "Configurado"
      : envExample
      ? "No configurado todavía"
      : "Falta también .env.example",
    fix: envLocal ? undefined : "Ejecuta /setup en Claude Code (lo crea automáticamente)",
  });
}

// 7. node_modules instalado
{
  const installed = fs.existsSync(path.resolve(process.cwd(), "node_modules"));
  checks.push({
    ok: installed,
    label: "Dependencias",
    detail: installed ? "Instaladas" : "Faltan",
    fix: installed ? undefined : "Ejecuta: npm install",
  });
}

// ============================================================
// Render del resultado
// ============================================================

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

console.log("");
console.log(`${COLORS.bold}Comprobando sistema...${COLORS.reset}`);
console.log("");

let allOk = true;
for (const c of checks) {
  const icon = c.ok ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
  console.log(`  ${icon} ${COLORS.bold}${c.label}${COLORS.reset}`);
  console.log(`    ${COLORS.dim}${c.detail}${COLORS.reset}`);
  if (c.fix) {
    console.log(`    ${COLORS.yellow}→ ${c.fix}${COLORS.reset}`);
  }
  if (!c.ok) allOk = false;
}

console.log("");
if (allOk) {
  console.log(`${COLORS.green}${COLORS.bold}Todo OK.${COLORS.reset} Listo para continuar.`);
  process.exit(0);
} else {
  console.log(`${COLORS.red}${COLORS.bold}Hay problemas que resolver.${COLORS.reset}`);
  console.log(`${COLORS.dim}Sigue las flechas amarillas (→) para arreglarlos.${COLORS.reset}`);
  process.exit(1);
}
