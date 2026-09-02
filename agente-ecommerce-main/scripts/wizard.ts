// CLI wizard de setup como fallback para quien no use Claude Code.
// Ejecutar con: npm run wizard

import "./env-loader";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import enquirer from "enquirer";
import chalk from "chalk";
import boxen from "boxen";

const { prompt } = enquirer;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ask<T>(config: any): Promise<T> {
  const result = (await prompt(config)) as T;
  return result;
}

function info(msg: string): void {
  console.log(chalk.blue("ℹ"), msg);
}

function ok(msg: string): void {
  console.log(chalk.green("✓"), msg);
}

function warn(msg: string): void {
  console.log(chalk.yellow("⚠"), msg);
}

function fail(msg: string): void {
  console.log(chalk.red("✗"), msg);
}

async function main(): Promise<void> {
  console.log(
    boxen(
      chalk.bold("Asistente de instalación del Agente WhatsApp\n\n") +
        chalk.dim("Te guío en 4 pasos. Sin tocar nada técnico."),
      { padding: 1, borderColor: "cyan", borderStyle: "round" }
    )
  );
  console.log("");

  // ============================================================
  // FASE A · Validación silenciosa
  // ============================================================
  info("Comprobando sistema...");

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 20) {
    fail(`Necesitas Node 20+. Tienes ${process.versions.node}.`);
    info("Descarga: https://nodejs.org/es/download");
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);
  ok(`SO: ${process.platform} (${process.arch})`);

  // ============================================================
  // FASE B · Instalar dependencias
  // ============================================================
  const nodeModulesExists = fs.existsSync(path.resolve(process.cwd(), "node_modules"));
  if (!nodeModulesExists) {
    info("Instalando dependencias (puede tardar 1-2 minutos)...");
    try {
      execSync("npm install", { stdio: "inherit" });
      ok("Dependencias instaladas");
    } catch {
      fail("npm install falló. Mira el error de arriba y consulta docs/07-errores-comunes.md");
      process.exit(1);
    }
  } else {
    ok("Dependencias ya instaladas");
  }

  // ============================================================
  // FASE C · OpenRouter API key
  // ============================================================
  const envLocalPath = path.resolve(process.cwd(), ".env.local");
  const envExamplePath = path.resolve(process.cwd(), ".env.example");

  let currentEnv: Record<string, string> = {};
  if (fs.existsSync(envLocalPath)) {
    const text = fs.readFileSync(envLocalPath, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      currentEnv[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  } else if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envLocalPath);
    info(".env.local creado desde .env.example");
  }

  const hasKey =
    currentEnv.OPENROUTER_API_KEY &&
    currentEnv.OPENROUTER_API_KEY !== "" &&
    !currentEnv.OPENROUTER_API_KEY.includes("tu-api-key-aqui");

  if (!hasKey) {
    console.log("");
    info("Necesitas una API key de OpenRouter (es la pasarela al modelo de IA)");
    info("Sácala aquí: https://openrouter.ai/keys");
    console.log("");

    const { apiKey } = await ask<{ apiKey: string }>({
      type: "input",
      name: "apiKey",
      message: "Pega tu API key de OpenRouter (empieza por sk-or-v1-):",
      validate: (value: string) => {
        if (!value.startsWith("sk-or-")) {
          return "Una API key de OpenRouter empieza por sk-or-v1- o sk-or-";
        }
        return true;
      },
    });

    currentEnv.OPENROUTER_API_KEY = apiKey.trim();
    if (!currentEnv.OPENROUTER_MODEL || currentEnv.OPENROUTER_MODEL === "") {
      // Mismo modelo por defecto que .env.example (Recomendado).
      // Alternativa más barata a gran volumen: openai/gpt-4o-mini
      currentEnv.OPENROUTER_MODEL = "anthropic/claude-haiku-4.5";
    }

    // Escribir .env.local conservando comentarios del .env.example si existe
    let baseContent = "";
    if (fs.existsSync(envExamplePath)) {
      baseContent = fs.readFileSync(envExamplePath, "utf-8");
    }

    // Sustituir las líneas con los valores actuales
    let newContent = baseContent;
    for (const [key, value] of Object.entries(currentEnv)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(newContent)) {
        newContent = newContent.replace(regex, `${key}=${value}`);
      } else {
        newContent += `\n${key}=${value}`;
      }
    }
    fs.writeFileSync(envLocalPath, newContent);
    ok("API key guardada en .env.local");
  } else {
    ok("API key de OpenRouter ya configurada");
  }

  // ============================================================
  // FASE D · Arrancar bot + dashboard
  // ============================================================
  console.log("");
  info("Voy a arrancar el bot y el dashboard.");
  info("Cuando aparezca el QR en http://localhost:3000, escanéalo con WhatsApp.");
  info("(WhatsApp → Configuración → Dispositivos vinculados → Vincular un dispositivo)");
  console.log("");

  const { confirma } = await ask<{ confirma: boolean }>({
    type: "confirm",
    name: "confirma",
    message: "¿Listo para arrancar?",
    initial: true,
  });

  if (!confirma) {
    info("Cuando estés listo: npm run build y después npm run start:all");
    process.exit(0);
  }

  // start:all usa `next start` (modo producción), que necesita un build previo.
  // Sin esto, el primer arranque falla con "Could not find a production build".
  const nextBuildExists = fs.existsSync(path.resolve(process.cwd(), ".next"));
  if (!nextBuildExists) {
    console.log("");
    info("Compilando el panel (~1 minuto, solo la primera vez)...");
    try {
      execSync("npm run build", { stdio: "inherit" });
      ok("Panel compilado");
    } catch {
      fail("La compilación falló. Mira el error de arriba y consulta docs/07-errores-comunes.md");
      process.exit(1);
    }
  }

  console.log("");
  ok("Arrancando... (Ctrl+C para parar)");
  console.log("");

  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  spawn(cmd, ["run", "start:all"], { stdio: "inherit", shell: false });
}

main().catch((err) => {
  fail(`Error inesperado: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
