// ============================================================
// PRE-CHECK DE DESPLIEGUE — npm run deploy:precheck
//
// Se ejecuta ANTES de desplegar, sobre el entorno OBJETIVO:
//   · En el NAS (dentro del contenedor o con su .env cargado): valida el
//     entorno real de producción.
//   · En el Mac: valida lo que haya cargado env-loader (.env.local) — útil
//     para ensayar, pero el veredicto que cuenta es el del NAS.
//
// SOLO LECTURA. Cero red. Cero secretos impresos (ni longitudes ni
// prefijos). No despliega, no migra, no arregla nada: solo dictamina.
//
//   npm run deploy:precheck                        → espera provider baileys
//   npm run deploy:precheck -- --expect-provider=cloud_api
//
// Veredicto: "SAFE TO DEPLOY CODE" (exit 0) o "BLOCKED: …" (exit 1).
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";

function arg(nombre: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

interface Resultado {
  nombre: string;
  nivel: "ok" | "warn" | "block";
  detalle: string;
}

async function main(): Promise<void> {
  const res: Resultado[] = [];
  const push = (nombre: string, nivel: Resultado["nivel"], detalle: string) =>
    res.push({ nombre, nivel, detalle });

  const { auditEnvironment } = await import("../src/lib/config/env-schema");
  const { SCHEMA_VERSION } = await import("../src/lib/db");

  // ── 1. Entorno requerido (perfil nas-production del env-schema) ──
  const perfil = process.env.APP_MODE === "production" ? "nas-production" : "local-safe";
  const audit = auditEnvironment(perfil as "nas-production" | "local-safe");
  if (audit.missingRequired.length) {
    push("env requerida", "block", `faltan para el perfil ${perfil}: ${audit.missingRequired.join(", ")}`);
  } else {
    push("env requerida", "ok", `perfil ${perfil}: completa`);
  }
  // Mismo criterio que env-schema: solo los peligros 🚨 bloquean; el resto
  // son notas (p.ej. "nas-production es documental desde el Mac").
  for (const d of audit.dangers) push("peligro de entorno", d.startsWith("🚨") ? "block" : "warn", d);

  // ── 2. Esquema: la DB del volumen no puede venir de un código MÁS NUEVO ──
  // (código v11 sobre DB v9/v10 migra solo; código viejo sobre DB v12+ no
  // sabe qué hay dentro → eso es un rollback mal hecho, no un deploy.)
  const dataDir = process.env.DATA_DIR || "./data";
  const dbPath = path.join(dataDir, "messages.db");
  if (fs.existsSync(dbPath)) {
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const v = db.pragma("user_version", { simple: true }) as number;
      db.close();
      if (v > SCHEMA_VERSION) {
        push("esquema", "block", `la DB está en v${v} y este código espera v${SCHEMA_VERSION}: la DB viene de un código MÁS NUEVO. No desplegar este código sobre esa DB`);
      } else if (v < SCHEMA_VERSION) {
        push("esquema", "ok", `DB en v${v} → migrará a v${SCHEMA_VERSION} al arrancar (aditiva e idempotente)`);
      } else {
        push("esquema", "ok", `DB ya en v${SCHEMA_VERSION}`);
      }
    } catch (err) {
      push("esquema", "warn", `no se pudo leer ${dbPath}: ${err instanceof Error ? err.message : "error"} (si es el Mac sin DB, ignorar; en el NAS esto es un STOP)`);
    }
  } else {
    push("esquema", "warn", `no hay DB en ${dataDir} — primera instalación o DATA_DIR distinto. En el NAS la DB DEBE existir ya`);
  }

  // ── 3. Proveedor de WhatsApp: el deploy NO cambia de proveedor ──
  const esperado = arg("expect-provider") ?? "baileys";
  const real = (process.env.WHATSAPP_PROVIDER ?? "baileys").trim() || "baileys";
  if (real !== esperado) {
    push("proveedor WhatsApp", "block", `el entorno dice "${real}" y este despliegue esperaba "${esperado}". Si el cambio de proveedor es INTENCIONADO, repite con --expect-provider=${real}; si no, corrige el .env ANTES de desplegar`);
  } else {
    push("proveedor WhatsApp", "ok", `${real} (sin cambio de proveedor)`);
  }
  if (real === "cloud_api") {
    const falta = ["META_WHATSAPP_ACCESS_TOKEN", "META_WHATSAPP_PHONE_NUMBER_ID", "META_WHATSAPP_APP_SECRET"]
      .filter((n) => !(process.env[n] ?? "").trim());
    if (falta.length) push("credenciales Meta", "block", `cloud_api sin ${falta.join(", ")}: nada podría salir`);
    else push("credenciales Meta", "ok", "presentes (no se muestran)");
  }

  // ── 4. Llamadas (Retell): apagadas o piloto estricto; jamás abiertas por un deploy ──
  // La verdad puede estar en settings (DB) con el env de fallback.
  let aiCalls = process.env.AI_CALLS_ENABLED ?? "0";
  let allowlist = (process.env.CALLS_ALLOWLIST ?? "").trim();
  let shadow = process.env.CALLS_SHADOW_MODE ?? "1";
  if (fs.existsSync(dbPath)) {
    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const lee = (k: string): string | undefined =>
        (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
      aiCalls = lee("ai_calls_enabled") ?? aiCalls;
      allowlist = (lee("calls_allowlist") ?? allowlist).trim();
      shadow = lee("calls_shadow_mode") ?? shadow;
      db.close();
    } catch {
      /* sin settings legibles: se queda el env */
    }
  }
  if (aiCalls !== "1") {
    push("llamadas Retell", "ok", "kill switch cerrado (ai_calls_enabled≠1): el deploy no abre llamadas");
  } else if (shadow === "1") {
    push("llamadas Retell", "warn", "ENCENDIDAS en shadow (simulan sin llamar) — revisar que sea intencionado");
  } else if (allowlist) {
    push("llamadas Retell", "warn", "ENCENDIDAS con allowlist — piloto en marcha; el deploy lo mantiene, no lo amplía");
  } else {
    push("llamadas Retell", "block", "encendidas SIN shadow y SIN allowlist: un deploy jamás debe salir así. Cerrar el kill switch o poner allowlist antes");
  }

  // ── 5. Escrituras a proveedores ──
  if ((process.env.DROPEA_WRITE_ENABLED ?? "0") === "1") {
    push("escrituras Dropea", "block", "DROPEA_WRITE_ENABLED=1: el createOrder propio está DESACTIVADO a propósito (la app oficial ya crea pedidos; esto duplicaría). Poner a 0");
  } else {
    push("escrituras Dropea", "ok", "bloqueadas (como debe ser)");
  }
  push(
    "escrituras Shopify",
    "ok",
    (process.env.SHOPIFY_WRITE_ENABLED ?? "0") === "1" ? "habilitadas (tag de confirmados; normal en producción)" : "deshabilitadas"
  );

  // ── 6. Safety gates ──
  const testMode = process.env.TEST_MODE;
  if (testMode === undefined) {
    push("TEST_MODE", "warn", "sin definir = ACTIVO (fail-closed): solo saldrán mensajes a la allowlist de pruebas. En el NAS en producción normal debe ser 0 EXPLÍCITO");
  } else {
    push("TEST_MODE", "ok", testMode === "0" ? "0 (producción normal: se envía a clientes reales)" : `${testMode} (modo prueba: solo allowlist)`);
  }
  if ((process.env.EMERGENCY_STOP ?? "1") === "1" && process.env.EMERGENCY_STOP !== undefined) {
    push("EMERGENCY_STOP", "warn", "ACTIVO: no saldrá nada (ni WhatsApp ni llamadas). Válido para desplegar, pero recordar quitarlo");
  } else if (process.env.EMERGENCY_STOP === undefined) {
    push("EMERGENCY_STOP", "warn", "sin definir = ACTIVO (fail-closed). En el NAS debe ser 0 explícito para operar");
  } else {
    push("EMERGENCY_STOP", "ok", "0 (operación normal)");
  }

  // ── 7. Backups ──
  const backupDir = process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.resolve(process.cwd(), "backups");
  if (fs.existsSync(backupDir)) {
    push("carpeta de backups", "ok", backupDir);
  } else {
    push("carpeta de backups", "warn", `${backupDir} no existe aquí (normal en el Mac; en el NAS haz el backup manual ANTES de desplegar)`);
  }

  // ── Veredicto ──
  console.log("\n════════ DEPLOY PRE-CHECK (solo lectura, sin red) ════════\n");
  const icono = { ok: "✓", warn: "⚠", block: "✗" } as const;
  for (const r of res) console.log(`  ${icono[r.nivel]} ${r.nombre}: ${r.detalle}`);

  const bloqueos = res.filter((r) => r.nivel === "block");
  console.log("\n════════ VEREDICTO ════════");
  if (bloqueos.length) {
    console.log(`  BLOCKED: ${bloqueos.map((b) => b.nombre).join(" · ")}\n`);
    process.exit(1);
  }
  const avisos = res.filter((r) => r.nivel === "warn").length;
  console.log(`  SAFE TO DEPLOY CODE${avisos ? ` (${avisos} aviso(s) arriba: leerlos, no ignorarlos)` : ""}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ El pre-check se rompió:", err instanceof Error ? err.message : err);
  process.exit(1);
});
