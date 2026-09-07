// ============================================================
// SEMÁFORO PRE-DESPLIEGUE (07-09-2026) — docs/deploy/PREDESPLIEGUE.md
//
// Un solo comando el día del despliegue. Ninguna de las comprobaciones es
// nueva por dentro: este script las ORQUESTA y las resume, para que nadie
// tenga que acordarse de qué pasos tocan.
//
//   npm run predeploy:check -- --db C:\copia\messages.db --commit <sha>
//   npm run predeploy:check -- --fixture --commit <sha>        (humo, sin copia real)
//   npm run predeploy:check -- --db ... --commit ... --resumen --json informe.json
//
// QUÉ TOCA:
//   - La base que le pasas NO se abre nunca en escritura. Ni con --apply.
//     La migración se ensaya sobre una COPIA en el temporal del sistema
//     (scripts/migration-verify.ts) y esa copia se borra al terminar.
//   - `--apply` NO escribe en tu base: solo CONSERVA la copia migrada y el
//     informe para que puedas inspeccionarlos. Por defecto (dry-run) se
//     borran.
//   - `npm run build` escribe en .next/ y la suite en un DATA_DIR temporal
//     propio: ambos están fuera de tus datos.
//
// EXIT CODES (elegidos aquí porque en el repo conviven tres convenciones):
//   0 = ningún FALLO (puede haber avisos)
//   1 = al menos un FALLO crítico
//   2 = uso incorrecto del comando
//
// PRODUCTION_COMMIT: aquí significa "el commit que voy a desplegar", y se
// compara con el HEAD del checkout. Es la guarda contra comprobar un código
// distinto del que subes. (En docs/ESTADO-PRODUCCION.md el mismo nombre se
// usa para "el commit que corre HOY en el NAS", que es un dato distinto y
// hoy sigue sin confirmar.)
// ============================================================

import "./env-loader";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCommitIdentity,
  checkFeatureEnv,
  worstStatus,
  type ChannelSummary,
  type FeatureCheck,
  type PredeployStatus,
} from "../src/lib/system/predeploy";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return inline ? inline.slice(nombre.length + 3) : undefined;
}
function hasFlag(nombre: string): boolean {
  return process.argv.includes(`--${nombre}`);
}

const MARK: Record<PredeployStatus, string> = { PASS: "✓", WARN: "!", FAIL: "✗" };

interface Bloque extends FeatureCheck {
  /** Salida completa del proceso hijo, si lo hubo. */
  output?: string;
}

