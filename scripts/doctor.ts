// Diagnóstico de errores comunes del kit.
// Ejecutar con: npm run doctor
// Cross-platform.

import "./env-loader";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const issues: string[] = [];

function check(label: string, ok: boolean, fix?: string): void {
  const icon = ok ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
  console.log(`  ${icon} ${label}`);
  if (!ok && fix) {
    console.log(`    ${COLORS.yellow}→ ${fix}${COLORS.reset}`);
    issues.push(`${label}: ${fix}`);
  }
}

// Estado NORMAL de una instalación nueva (la DB y auth/ no existen hasta el
// primer arranque). No es un problema: se informa en gris y NO cuenta como
// error, para no asustar a quien acaba de descargar el kit.
function pending(label: string, note: string): void {
  console.log(`  ${COLORS.dim}○ ${label}${COLORS.reset}`);
  console.log(`    ${COLORS.dim}${note}${COLORS.reset}`);
}

console.log("");
console.log(`${COLORS.bold}${COLORS.blue}Diagnóstico del kit${COLORS.reset}`);
console.log(`${COLORS.dim}Revisando los fallos conocidos del agente de WhatsApp...${COLORS.reset}`);
console.log("");

// ============================================================
// 1. .env.local existe y tiene OPENROUTER_API_KEY
// ============================================================
console.log(`${COLORS.bold}1. Variables de entorno${COLORS.reset}`);
{
  const envLocal = path.resolve(process.cwd(), ".env.local");
  const exists = fs.existsSync(envLocal);
  check(".env.local existe", exists, "Ejecuta /setup en Claude Code o copia .env.example a .env.local");

  if (exists) {
    // Shopify es lo crítico en este proyecto (confirmación de pedidos COD).
    check(
      "SHOPIFY_WEBHOOK_SECRET configurado",
      !!process.env.SHOPIFY_WEBHOOK_SECRET,
      "Pega el secret de firma del webhook (Shopify → Configuración → Notificaciones → Webhooks) en .env.local"
    );
    if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
      console.log(
        `${COLORS.dim}  · SHOPIFY_ADMIN_ACCESS_TOKEN vacío — los pedidos se confirman igual, pero sin tag WA_CONFIRMED en Shopify${COLORS.reset}`
      );
    }

    // La IA es OPCIONAL: el flujo de confirmaciones funciona sin OpenRouter.
    const hasKey = !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== "";
    if (!hasKey) {
      console.log(
        `${COLORS.dim}  · OPENROUTER_API_KEY vacía — agente IA desactivado (opcional; las confirmaciones COD no lo necesitan)${COLORS.reset}`
      );
    } else {
      const model = process.env.OPENROUTER_MODEL ?? "";
      const isFreeModel = model.endsWith(":free");
      check(
        `Modelo: ${model || "(por defecto)"}`,
        !isFreeModel,
        isFreeModel
          ? "Los modelos :free están saturados en producción. Cambia a openai/gpt-4o-mini en .env.local"
          : undefined
      );
    }
  }
}

// ============================================================
// 2. node_modules instalado y TypeScript pasa
// ============================================================
console.log("");
console.log(`${COLORS.bold}2. Dependencias${COLORS.reset}`);
{
  const installed = fs.existsSync(path.resolve(process.cwd(), "node_modules"));
  check("node_modules instalado", installed, "Ejecuta: npm install");

  if (installed) {
    try {
      execSync("npx tsc --noEmit", { stdio: "pipe" });
      check("TypeScript pasa (npx tsc --noEmit)", true);
    } catch {
      check("TypeScript", false, "Hay errores de tipos. Ejecuta 'npx tsc --noEmit' para verlos");
    }
  }
}

