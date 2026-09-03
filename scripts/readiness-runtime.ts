// ============================================================
// READINESS DE RUNTIME — npm run readiness:runtime
//
// La pregunta que importa DENTRO del contenedor de producción: ¿está el
// sistema en condiciones de operar AHORA?
//
// Se separa a propósito de `npm run readiness` (P4, 03-09-2026), que es de
// RELEASE: aquel compila con tsc, corre la suite y la simulación, y exige
// un árbol de git limpio. Dentro del contenedor no hay devDependencies ni
// repositorio, así que daba ROJOS FALSOS y acababa ignorándose — que es la
// peor forma de tener una comprobación.
//
// Aquí NO se ejecuta nada de tooling de desarrollo: se lee el estado real
// (base de datos, salud, latidos, configuración) y ya. Tener secretos
// puestos es lo NORMAL y nunca es un error.
//
// Veredicto: RUNTIME READY · RUNTIME READY WITH WARNINGS · RUNTIME NOT READY
// Salidas: 0 = listo (con o sin avisos) · 1 = no listo.
// ============================================================

import "./env-loader";

type Nivel = "ok" | "warn" | "fail" | "info";

interface Resultado {
  nivel: Nivel;
  etiqueta: string;
  detalle: string;
}

const resultados: Resultado[] = [];
const add = (nivel: Nivel, etiqueta: string, detalle: string) => resultados.push({ nivel, etiqueta, detalle });
const ICONO: Record<Nivel, string> = { ok: "●", warn: "◐", fail: "○", info: "·" };

