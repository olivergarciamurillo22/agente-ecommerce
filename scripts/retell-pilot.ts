// ============================================================
// CLI del PILOTO de llamadas — DRY RUN por defecto.
//
//   npm run retell:pilot -- --order <id>              (dry run: no llama)
//   npm run retell:pilot -- --order <id> --execute    (llamada REAL: exige
//        I_UNDERSTAND_THIS_PLACES_A_REAL_CALL=YES en el entorno)
//
// Pasa por EXACTAMENTE las mismas puertas que el botón manual
// (manualDialOrder): elegibilidad, DNC, bloqueo global, franja, cap,
// variables, placeholders, pin de versión, allowlist/TEST_MODE, kill switch.
// El dry run imprime SOLO datos no sensibles: nunca nombre, dirección ni
// teléfono completo.
// ============================================================

import "./env-loader";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : null;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const orderId = parseInt(arg("order") ?? "", 10);
  if (!Number.isFinite(orderId)) {
    console.log("uso: npm run retell:pilot -- --order <id interno del pedido> [--execute]");
    process.exit(2);
  }
  const execute = flag("execute");
  const db = await import("../src/lib/db");
  const { buildCallPayload, validateRetellCallVariables } = await import("../src/lib/calls/payload");
  const { isConfirmationEligible } = await import("../src/lib/orders/eligibility");
  const { callAllowedByAllowlist, callsBlockedReason, callsPilotMode } = await import("../src/lib/calls/config");
  const { insideCallWindow } = await import("../src/lib/calls/schedule");
  const { defaultHolidayCalendar } = await import("../src/lib/calls/calendar");
  const { retellAgentVersion, agentVersionPinIssue, retellProvider } = await import("../src/lib/calls/retell");
  const { externalActionsLocked, maskPhone, testMode } = await import("../src/lib/safety");

  const order = db.getOrderById(orderId);
  if (!order) { console.log(`✗ pedido ${orderId} no existe`); process.exit(1); }
  const now = new Date();

  console.log(`\n════════ RETELL · piloto · pedido #${order.shopify_order_number} (id ${orderId}) · ${execute ? "EXECUTE" : "DRY RUN"} ════════\n`);
  const filas: Array<[string, string, boolean]> = [];
  const elig = isConfirmationEligible(order);
  filas.push(["elegibilidad", elig.eligible ? "elegible" : `NO: ${elig.detail ?? elig.reason}`, elig.eligible]);
  filas.push(["kill switch", externalActionsLocked() ? "EMERGENCY_STOP activo" : "abierto", !externalActionsLocked()]);
  const bloqueo = callsBlockedReason();
  filas.push(["bloqueo global", bloqueo ?? "ninguno", !bloqueo]);
  filas.push(["DNC", db.isDncPhone(order.phone) ? "EN LISTA NO LLAMAR" : "no", !db.isDncPhone(order.phone)]);
  filas.push(["franja horaria", insideCallWindow(now, defaultHolidayCalendar) ? "dentro" : "fuera (L–S 9–13 / 17–20, no festivos)", insideCallWindow(now, defaultHolidayCalendar)]);
  const permitido = callAllowedByAllowlist(order.phone);
  filas.push([`allowlist (${callsPilotMode() ? "piloto" : "producción"}${testMode() ? ", TEST_MODE" : ""})`, permitido ? `permitido (${maskPhone(order.phone)})` : `NO permitido (${maskPhone(order.phone)})`, permitido]);
  const version = retellAgentVersion();
  const pin = agentVersionPinIssue(version);
  filas.push(["versión del agente", pin ?? `pin = ${version}`, !pin]);
  filas.push(["proveedor configurado", retellProvider.isConfigured() ? "sí" : "NO (RETELL_API_KEY / RETELL_FROM_NUMBER)", retellProvider.isConfigured()]);
  const payload = buildCallPayload(order, now);
  filas.push(["variables", payload.ok ? `${Object.keys(payload.variables!).length} claves OK` : `BLOQUEADO: ${payload.missing.join(", ")}`, payload.ok]);
  if (payload.ok) {
    const issues = validateRetellCallVariables(payload.variables!);
    filas.push(["placeholders", issues.length === 0 ? "ninguno" : issues.join("; "), issues.length === 0]);
    console.log("  forma del payload (claves y longitudes, sin valores):");
    for (const [k, v] of Object.entries(payload.variables!)) console.log(`    · ${k.padEnd(18)} ${String(v).length} car.`);
    console.log();
  }
  for (const [k, v, ok] of filas) console.log(`  ${ok ? "●" : "○"} ${k.padEnd(24)} ${v}`);
  const todoOk = filas.every((f) => f[2]);
  console.log(`\n  ${todoOk ? "● PODRÍA LLAMAR" : "○ NO LLAMARÍA"}\n`);

  if (!execute) { console.log("Dry run: no se ha contactado con Retell. Para llamar de verdad: --execute con I_UNDERSTAND_THIS_PLACES_A_REAL_CALL=YES\n"); process.exit(todoOk ? 0 : 1); }
  if (process.env.I_UNDERSTAND_THIS_PLACES_A_REAL_CALL !== "YES") { console.log("✗ --execute requiere I_UNDERSTAND_THIS_PLACES_A_REAL_CALL=YES\n"); process.exit(1); }
  if (!todoOk) { console.log("✗ hay puertas cerradas: no se llama.\n"); process.exit(1); }
  const { manualDialOrder } = await import("../src/lib/calls/manual");
  const r = await manualDialOrder(orderId, now);
  console.log(r.ok ? `● llamada creada: ${r.providerCallId}\n` : `○ no se llamó: ${r.error}\n`);
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
