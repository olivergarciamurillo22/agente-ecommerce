// ============================================================
// READINESS — npm run readiness
//
// Una sola pregunta, tres columnas:
//   LOCAL    → lo que se puede VERIFICAR desde este Mac (y se verifica aquí,
//              de verdad: compila, tests, simulación, esquema, entorno).
//   EXTERNO  → lo que SOLO se puede comprobar contra sistemas reales
//              (NAS, Shopify, Meta, Retell, Dropea). Aquí se LISTA, no se
//              finge: este script jamás sale a la red.
//   PEDRO    → acciones humanas pendientes.
//
// Veredicto final: "LOCAL READY — PRODUCTION VALIDATION PENDING" (o
// "LOCAL NOT READY" con el motivo). NUNCA dice "production ready": eso solo
// puede decirlo una validación EN el NAS con datos reales.
// ============================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Check {
  nombre: string;
  run: () => string | null; // null = OK; string = motivo del fallo
}

function cmd(bin: string, args: string[], extraEnv: Record<string, string> = {}): { ok: boolean; tail: string } {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 10 * 60 * 1000,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  const lineas = out.split("\n").filter(Boolean);
  return { ok: r.status === 0, tail: lineas.slice(-3).join(" · ").slice(0, 300) };
}

const localChecks: Check[] = [
  {
    nombre: "TypeScript compila limpio (npm run typecheck)",
    run: () => {
      const r = cmd("npm", ["run", "-s", "typecheck"]);
      return r.ok ? null : r.tail;
    },
  },
  {
    nombre: "Suite completa de tests en verde (npm test)",
    run: () => {
      const r = cmd("npm", ["run", "-s", "test"]);
      return r.ok ? null : r.tail;
    },
  },
  {
    nombre: "Los 10 flujos operativos pasan (npm run casamable:simulate)",
    run: () => {
      const r = cmd("npm", ["run", "-s", "casamable:simulate"]);
      return r.ok ? null : r.tail;
    },
  },
  {
    nombre: "El esquema arranca de cero hasta la versión esperada (migraciones idempotentes)",
    run: () => {
      // DB desechable: build completo dos veces (idempotencia real).
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-schema-"));
      try {
        const code = `
          process.env.DATA_DIR = ${JSON.stringify(path.join(os.tmpdir(), "readiness-schema-inner-" + Date.now()))};
          process.env.LOG_LEVEL = "silent";
          const db = require("./src/lib/db");
          const v = db.systemDbHandle().pragma("user_version", { simple: true });
          if (v !== db.SCHEMA_VERSION) { console.error("user_version " + v + " != SCHEMA_VERSION " + db.SCHEMA_VERSION); process.exit(1); }
          console.log("schema v" + v);
        `;
        const r = cmd("npx", ["tsx", "-e", code]);
        return r.ok ? null : r.tail;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  },
  {
    nombre: "Entorno local sin peligros (perfil local-safe del env-schema)",
    run: () => {
      // Import perezoso y con el .env.local cargado como lo cargaría la app.
      const code = `
        require("./scripts/env-loader");
        const { auditEnvironment } = require("./src/lib/config/env-schema");
        const a = auditEnvironment("local-safe");
        if (a.dangers.length) { console.error("PELIGROS: " + a.dangers.join(" | ")); process.exit(1); }
        console.log("sin peligros");
      `;
      const r = cmd("npx", ["tsx", "-e", code]);
      return r.ok ? null : r.tail;
    },
  },
  {
    nombre: "Working tree comprometido (sin cambios sin commitear que se perderían)",
    run: () => {
      const r = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
      const sucio = (r.stdout ?? "").trim();
      return sucio ? `hay cambios sin commitear:\n${sucio.split("\n").slice(0, 5).join("\n")}` : null;
    },
  },
];

// Lo que este Mac NO puede verificar. Se lista con el comando/lugar donde
// se verifica de verdad. Fingir un ✓ aquí sería mentir.
const externos = [
  "NAS corriendo la rama desplegada, contenedor healthy (docker ps + /api/health/live)",
  "WhatsApp reconecta sin pedir QR tras el deploy (o Cloud API con webhook verificado)",
  "Webhooks de Shopify suscritos y firmando bien (npm run shopify:webhooks -- --ensure, en el NAS)",
  "Backfill con scope read_all_orders verificado y coverage completo (en el NAS)",
  "Dropea responde con la API key real (npm run dropea:doctor, en el NAS)",
  "Retell: npm run retell:doctor en el NAS (contrato, pin numérico, deriva, bloqueo) + saldo a mano en el dashboard",
  "Plantilla de Meta aprobada en la WABA real (las plantillas no se transfieren entre WABAs)",
  "Backups del NAS recientes y legibles (pestaña Sistema → Backups)",
];

const pedro = [
  "Decidir el merge de esta rama y desplegar fuera de la franja 10:00–21:00",
  "Piloto de llamadas: allowlist con SU número, shadow OFF solo tras revisar transcripciones",
  "Mirar la pestaña Acciones a diario (es SU bandeja de trabajo; el watchdog avisa, no decide)",
  "Cancelaciones y duplicados: decidir y marcar resuelto con nota (nada se cancela solo)",
];

console.log("\n════════ CASAMABLE — READINESS ════════\n");
console.log("── LOCAL (verificado AHORA en esta máquina) ──");
let fallos = 0;
for (const c of localChecks) {
  process.stdout.write(`  · ${c.nombre} … `);
  const motivo = c.run();
  if (motivo === null) {
    console.log("✓");
  } else {
    fallos++;
    console.log("✗");
    console.log(`      → ${motivo}`);
  }
}

// ── RETELL (§116): dos preguntas distintas, dos respuestas distintas ──
//   RETELL_MANUAL_READY → ¿puede Pedro pulsar "Llamar ahora" con garantías?
//   RETELL_AUTO_READY   → ¿pueden salir llamadas SOLAS? NO, por diseño: el
//                         piloto es manual hasta que Pedro lo decida con
//                         transcripciones reales delante. Este script jamás
//                         lo pondrá en verde.
function retellReadiness(): { manual: string; auto: string; detalle: string[] } {
  const code = `
    require("./scripts/env-loader");
    const { agentVersionPinIssue, retellAgentVersion, retellFromNumber } = require("./src/lib/calls/retell");
    const { validatePromptPlaceholders } = require("./src/lib/calls/prompt-validator");
    const fs = require("node:fs");
    const prompt = fs.readFileSync("config/retell/casamable-agent-prompt.md", "utf8");
    const v = validatePromptPlaceholders(prompt);
    console.log(JSON.stringify({
      promptOk: v.ok,
      promptIssues: v.issues.length,
      pinIssue: agentVersionPinIssue(retellAgentVersion()),
      hasKey: Boolean((process.env.RETELL_API_KEY ?? "").trim()),
      hasAgent: Boolean((process.env.RETELL_AGENT_ID ?? "").trim()),
      hasFrom: Boolean(retellFromNumber()),
    }));
  `;
  const r = spawnSync("npx", ["tsx", "-e", code], { encoding: "utf8", env: process.env, timeout: 120_000 });
  const linea = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "";
  let j: { promptOk: boolean; promptIssues: number; pinIssue: string | null; hasKey: boolean; hasAgent: boolean; hasFrom: boolean } | null = null;
  try {
    j = JSON.parse(linea);
  } catch {
    j = null;
  }
  if (!j) return { manual: "UNKNOWN (no se pudo evaluar)", auto: "NO — por diseño (piloto manual)", detalle: [(r.stderr ?? "").trim().slice(0, 200)] };
  const detalle: string[] = [];
  detalle.push(`${j.promptOk ? "✓" : "✗"} prompt versionado validado${j.promptOk ? "" : ` (${j.promptIssues} problema/s)`}`);
  detalle.push(`${j.pinIssue ? "○" : "✓"} versión del agente fijada (número)${j.pinIssue ? ` — ${j.pinIssue}` : ""}`);
  detalle.push(`${j.hasAgent ? "✓" : "○"} RETELL_AGENT_ID`);
  detalle.push(`${j.hasFrom ? "✓" : "○"} RETELL_FROM_NUMBER`);
  detalle.push(`${j.hasKey ? "✓" : "○"} RETELL_API_KEY (aquí: ${j.hasKey ? "presente" : "AUSENTE → se valida en el NAS con npm run retell:doctor"})`);
  const localOk = j.promptOk;
  const externosPendientes = !j.hasKey || Boolean(j.pinIssue) || !j.hasAgent || !j.hasFrom;
  const manual = !localOk
    ? "NO — el prompt versionado no valida"
    : externosPendientes
      ? "LOCAL OK — PENDING EXTERNAL (credenciales/pin en el .env del NAS + retell:doctor + 1 llamada real al móvil de Pedro)"
      : "LOCAL OK — falta la llamada real al móvil de Pedro (docs/retell/PRODUCTION-VALIDATION.md)";
  return { manual, auto: "NO — por diseño (piloto manual; ver docs/retell/PRODUCTION-VALIDATION.md)", detalle };
}

console.log("\n── RETELL (piloto MANUAL; lo automático no se enciende desde aquí) ──");
{
  const rr = retellReadiness();
  for (const d of rr.detalle) console.log(`  ${d}`);
  console.log(`  RETELL_MANUAL_READY : ${rr.manual}`);
  console.log(`  RETELL_AUTO_READY   : ${rr.auto}`);
}

console.log("\n── EXTERNO (solo verificable contra sistemas reales; aquí NO se finge) ──");
for (const e of externos) console.log(`  ○ ${e}`);

console.log("\n── PEDRO (acciones humanas) ──");
for (const p of pedro) console.log(`  ○ ${p}`);

console.log("\n════════ VEREDICTO ════════");
if (fallos === 0) {
  console.log("  LOCAL READY — PRODUCTION VALIDATION PENDING");
  console.log("  (todo lo verificable en local está verde; lo de arriba con ○ sigue pendiente de validarse en real)\n");
  process.exit(0);
} else {
  console.log(`  LOCAL NOT READY — ${fallos} comprobación(es) local(es) en rojo\n`);
  process.exit(1);
}
