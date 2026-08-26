// ============================================================
// LOCAL DOCTOR — ¿está mi Mac listo para desarrollar sin riesgo?
//
//   npm run local:doctor
//
// Ejecuta: env:doctor (local-safe) + salud de la DB local + rutas seguras +
// estado de git. CERO red externa, CERO escrituras a Shopify, CERO WhatsApp.
// ============================================================

import "./env-loader";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

async function main(): Promise<void> {
  const bloqueos: string[] = [];
  const avisos: string[] = [];

  console.log("\n════════ CASAMABLE LOCAL DOCTOR ════════\n");

  // 1. Entorno (perfil local-safe).
  const { auditEnvironment } = await import("../src/lib/config/env-schema");
  const audit = auditEnvironment("local-safe");
  if (audit.ready) {
    console.log("✓ Entorno: perfil local-safe en verde");
  } else {
    console.log(`✗ Entorno: falta(n) ${audit.missingRequired.join(", ")} (detalle: npm run env:doctor)`);
    bloqueos.push("entorno local-safe incompleto");
  }
  for (const d of audit.dangers) {
    console.log(`  ${d}`);
    if (d.startsWith("🚨")) bloqueos.push("configuración peligrosa de producción en local");
  }

  // 2. Rutas: la DB local no puede ser un mount del NAS.
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");
  const sospechosa = /\/volume1\/|\/app\/data|nas-data/.test(dataDir);
  if (sospechosa) {
    console.log(`✗ DATA_DIR sospechoso: ${dataDir} — parece una ruta de NAS/producción`);
    bloqueos.push("DATA_DIR apunta fuera del Mac");
  } else {
    console.log(`✓ DB local: ${dataDir} (propia del Mac)`);
  }

  // 3. Salud de la DB local (la crea si no existe: es la local).
  try {
    const db = await import("../src/lib/db");
    const handle = db.systemDbHandle();
    const integridad = handle.pragma("quick_check", { simple: true });
    const version = handle.pragma("user_version", { simple: true });
    const okIntegridad = integridad === "ok";
    const okVersion = version === db.SCHEMA_VERSION;
    console.log(`${okIntegridad ? "✓" : "✗"} SQLite: integridad ${integridad}, esquema ${version} (esperado ${db.SCHEMA_VERSION})`);
    if (!okIntegridad) bloqueos.push("integridad de la DB local");
    if (!okVersion) avisos.push(`esquema ${version} ≠ ${db.SCHEMA_VERSION} (arrancar la app lo migra)`);
  } catch (err) {
    console.log(`✗ SQLite local: ${err instanceof Error ? err.message : err}`);
    bloqueos.push("DB local inaccesible");
  }

  // 4. Puerto del panel.
  const puerto = process.env.PORT ?? "3000";
  console.log(`○ Panel: puerto ${puerto} (npm run dev:all)`);

  // 5. Git: rama y estado.
  try {
    const rama = execSync("git branch --show-current", { encoding: "utf8" }).trim();
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const sucio = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
    console.log(`○ Git: ${rama} @ ${commit}${sucio ? " (cambios sin commitear)" : ""}`);
    if (rama === "main") avisos.push("estás trabajando en main: crea una rama (una tarea = una rama = un PR)");
  } catch {
    avisos.push("no se pudo leer el estado de git");
  }

  if (avisos.length) {
    console.log("\n── AVISOS ──");
    for (const a of avisos) console.log(`  ⚠ ${a}`);
  }

  console.log("\n════════ RESULTADO ════════");
  if (bloqueos.length === 0) {
    console.log("✓ LOCAL DEVELOPMENT READY\n");
  } else {
    console.log("✗ BLOQUEOS:");
    for (const b of bloqueos) console.log(`  · ${b}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
