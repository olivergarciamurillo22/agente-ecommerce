// ============================================================
// Valida un prompt de Retell ANTES de pegarlo en su dashboard.
//
//   npm run calls:validate-prompt -- ruta/al/prompt.txt
//
// Solo texto: no llama a Retell, no toca la DB, no tiene efectos.
// ============================================================

import fs from "node:fs";
import { validatePromptPlaceholders, ALLOWED_PROMPT_VARIABLES } from "../src/lib/calls/prompt-validator";

// Sin argumento valida la FUENTE VERSIONADA del prompt de producción:
// config/retell/casamable-agent-prompt.md (lo que debe estar pegado en
// Retell). Con argumento, valida ese fichero (p.ej. un borrador).
const ruta = process.argv[2] ?? "config/retell/casamable-agent-prompt.md";
console.log("Variables permitidas (contrato de payload.ts):");
for (const v of ALLOWED_PROMPT_VARIABLES) console.log(`  {{${v}}}`);

const prompt = fs.readFileSync(ruta, "utf8");
const r = validatePromptPlaceholders(prompt);

console.log(`\n════════ VALIDACIÓN DEL PROMPT (${ruta}) ════════\n`);
console.log(`Variables del contrato usadas: ${r.used.length ? r.used.join(", ") : "(ninguna)"}`);
if (r.ok) {
  console.log("\n✓ Sin problemas de marcadores. Recuerda igualmente probar una llamada");
  console.log("  con la allowlist antes de abrir nada (el validador no oye al agente).\n");
  process.exit(0);
}
console.log(`\n✗ ${r.issues.length} problema(s) — NO pegar este prompt en Retell todavía:\n`);
for (const i of r.issues) console.log(`  · [${i.kind}] ${i.detail}`);
console.log("");
process.exit(1);
