// ============================================================
// GUARDA DE DESPLIEGUE — SOLO LECTURA. No despliega, no para nada.
//
//   npm run deploy:guard
//   npm run deploy:guard -- --data-dir /volume1/docker/CasamableAgent/data
//
// Responde a UNA pregunta: ¿hay más de un contenedor de Casamable vivo
// montando la MISMA carpeta de datos?
//
// Por qué existe (P7/23, 03-09-2026): producción corre bajo el proyecto de
// Compose `repo-v3c`. Levantar `docker compose up -d` desde otra carpeta
// creaba un proyecto distinto y, con él, un SEGUNDO bot sobre la misma
// SQLite: dos schedulers enviando, dos watchdogs avisando y estado
// corrompido. El compose ya fija `name: repo-v3c`, pero esta guarda no se
// fía del nombre: compara los MONTAJES reales, que es lo que de verdad
// determina si dos procesos comparten la base.
//
// Salida: 0 = seguro · 1 = PELIGRO (dos o más) · 2 = no se pudo comprobar.
// ============================================================

import { spawnSync } from "node:child_process";

const DEFAULT_DATA_DIR = "/volume1/docker/CasamableAgent/data";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

interface Contenedor {
  id: string;
  name: string;
  image: string;
  project: string;
  state: string;
  dataSources: string[];
}

function docker(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}`.trim() };
}

function main(): void {
  const dataDir = arg("data-dir") ?? DEFAULT_DATA_DIR;
  console.log("\n════════ GUARDA DE DESPLIEGUE · ¿hay dos bots sobre los mismos datos? ════════\n");
  console.log(`  Carpeta de datos vigilada: ${dataDir}\n`);

  const ps = docker(["ps", "--format", "{{.ID}}"]);
  if (!ps.ok) {
    console.log("  ◐ no se pudo hablar con Docker: comprueba a mano con `docker ps`.\n");
    process.exit(2);
  }
  const ids = ps.out.split("\n").filter(Boolean);
  if (ids.length === 0) {
    console.log("  ● no hay ningún contenedor en marcha.\n");
    process.exit(0);
  }

  const contenedores: Contenedor[] = [];
  for (const id of ids) {
    const fmt = [
      "{{.Id}}",
      "{{.Name}}",
      "{{.Config.Image}}",
      '{{index .Config.Labels "com.docker.compose.project"}}',
      "{{.State.Status}}",
      '{{range .Mounts}}{{.Source}};{{end}}',
    ].join("|");
    const insp = docker(["inspect", "--format", fmt, id]);
    if (!insp.ok) continue;
    const [cid, name, image, project, state, mounts] = insp.out.split("|");
    const fuentes = (mounts ?? "").split(";").filter(Boolean);
    // Coincide si monta la carpeta de datos o cualquier ruta por debajo/encima
    // de ella (montar el padre da acceso a la misma SQLite).
    const dataSources = fuentes.filter((f) => f === dataDir || f.startsWith(`${dataDir}/`) || dataDir.startsWith(`${f}/`));
    if (dataSources.length > 0) {
      contenedores.push({
        id: (cid ?? id).slice(0, 12),
        name: (name ?? "").replace(/^\//, ""),
        image: image ?? "?",
        project: project && project !== "<no value>" ? project : "(sin proyecto de compose)",
        state: state ?? "?",
        dataSources,
      });
    }
  }

  if (contenedores.length === 0) {
    console.log("  ● ningún contenedor en marcha monta esa carpeta de datos.\n");
    process.exit(0);
  }

  for (const c of contenedores) {
    console.log(`  · ${c.name} (${c.id}) · proyecto=${c.project} · estado=${c.state}`);
    console.log(`      imagen : ${c.image}`);
    for (const s of c.dataSources) console.log(`      monta  : ${s}`);
  }
  console.log();

  if (contenedores.length === 1) {
    console.log("  ● UN solo contenedor sobre esos datos. Seguro para desplegar.\n");
    process.exit(0);
  }

  console.log(`  ✗ PELIGRO: ${contenedores.length} contenedores vivos comparten la MISMA base de datos.`);
  console.log("    Dos bots = dos schedulers enviando y estado corrompido. NO despliegues.");
  console.log("    Deja UNO solo (normalmente el del proyecto repo-v3c) y vuelve a ejecutar esta guarda:");
  for (const c of contenedores) console.log(`      docker stop ${c.name}   # proyecto ${c.project}`);
  console.log();
  process.exit(1);
}

main();