// ============================================================
// 3. Estado de conexión WhatsApp
// ============================================================
console.log("");
console.log(`${COLORS.bold}3. Conexión WhatsApp${COLORS.reset}`);
{
  const dbPath = path.resolve(process.cwd(), "data", "messages.db");
  const dbExists = fs.existsSync(dbPath);
  if (dbExists) {
    check("Base de datos (data/messages.db)", true);
  } else {
    pending(
      "Base de datos (data/messages.db) — aún no existe",
      "Normal si el bot no ha arrancado nunca: se crea sola al arrancarlo (npm run start:bot)"
    );
  }

  if (dbExists) {
    try {
      // No importamos db.ts aquí para no ejecutar todo el DDL en este script.
      // Usamos sqlite a través de better-sqlite3 directamente con read-only.
      const Database = require("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT status, phone, qr_string FROM connection_state WHERE id = 1")
        .get() as { status: string; phone: string | null; qr_string: string | null } | undefined;
      db.close();

      if (!row) {
        check("Estado de conexión", false, "Tabla connection_state vacía. Arranca el bot.");
      } else {
        const states = {
          connected: { ok: true, msg: `Conectado como ${row.phone ?? "?"}` },
          qr: { ok: false, msg: "Esperando que escanees el QR en localhost:3000" },
          connecting: { ok: false, msg: "Conectando... espera unos segundos" },
          disconnected: { ok: false, msg: "Desconectado. Arranca el bot: npm run start:bot" },
        } as const;
        const info = states[row.status as keyof typeof states] ?? {
          ok: false,
          msg: `Estado desconocido: ${row.status}`,
        };
        check(`Estado: ${row.status}`, info.ok, info.ok ? undefined : info.msg);
      }
    } catch (err) {
      check(
        "Lectura de DB",
        false,
        `Error: ${err instanceof Error ? err.message : String(err)}. ¿Está el bot corriendo y bloqueando la DB?`
      );
    }
  }
}

// ============================================================
// 4. Carpetas runtime
// ============================================================
console.log("");
console.log(`${COLORS.bold}4. Carpetas runtime${COLORS.reset}`);
{
  const authExists = fs.existsSync(path.resolve(process.cwd(), "auth"));
  if (authExists) {
    check("Sesión de WhatsApp guardada (carpeta auth/)", true);
  } else {
    pending(
      "Sesión de WhatsApp (carpeta auth/) — aún no existe",
      "Normal antes de vincular el teléfono: se crea al escanear el código QR la primera vez"
    );
  }

  // OJO: que el archivo exista NO significa que esté personalizado — el kit lo
  // trae como plantilla con [CORCHETES] por rellenar. Comprobamos el contenido.
  const negocioPath = path.resolve(process.cwd(), "prompts", "negocio.md");
  if (!fs.existsSync(negocioPath)) {
    check(
      "prompts/negocio.md existe",
      false,
      "Falta el guion del negocio. Copia prompts/negocio.example.md a prompts/negocio.md y ejecuta /personaliza"
    );
  } else {
    const negocio = fs.readFileSync(negocioPath, "utf-8");
    // Placeholders de la plantilla: [CORCHETES] en MAYÚSCULAS y la marca del front-matter.
    const placeholders = negocio.match(/\[[A-ZÁÉÍÓÚÑ][^\]\n]*\]/g) ?? [];
    const esPlantilla = /generado:\s*PLANTILLA/i.test(negocio) || placeholders.length > 0;
    if (esPlantilla) {
      pending(
        `prompts/negocio.md — sin personalizar todavía${
          placeholders.length ? ` (${placeholders.length} campos por rellenar)` : ""
        }`,
        "El agente funciona, pero hablará en genérico. Ejecuta /personaliza para adaptarlo a tu negocio"
      );
    } else {
      check("prompts/negocio.md personalizado", true);
    }
  }
}

// ============================================================
// 5. Procesos zombies (solo Windows)
// ============================================================
if (process.platform === "win32") {
  console.log("");
  console.log(`${COLORS.bold}5. Procesos zombies (Windows)${COLORS.reset}`);
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', {
      encoding: "utf-8",
    });
    const nodeCount = (output.match(/node\.exe/g) ?? []).length;
    check(
      `Procesos node.exe activos: ${nodeCount}`,
      nodeCount <= 3,
      nodeCount > 3
        ? `Demasiados procesos node corriendo. Posibles zombies de tsx. Mata con: tasklist | findstr node, luego taskkill /PID <X> /F`
        : undefined
    );
  } catch {
    // Ignorar si tasklist no está disponible
  }
}

// ============================================================
// Cierre
// ============================================================
console.log("");
if (issues.length === 0) {
  console.log(`${COLORS.green}${COLORS.bold}Diagnóstico OK.${COLORS.reset} El kit está sano.`);
  console.log(
    `${COLORS.dim}Las líneas en gris (○) son pasos que aún no has dado, no fallos.${COLORS.reset}`
  );
  process.exit(0);
} else {
  console.log(`${COLORS.red}${COLORS.bold}${issues.length} problema(s) detectado(s).${COLORS.reset}`);
  console.log(`${COLORS.dim}Sigue las flechas amarillas (→) para arreglarlos. Las líneas en gris (○) no son fallos.${COLORS.reset}`);
  console.log("");
  console.log(`Si te quedas atascado, escribe ${COLORS.bold}/setup${COLORS.reset} en Claude Code, o pregunta en la comunidad donde conseguiste el kit pegando lo que ves aquí.`);
  process.exit(1);
}
