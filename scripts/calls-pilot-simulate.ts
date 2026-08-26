// ============================================================
// SIMULADOR DEL PILOTO DE LLAMADAS — payload, guardas y franjas, SIN RED.
//
//   npm run calls:pilot:simulate [ruta/al/prompt.txt]
//
// Con un pedido SINTÉTICO (cero PII real) comprueba todo lo que puede
// romper una llamada antes de marcar: las 11 variables del contrato, la
// allowlist fail-closed, las franjas legales y la precedencia
// settings-sobre-env. Si le pasas el prompt, también lo valida.
// Ni Retell ni la DB real se tocan.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "calls-pilot-"));
process.env.DATA_DIR = tmp;
process.env.LOG_LEVEL = "silent";

let fallos = 0;
function check(nombre: string, ok: boolean, detalle?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  if (!ok) fallos++;
}

async function main(): Promise<void> {
  const { buildCallPayload } = await import("../src/lib/calls/payload");
  const { ALLOWED_PROMPT_VARIABLES, validatePromptPlaceholders } = await import("../src/lib/calls/prompt-validator");
  const { callAllowedByAllowlist } = await import("../src/lib/calls/config");
  const { insideCallWindow, madridDate } = await import("../src/lib/calls/schedule");
  const db = await import("../src/lib/db");

  console.log("\n════════ SIMULACIÓN DEL PILOTO DE LLAMADAS (sin red) ════════\n");

  // ── 1. Payload completo con un pedido sintético ──
  console.log("── 1 · Las 11 variables del contrato ──");
  const orden = db.insertOrderIfNew({
    shopify_order_id: "990950", shopify_order_number: "9950", customer_name: "Cliente Simulado",
    phone: "34600000950", email: null, product_summary: "Limpiador Ultrasónico Multiusos",
    total_price: "29.99", currency: "EUR", address_line1: "Calle Ejemplo 12", address_line2: null,
    city: "Vigo", province: "Pontevedra", postal_code: "36201", country: "España", status: "needs_call",
  }).order;
  const payload = buildCallPayload(orden, new Date());
  check("el payload se construye (ok=true)", payload.ok, payload.ok ? "" : `faltan: ${payload.missing.join(", ")}`);
  if (payload.ok && payload.variables) {
    const claves = Object.keys(payload.variables).sort();
    const contrato = [...ALLOWED_PROMPT_VARIABLES].sort();
    check("las claves SON exactamente las del contrato", JSON.stringify(claves) === JSON.stringify(contrato));
    console.log("\n  Variables (pedido sintético, sin PII real):");
    for (const [k, v] of Object.entries(payload.variables)) {
      const mostrado = k === "telefono" ? v.replace(/\d(?=\d{4})/g, "*") : v;
      console.log(`    ${k.padEnd(18)} = ${mostrado}`);
    }
  }

  // ── 2. Campos obligatorios: sin dirección NO se llama ──
  console.log("\n── 2 · La puerta de datos obligatorios ──");
  const sinDireccion = db.insertOrderIfNew({
    shopify_order_id: "990951", shopify_order_number: "9951", customer_name: "Sin Dirección",
    phone: "34600000951", email: null, product_summary: "Producto", total_price: "19.99", currency: "EUR",
    address_line1: null, address_line2: null, city: null, province: null, postal_code: "36201",
    country: "España", status: "needs_call",
  }).order;
  const p2 = buildCallPayload(sinDireccion, new Date());
  check("sin dirección → NO llama y dice qué falta", !p2.ok && p2.missing.length > 0, p2.missing.join(", "));

  // ── 3. Allowlist fail-closed ──
  console.log("\n── 3 · Allowlist (fail-closed del piloto) ──");
  const conTest = (tm: string | undefined, lista: string, tel: string) => {
    const bk = { TM: process.env.TEST_MODE, CA: process.env.CALLS_ALLOWLIST };
    if (tm === undefined) delete process.env.TEST_MODE; else process.env.TEST_MODE = tm;
    process.env.CALLS_ALLOWLIST = lista;
    const r = callAllowedByAllowlist(tel);
    process.env.TEST_MODE = bk.TM; process.env.CALLS_ALLOWLIST = bk.CA;
    if (bk.TM === undefined) delete process.env.TEST_MODE;
    return r;
  };
  check("TEST_MODE=1 + lista vacía → NADIE", conTest("1", "", "34600000950") === false);
  check("TEST_MODE sin definir + lista vacía → NADIE (misma semántica que safety.ts)", conTest(undefined, "", "34600000950") === false);
  check("en la lista → SÍ", conTest("1", "34600000950", "34600000950") === true);
  check("fuera de la lista → NO", conTest("1", "34600000950", "34699999999") === false);

  // ── 4. Franjas legales (código, no configurable) ──
  console.log("\n── 4 · Franjas de llamada (Madrid) ──");
  check("miércoles 11:00 → dentro", insideCallWindow(madridDate(2026, 8, 26, 11, 0)));
  check("miércoles 15:00 → fuera (siesta)", !insideCallWindow(madridDate(2026, 8, 26, 15, 0)));
  check("miércoles 21:30 → fuera", !insideCallWindow(madridDate(2026, 8, 26, 21, 30)));
  check("domingo 11:00 → fuera", !insideCallWindow(madridDate(2026, 8, 30, 11, 0)));

  // ── 5. Precedencia settings > env ──
  console.log("\n── 5 · Precedencia settings (panel) sobre env ──");
  process.env.AI_CALLS_ENABLED = "1";
  db.setSetting("ai_calls_enabled", "0");
  const cfg = await import("../src/lib/calls/config");
  check("settings.ai_calls_enabled=0 GANA a env AI_CALLS_ENABLED=1", cfg.aiCallsEnabled() === false,
    "el kill switch del panel manda: apagar desde el panel apaga DE VERDAD");
  delete process.env.AI_CALLS_ENABLED;

  // ── 6. Prompt (si se pasa) ──
  const rutaPrompt = process.argv[2];
  if (rutaPrompt) {
    console.log("\n── 6 · Validación del prompt ──");
    const r = validatePromptPlaceholders(fs.readFileSync(rutaPrompt, "utf8"));
    check(`prompt sin marcadores rotos (${rutaPrompt})`, r.ok, r.ok ? `usa: ${r.used.join(", ")}` : `${r.issues.length} problema(s)`);
    for (const i of r.issues) console.log(`      · [${i.kind}] ${i.detail}`);
  } else {
    console.log("\n  (Pasa la ruta de un prompt para validarlo: npm run calls:pilot:simulate -- prompt.txt)");
  }

  console.log("\n════════ RESULTADO ════════");
  if (fallos === 0) {
    console.log("✓ TODO CORRECTO — las guardas y el payload están listos para el piloto.");
    console.log("  Recuerda: método de pago en Retell y allowlist rellena ANTES de abrir el kill switch.\n");
  } else {
    console.log(`✗ ${fallos} comprobación(es) fallaron.\n`);
    process.exitCode = 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\n✗ Fallo inesperado:", err instanceof Error ? err.message : err, "\n");
  process.exit(1);
});
