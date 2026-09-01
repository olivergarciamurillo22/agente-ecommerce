// ============================================================
// Simulador de llamada — CERO red, CERO marcado. El preflight completo
// que debe estar en verde ANTES de llamar a nadie:
//
//   npm run calls:simulate                     → fixture sintética
//   npm run calls:simulate -- --order <id>     → un pedido REAL de la DB local
//
// Comprueba: las 11 variables (contrato payload.ts), el preflight de
// seguridad (unsafe_dynamic_variable), el prompt versionado, la política
// de versión del agente y el from number. Sin PII en la salida: el
// teléfono va enmascarado.
// ============================================================

import "./env-loader";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

const mask = (v: string) => (v.length > 4 ? `${"*".repeat(v.length - 4)}${v.slice(-4)}` : "****");

async function main(): Promise<void> {
  const { buildCallPayload } = await import("../src/lib/calls/payload");
  const { validatePromptPlaceholders } = await import("../src/lib/calls/prompt-validator");
  const { retellAgentVersion, retellFromNumber } = await import("../src/lib/calls/retell");
  const fs = await import("node:fs");

  console.log("\n════════ CALL PREFLIGHT (simulación, sin red) ════════\n");

  let order: import("../src/lib/db").OrderRow;
  const orderId = arg("order");
  if (orderId) {
    const db = await import("../src/lib/db");
    const real = db.getOrderById(parseInt(orderId, 10));
    if (!real) {
      console.log(`○ No existe el pedido ${orderId} en la DB local.\n`);
      process.exit(1);
    }
    order = real;
  } else {
    order = {
      customer_name: "Marta García",
      phone: "34600111222",
      product_summary: "1x Limpiador Ultrasónico",
      total_price: "29.99",
      currency: "EUR",
      address_line1: "Calle Almería 12",
      city: "Almería",
      postal_code: "04007",
      shopify_order_number: "1137",
      created_at: Math.floor(Date.now() / 1000) - 86400,
      raw_payload: null,
    } as unknown as import("../src/lib/db").OrderRow;
  }

  const payload = buildCallPayload(order, new Date());
  console.log("VARIABLES:");
  if (!payload.ok) {
    for (const m of payload.missing) console.log(`  ✗ ${m}`);
    console.log("\n○ CALL BLOCKED — no se puede llamar con estos datos.\n");
    process.exit(1);
  }
  for (const [k, v] of Object.entries(payload.variables!)) {
    const mostrado = k === "telefono" ? mask(v) : k === "nombre_cliente" ? v.split(" ")[0] : v;
    console.log(`  ✓ ${k}: ${mostrado}`);
  }

  console.log("\nPROMPT:");
  try {
    const prompt = fs.readFileSync("config/retell/casamable-agent-prompt.md", "utf8");
    const v = validatePromptPlaceholders(prompt);
    console.log(`  ${v.ok ? "✓" : "✗"} placeholders: ${v.ok ? "OK" : v.issues.map((i) => i.kind).join(", ")}`);
    if (!v.ok) process.exitCode = 1;
  } catch {
    console.log("  ✗ falta config/retell/casamable-agent-prompt.md");
    process.exitCode = 1;
  }

  console.log("\nAGENTE:");
  const version = retellAgentVersion();
  console.log(`  ${version ? "✓" : "✗"} agent version: ${version || "SIN FIJAR (RETELL_AGENT_VERSION) — las llamadas seguirían la última guardada"}`);
  if (!version) process.exitCode = 1;
  const from = retellFromNumber();
  console.log(`  ${from ? "✓" : "✗"} from number: ${from ? mask(from) : "SIN CONFIGURAR"}`);
  if (!from) process.exitCode = 1;

  if (process.exitCode === 1) {
    console.log("\n○ NOT SAFE TO DIAL — arregla lo de arriba antes de la llamada de prueba.\n");
    return;
  }
  console.log("\n● SAFE TO DIAL TEST NUMBER — siguiente paso: UNA llamada al número autorizado (allowlist), y escucharla entera.\n");
}

main().catch((err) => {
  console.error(`\n✗ Error: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