async function main(): Promise<void> {
  console.log("\n════════ CASAMABLE — READINESS DE RUNTIME ════════\n");

  // ── 1 · Modo de la aplicación ─────────────────────────────
  const appMode = (process.env.APP_MODE ?? "").trim() || "(sin definir)";
  const emergency = (process.env.EMERGENCY_STOP ?? "").trim() === "1";
  add(appMode === "production" ? "ok" : "warn", "APP_MODE", appMode);
  add(emergency ? "warn" : "ok", "EMERGENCY_STOP", emergency ? "ACTIVO: no sale nada al exterior" : "inactivo");

  // ── 2 · Base de datos y esquema ───────────────────────────
  let db: typeof import("../src/lib/db") | null = null;
  try {
    db = await import("../src/lib/db");
    const h = db.systemDbHandle();
    const version = h.pragma("user_version", { simple: true }) as number;
    const integridad = h.pragma("quick_check", { simple: true }) as string;
    const pedidos = (h.prepare("SELECT COUNT(*) c FROM orders").get() as { c: number }).c;
    add(version === db.SCHEMA_VERSION ? "ok" : "fail", "Esquema", `${version} (esperado ${db.SCHEMA_VERSION})`);
    add(integridad === "ok" ? "ok" : "fail", "Integridad de la base", String(integridad));
    add("info", "Pedidos en la base", String(pedidos));
  } catch (err) {
    add("fail", "Base de datos", `no se pudo abrir: ${err instanceof Error ? err.message : "error"}`);
  }

  // ── 3 · Salud de servicios y latidos ──────────────────────
  if (db) {
    try {
      const health = await import("../src/lib/system/health-core");
      const ahora = Math.floor(Date.now() / 1000);
      for (const s of health.getSchedulersHealth()) {
        const ultimo = s.lastHeartbeatAt ?? null;
        const edad = ultimo ? ahora - ultimo : null;
        const nivel: Nivel = s.status === "healthy" ? "ok" : s.status === "critical" ? "fail" : "warn";
        add(nivel, `Scheduler ${s.name}`, edad === null ? "sin latido registrado" : `último latido hace ${Math.floor(edad / 60)} min`);
      }
    } catch (err) {
      add("warn", "Salud de schedulers", `no se pudo leer: ${err instanceof Error ? err.message : "error"}`);
    }
  }

  // ── 4 · WhatsApp ──────────────────────────────────────────
  try {
    const { whatsappProviderName } = await import("../src/lib/whatsapp/provider");
    const proveedor = whatsappProviderName();
    add("info", "Proveedor de WhatsApp", proveedor);
    const tpl = await import("../src/lib/whatsapp/templates");
    const r = tpl.getTemplateReadiness("order_confirmation_request");
    add(r.ready ? "ok" : "fail", "Plantilla de confirmación", r.ready ? r.detail : `${r.blocker}: ${r.detail}`);
  } catch (err) {
    add("warn", "WhatsApp", `no se pudo comprobar: ${err instanceof Error ? err.message : "error"}`);
  }

  // ── 5 · Llamadas (Retell) ─────────────────────────────────
  try {
    const cfg = await import("../src/lib/calls/config");
    const { retellAgentVersion, agentVersionPinIssue, retellFromNumber } = await import("../src/lib/calls/retell");
    const bloqueo = cfg.callsBlockedReason();
    add(bloqueo ? "fail" : "ok", "Bloqueo global de llamadas", bloqueo ?? "ninguno");
    add(
      "info",
      "Modo de llamadas",
      `interruptor=${cfg.aiCallsEnabled() ? "ON" : "OFF"} · sombra=${cfg.callsShadowMode() ? "ON" : "OFF"} · piloto=${cfg.callsPilotMode() ? "ON" : "OFF"} · autorizados=${cfg.callsAllowlist().length} · tope=${cfg.callsDailyCap()}`
    );
    if (cfg.aiCallsEnabled() && cfg.callsPilotMode() && cfg.callsAllowlist().length === 0) {
      add("warn", "Piloto de llamadas", "encendidas en piloto SIN teléfonos autorizados: no saldrá ninguna");
    }
    const pin = agentVersionPinIssue(retellAgentVersion());
    add(pin ? "warn" : "ok", "Versión del agente", pin ?? `fijada en ${retellAgentVersion()}`);
    add((process.env.RETELL_API_KEY ?? "").trim() ? "ok" : "warn", "RETELL_API_KEY", (process.env.RETELL_API_KEY ?? "").trim() ? "presente" : "ausente: no se pueden crear ni verificar llamadas");
    add(retellFromNumber() ? "ok" : "warn", "Número saliente", retellFromNumber() || "ausente");
  } catch (err) {
    add("warn", "Llamadas", `no se pudo comprobar: ${err instanceof Error ? err.message : "error"}`);
  }

  // ── 6 · Firma REAL de los webhooks de Retell ──────────────
  //     Solo la API key con distintivo "webhook" firma los webhooks. Que la
  //     key sirva para la API NO demuestra que sirva para verificar.
  if (db) {
    try {
      const marca = db.getSetting("retell_webhook_signature_verified_at");
      if (marca) {
        add("ok", "Firma real de webhooks Retell", `verificada el ${new Date(Number(marca) * 1000).toISOString()}`);
      } else {
        add("warn", "Firma real de webhooks Retell", "UNVERIFIED_EXTERNAL: ninguna firma REAL ha validado todavía (ver docs/retell/PRODUCTION-VALIDATION.md)");
      }
    } catch {
      add("warn", "Firma real de webhooks Retell", "no se pudo leer la marca");
    }
  }

  // ── Veredicto ─────────────────────────────────────────────
  for (const r of resultados) console.log(`  ${ICONO[r.nivel]} ${r.etiqueta.padEnd(32)} ${r.detalle}`);
  const fallos = resultados.filter((r) => r.nivel === "fail");
  const avisos = resultados.filter((r) => r.nivel === "warn");
  console.log("\n════════ VEREDICTO ════════");
  if (fallos.length > 0) {
    console.log(`  RUNTIME NOT READY — ${fallos.length} comprobación(es) en rojo:`);
    for (const f of fallos) console.log(`    ✗ ${f.etiqueta}: ${f.detalle}`);
    console.log();
    process.exit(1);
  }
  console.log(avisos.length === 0 ? "  RUNTIME READY" : `  RUNTIME READY WITH WARNINGS — ${avisos.length} aviso(s)`);
  console.log();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ Error inesperado: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