/** Hijo Node siempre por process.execPath: `npm`/`npx` no son ejecutables en Windows. */
function run(file: string, args: string[], opts: { timeout: number; env?: NodeJS.ProcessEnv }): { code: number; output: string } {
  const child = spawnSync(process.execPath, ["--import", "tsx", file, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: opts.env ?? process.env,
    timeout: opts.timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`.trim();
  if (child.error) return { code: 1, output: `${output}\n${child.error.message}`.trim() };
  return { code: child.status ?? 1, output };
}

function git(args: string[]): string | null {
  // git.exe SÍ es un ejecutable real: spawnSync directo es seguro en Windows.
  const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
  if (r.error || (r.status ?? 1) !== 0) return null;
  return (r.stdout ?? "").trim();
}

function leerJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface MigrationReport {
  ok: boolean;
  copy: string;
  before: { userVersion: number; integrity: string; tables: number };
  after: { userVersion: number; integrity: string; tables: number };
  expectedSchemaVersion: number;
  durationMs: number;
  addedTables: string[];
  countDiffs: Array<{ table: string; before: number; after: number }>;
  problems: string[];
}

interface CoverageReport {
  ok: boolean;
  windowDays: number;
  ordersScanned: number;
  ordersWithoutPayload: number;
  products: Array<{ sku: string | null; title: string; channel: string | null; orders: number }>;
  uncovered: Array<{ sku: string | null; title: string; orders: number }>;
  channels: ChannelSummary;
  problems: string[];
}

function render(bloques: Bloque[], resumen: boolean, contexto: string[]): string {
  const l: string[] = ["", "════════ SEMÁFORO PRE-DESPLIEGUE · Casamable v4.3 ════════", ""];
  for (const c of contexto) l.push(`  ${c}`);
  l.push("", `  ${"COMPROBACIÓN".padEnd(34)} ESTADO`, `  ${"-".repeat(80)}`);
  for (const b of bloques) {
    l.push(`  ${MARK[b.status]} ${b.name.padEnd(32)} ${b.status.padEnd(5)} ${b.detail}`.trimEnd());
  }
  const fallos = bloques.filter((b) => b.status === "FAIL");
  const avisos = bloques.filter((b) => b.status === "WARN");
  l.push("", `  ${"-".repeat(80)}`);
  l.push(
    fallos.length
      ? `  RESULTADO: NO DESPLEGAR — ${fallos.length} fallo(s) crítico(s), ${avisos.length} aviso(s)`
      : avisos.length
        ? `  RESULTADO: LISTO CON AVISOS — 0 fallos, ${avisos.length} aviso(s) que hay que leer`
        : "  RESULTADO: LISTO — todo en verde"
  );
  if (fallos.length) {
    l.push("", "  QUÉ FALTA:");
    for (const f of fallos) l.push(`   ✗ ${f.name}: ${f.detail}`);
  }
  if (avisos.length) {
    l.push("", "  AVISOS (no bloquean, pero decides tú):");
    for (const a of avisos) l.push(`   ! ${a.name}: ${a.detail}`);
  }
  const conSalida = bloques.filter((b) => b.output && (!resumen || b.status === "FAIL"));
  for (const b of conSalida) l.push("", `── ${b.name} · ${b.status} ──`, b.output ?? "");
  l.push("");
  return l.join("\n");
}

async function main(): Promise<void> {
  if (hasFlag("help") || hasFlag("h")) {
    console.log("Uso: npm run predeploy:check -- (--db <copia.db> | --fixture) --commit <sha> [--dias 90] [--skip-build] [--skip-tests] [--apply] [--json informe.json] [--resumen]");
    process.exit(2);
  }
  const source = arg("db");
  const fixture = hasFlag("fixture");
  if (!source && !fixture) {
    console.error("Uso: npm run predeploy:check -- --db <copia real de messages.db> --commit <sha>   |   --fixture --commit <sha>");
    console.error("La copia real es la prueba de verdad; --fixture solo comprueba la mecánica.");
    process.exit(2);
  }
  const conservar = hasFlag("apply") || hasFlag("keep");
  const bloques: Bloque[] = [];
  let canales: ChannelSummary | null = null;
  const contexto: string[] = [];
  const temporales: string[] = [];

  // ── 1 · Identidad del commit ────────────────────────────────────────────
  const head = git(["rev-parse", "HEAD"]);
  const declarado = arg("commit") ?? process.env.PRODUCTION_COMMIT;
  bloques.push(checkCommitIdentity(head, declarado));
  contexto.push(`HEAD local        : ${head ?? "(git no disponible)"}`);
  contexto.push(`Commit declarado  : ${(declarado ?? "(ninguno)").trim()}`);

  const sucio = git(["status", "--porcelain"]);
  if (sucio === null) bloques.push({ name: "Árbol de trabajo", status: "WARN", detail: "no se ha podido consultar git status" });
  else if (sucio !== "") {
    const n = sucio.split(/\r?\n/).filter(Boolean).length;
    bloques.push({ name: "Árbol de trabajo", status: "WARN", detail: `${n} fichero(s) sin commitear: NO viajan al NAS (allí se hace checkout del SHA), pero lo que pruebas aquí no es exactamente ese commit` });
  } else bloques.push({ name: "Árbol de trabajo", status: "PASS", detail: "limpio: lo que pruebas es exactamente el commit" });

  // ── 2 · Migración sobre una copia ───────────────────────────────────────
  const informeMigracion = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "casamable-predeploy-")), "migracion.json");
  temporales.push(path.dirname(informeMigracion));
  let copiaMigrada: string | null = null;

  if (fixture) {
    const r = run("scripts/migration-verify.ts", ["--fixture", "--json", informeMigracion], { timeout: 600_000 });
    const rep = leerJson<MigrationReport>(informeMigracion);
    bloques.push({
      name: "Migración (fixture)",
      status: r.code === 0 && rep?.ok ? "WARN" : "FAIL",
      detail:
        r.code === 0 && rep?.ok
          ? `mecánica correcta: ${rep.before.userVersion} → ${rep.after.userVersion}, integridad ${rep.after.integrity}, ${rep.durationMs} ms. DATOS SINTÉTICOS: no sustituye la copia real del NAS`
          : `el ensayo con fixture falló: ${(rep?.problems ?? []).join(" · ") || `exit ${r.code}`}`,
      output: r.output,
    });
    bloques.push({ name: "Cobertura de canales", status: "WARN", detail: "no evaluada: sin copia real no hay catálogo de productos que comprobar" });
  } else {
    const abs = path.resolve(source as string);
    if (!fs.existsSync(abs)) {
      bloques.push({ name: "Migración sobre copia", status: "FAIL", detail: `no existe el fichero: ${abs}` });
    } else {
      const r = run("scripts/migration-verify.ts", ["--db", abs, "--keep", "--json", informeMigracion], { timeout: 900_000 });
      const rep = leerJson<MigrationReport>(informeMigracion);
      if (!rep) {
        bloques.push({ name: "Migración sobre copia", status: "FAIL", detail: `la verificación no dejó informe (exit ${r.code})`, output: r.output });
      } else {
        copiaMigrada = fs.existsSync(rep.copy) ? rep.copy : null;
        if (copiaMigrada) temporales.push(path.dirname(copiaMigrada));
        bloques.push({
          name: "Migración sobre copia",
          status: rep.ok ? "PASS" : "FAIL",
          detail: rep.ok
            ? `user_version ${rep.before.userVersion} → ${rep.after.userVersion} · integridad ${rep.before.integrity} → ${rep.after.integrity} · ${rep.addedTables.length} tabla(s) nueva(s) · sin cambios de filas · ${rep.durationMs} ms`
            : rep.problems.join(" · "),
          output: r.output,
        });
        contexto.push(`Copia verificada  : ${abs}`);
        contexto.push(`Esquema           : ${rep.before.userVersion} → ${rep.after.userVersion} (el código espera ${rep.expectedSchemaVersion})`);
      }
    }

    // ── 3 · Cobertura del router de canal, sobre la COPIA YA MIGRADA ──────
    if (!copiaMigrada) {
      bloques.push({ name: "Cobertura de canales", status: "FAIL", detail: "no hay copia migrada que inspeccionar (la migración falló antes)" });
    } else {
      const informeCobertura = path.join(path.dirname(informeMigracion), "cobertura.json");
      const dias = arg("dias");
      const r = run("scripts/dispatch-coverage.ts", ["--json", informeCobertura, ...(dias ? ["--dias", dias] : [])], {
        timeout: 300_000,
        // La copia se llama messages.db dentro de su temporal: DATA_DIR la señala.
        env: { ...process.env, DATA_DIR: path.dirname(copiaMigrada) },
      });
      const cov = leerJson<CoverageReport>(informeCobertura);
      if (!cov) {
        bloques.push({ name: "Cobertura de canales", status: "FAIL", detail: `no se pudo calcular (exit ${r.code})`, output: r.output });
      } else {
        canales = cov.channels;
        const faltan = cov.uncovered.map((p) => p.sku ?? p.title);
        bloques.push({
          name: "Cobertura de canales",
          status: cov.ok ? "PASS" : "FAIL",
          detail: cov.ok
            ? `${cov.products.length} producto(s) activo(s) en ${cov.windowDays} días, todos con canal (${cov.channels.beeping} Beeping · ${cov.channels.dropea} Dropea)`
            : `SIN CANAL: ${faltan.slice(0, 10).join(", ")}${faltan.length > 10 ? ` (+${faltan.length - 10})` : ""} · ${cov.problems.join(" · ")}`,
          output: r.output,
        });
        if (cov.ordersScanned > 0 && cov.ordersWithoutPayload / cov.ordersScanned > 0.5) {
          bloques.push({ name: "Payloads legibles", status: "WARN", detail: `${cov.ordersWithoutPayload} de ${cov.ordersScanned} pedidos sin raw_payload: la cobertura de canales es parcial` });
        }
      }
    }
  }

  // ── 4 · Coherencia entre flags encendidos y su entorno ──────────────────
  for (const c of checkFeatureEnv({ env: process.env, channels: canales, cwd: process.cwd() })) bloques.push(c);

  // ── 5 · Build y suite ───────────────────────────────────────────────────
  if (hasFlag("skip-build")) bloques.push({ name: "npm run build", status: "WARN", detail: "omitido por --skip-build" });
  else {
    const next = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    const child = spawnSync(process.execPath, [next, "build"], { cwd: process.cwd(), encoding: "utf8", env: process.env, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
    const out = `${child.stdout ?? ""}\n${child.stderr ?? ""}`.trim();
    const code = child.error ? 1 : child.status ?? 1;
    bloques.push({ name: "npm run build", status: code === 0 ? "PASS" : "FAIL", detail: code === 0 ? "compila" : `falla (exit ${code})`, output: out });
  }

  if (hasFlag("skip-tests")) bloques.push({ name: "npm test", status: "WARN", detail: "omitido por --skip-tests" });
  else {
    const r = run("tests/run-tests.ts", [], { timeout: 1_800_000 });
    const linea = r.output.split(/\r?\n/).map((x) => x.trim()).filter((x) => /tests OK/.test(x)).slice(-1)[0] ?? `exit ${r.code}`;
    const omitidos = /\b([1-9]\d*) omitidos\b/.exec(r.output);
    bloques.push({
      name: "npm test",
      status: r.code !== 0 ? "FAIL" : omitidos ? "WARN" : "PASS",
      detail: r.code !== 0 ? `la suite falla: ${linea}` : omitidos ? `${linea} (los omitidos son los que exigen npx con registro; en Windows salen siempre)` : linea,
      output: r.output,
    });
  }

  // ── Salida ──────────────────────────────────────────────────────────────
  contexto.push(`Modo              : ${conservar ? "--apply (se conservan copia e informes)" : "dry-run (la copia migrada se borra al terminar)"}`);
  const texto = render(bloques, hasFlag("resumen"), contexto);
  console.log(texto);

  const jsonPath = arg("json");
  if (jsonPath) {
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ head, declarado: declarado ?? null, resultado: worstStatus(bloques), bloques: bloques.map(({ output: _o, ...b }) => b) }, null, 2)
    );
    console.log(`  Informe JSON: ${jsonPath}\n`);
  }

  if (!conservar) {
    for (const dir of temporales) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best-effort: un temporal que no se borra no invalida nada */
      }
    }
  } else if (copiaMigrada) {
    console.log(`  Copia migrada conservada en: ${copiaMigrada}\n`);
  }

  process.exitCode = bloques.some((b) => b.status === "FAIL") ? 1 : 0;
}


if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("\n✗", err instanceof Error ? err.message : err, "\n");
    process.exitCode = 1;
  });
}
