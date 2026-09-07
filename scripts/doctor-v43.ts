import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Status = "PASS" | "WARN" | "FAIL";
interface Block { name: string; file: string; args?: string[]; classify?: (code: number, output: string) => Status }
export interface DoctorResult { name: string; status: Status; code: number; detail: string; output: string }

const blocks: Block[] = [
  { name: "DB health", file: "scripts/db-health.ts", args: ["--full"] },
  {
    name: "WhatsApp doctor --check-only", file: "scripts/whatsapp-templates-doctor.ts", args: ["--check-only"],
    classify: (code, output) => code === 0 ? "PASS" : /REAL CREDENTIAL VALIDATION PENDING/.test(output) ? "WARN" : "FAIL",
  },
  { name: "Retell doctor", file: "scripts/retell-doctor.ts", classify: (code) => code === 0 ? "PASS" : code === 2 ? "WARN" : "FAIL" },
  {
    name: "Readiness runtime", file: "scripts/readiness-runtime.ts",
    classify: (code, output) => code !== 0 ? "FAIL" : /WITH WARNINGS/.test(output) ? "WARN" : "PASS",
  },
  { name: "F8 migración v17→v19", file: "scripts/test-migration-v43.ts" },
  {
    name: "F9 aceptación (suite)", file: "tests/run-tests.ts",
    classify: (code, output) => code !== 0 ? "FAIL" : /\b[1-9]\d* omitidos\b/.test(output) ? "WARN" : "PASS",
  },
];

function run(block: Block): DoctorResult {
  const child = spawnSync(process.execPath, ["--import", "tsx", block.file, ...(block.args ?? [])], {
    cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  const code = child.status ?? 1;
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`.trim();
  const status = block.classify?.(code, output) ?? (code === 0 ? "PASS" : "FAIL");
  const last = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0];
  const detail = child.error ? child.error.message : last ?? `exit ${code}`;
  return { name: block.name, status, code, detail: detail.slice(0, 140), output };
}

export function renderDoctor(results: DoctorResult[], summary: boolean): string {
  const lines = ["CASAMABLE v4.3 · DOCTOR UNIFICADO", "", `${"BLOQUE".padEnd(34)} ESTADO DETALLE`, "-".repeat(86)];
  for (const result of results) {
    const detail = summary && result.status === "PASS" ? "" : result.detail;
    lines.push(`${result.name.padEnd(34)} ${result.status.padEnd(6)} ${detail}`.trimEnd());
  }
  const failed = results.filter((result) => result.status === "FAIL");
  const warned = results.filter((result) => result.status === "WARN");
  if (!summary) {
    for (const result of results) lines.push("", `── ${result.name} · ${result.status} ──`, result.output || "(sin salida)");
  } else {
    for (const result of failed) lines.push("", `── DETALLE COMPLETO · ${result.name} ──`, result.output || "(sin salida)");
  }
  lines.push("", `Resultado: ${failed.length ? "FAIL" : warned.length ? "WARN" : "PASS"} · ${failed.length} fallo(s) · ${warned.length} aviso(s)`, "");
  return lines.join("\n");
}

function main(): void {
  const summary = process.argv.includes("--resumen");
  const results = blocks.map(run);
  console.log(renderDoctor(results, summary));
  process.exitCode = results.some((result) => result.status === "FAIL") ? 1 : 0;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) main();
