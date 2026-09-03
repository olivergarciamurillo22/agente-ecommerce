// ============================================================
// RECONCILIAR UNA LLAMADA YA OCURRIDA — DRY RUN por defecto.
//
//   npm run retell:reconcile-call -- --call-id call_xxx
//   npm run retell:reconcile-call -- --call-id call_xxx --apply
//
// Para qué: cuando un webhook se perdió (firma rechazada, contenedor caído,
// reintentos agotados) la llamada ocurrió de verdad pero el pedido no se
// enteró. Esto consulta el estado REAL en Retell y lo concilia.
//
// GARANTÍAS:
//   · Solo LEE de Retell: GET /v2/get-call/{call_id}. Ni una función de
//     escritura importada. JAMÁS crea una segunda llamada.
//   · Sin --apply no toca nada: enseña qué haría y por qué.
//   · La forma del análisis se imprime REDACTADA (claves y tipos, y los
//     valores solo de los campos que no son datos personales).
//
// Salidas: 0 = ok · 1 = error o nada que conciliar · 2 = uso incorrecto.
// ============================================================

import "./env-loader";

const API = "https://api.retellai.com";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}
const flag = (n: string) => process.argv.includes(`--${n}`);

/** Campos con datos personales: se enseña el tipo y la longitud, no el valor. */
const PII = new Set(["direccion_corregida", "localidad_corregida", "telefono_alternativo", "transcript", "recording_url", "from_number", "to_number"]);

function redactar(v: unknown, clave = ""): unknown {
  if (PII.has(clave)) {
    if (typeof v === "string") return v.length === 0 ? "" : `<${typeof v}:${v.length} car.>`;
    return v === null || v === undefined ? v : `<${typeof v}>`;
  }
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => redactar(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactar(val, k);
    return out;
  }
  return v;
}

async function main(): Promise<void> {
  const callId = arg("call-id");
  if (!callId) {
    console.log("uso: npm run retell:reconcile-call -- --call-id <call_id> [--apply]");
    process.exit(2);
  }
  const aplicar = flag("apply");
  const key = (process.env.RETELL_API_KEY ?? "").trim();

  console.log(`\n════════ RETELL · reconciliar ${callId} · ${aplicar ? "APLICAR" : "DRY RUN"} ════════\n`);

  const db = await import("../src/lib/db");

  // 1 · ¿Conocemos ya esta llamada?
  const attempt = db
    .systemDbHandle()
    .prepare("SELECT * FROM call_attempts WHERE provider_call_id = ?")
    .get(callId) as { id: number; order_id: number; state: string; result: string | null; agent_version: string | null } | undefined;

  if (!attempt) {
    console.log("  ○ ningún intento local tiene ese provider_call_id.");
    console.log("    O la llamada es de otra instalación, o el intento se creó sin guardar el id.");
  } else {
    const order = db.getOrderById(attempt.order_id);
    console.log("  ● intento local encontrado");
    console.log(`      attempt_id : ${attempt.id}`);
    console.log(`      estado     : ${attempt.state}${attempt.result ? ` · resultado: ${attempt.result}` : ""}`);
    console.log(`      versión ag.: ${attempt.agent_version ?? "(no registrada)"}`);
    console.log(`      pedido     : #${order?.shopify_order_number ?? "?"} (id ${attempt.order_id}) · estado ${order?.status ?? "?"}`);
  }

  // 2 · Estado REAL en Retell (solo lectura).
  if (!key) {
    console.log("\n  ◐ sin RETELL_API_KEY no se puede consultar a Retell. Ejecuta esto donde esté la clave (el NAS).\n");
    process.exit(1);
  }
  console.log("\n  Consultando GET /v2/get-call…");
  let datos: Record<string, unknown>;
  try {
    const res = await fetch(`${API}/v2/get-call/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.log(`  ○ Retell respondió HTTP ${res.status}. Nada que conciliar.\n`);
      process.exit(1);
    }
    datos = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.log(`  ○ no se pudo consultar: ${err instanceof Error ? err.message : "error de red"}\n`);
    process.exit(1);
  }

  const analisis = ((datos.call_analysis as Record<string, unknown> | undefined)?.custom_analysis_data ??
    datos.call_analysis ??
    null) as Record<string, unknown> | null;

  console.log("\n  FORMA DE LA LLAMADA (redactada):");
  console.log(
    JSON.stringify(
      redactar({
        call_id: datos.call_id,
        call_status: datos.call_status,
        disconnection_reason: datos.disconnection_reason,
        agent_id: datos.agent_id,
        agent_version: datos.agent_version,
        start_timestamp: datos.start_timestamp,
        end_timestamp: datos.end_timestamp,
        metadata: datos.metadata,
        call_analysis: analisis,
      }),
      null,
      2
    )
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")
  );

  // 3 · Qué se aplicaría.
  const { normalizeRetellAnalysis } = await import("../src/lib/calls/analysis");
  const norm = normalizeRetellAnalysis(analisis);
  const { parseCallResult } = await import("../src/lib/calls/results");
  const resultado = parseCallResult(norm.resultado);
  console.log("\n  INTERPRETACIÓN:");
  console.log(`    resultado          : ${resultado ?? `(no reconocido: ${JSON.stringify(norm.resultado)})`}`);
  console.log(`    pidió no llamar    : ${norm.pidioNoLlamar ? "SÍ → DNC" : "no"}`);
  console.log(`    correcciones       : dirección=${norm.direccionCorregida ? "sí" : "no"} · localidad=${norm.localidadCorregida ? "sí" : "no"} · CP=${norm.codigoPostalCorregido ?? "no"} · teléfono=${norm.telefonoAlternativo ? "sí" : "no"}`);
  console.log(`    momento rellamada  : ${norm.momentoRellamada ? String(norm.momentoRellamada) : "—"}`);

  if (!attempt) {
    console.log("\n  Sin intento local no hay nada que conciliar: no se inventa un pedido.\n");
    process.exit(1);
  }
  if (!resultado) {
    console.log("\n  El resultado no es uno de los 12 del contrato: esto va a revisión humana, no se aplica solo.\n");
    process.exit(1);
  }

  if (!aplicar) {
    console.log("\n  DRY RUN: no se ha tocado nada. Para aplicarlo de verdad:");
    console.log(`    npm run retell:reconcile-call -- --call-id ${callId} --apply\n`);
    process.exit(0);
  }

  // 4 · Aplicar, por el MISMO camino que un webhook (nada paralelo).
  const calls = await import("../src/lib/calls/scheduler");
  const { defaultHolidayCalendar } = await import("../src/lib/calls/calendar");
  const fila = db.getCallAttempt(attempt.id);
  if (!fila) {
    console.log("\n  ○ el intento ya no existe.\n");
    process.exit(1);
  }
  const eventAt = typeof datos.end_timestamp === "number" ? Math.floor(datos.end_timestamp / 1000) : null;
  calls.applyCallAnalysis(
    fila,
    {
      type: "call_analyzed",
      providerCallId: callId,
      agentVersion: datos.agent_version !== undefined && datos.agent_version !== null ? String(datos.agent_version) : null,
      eventAt,
      providerStatus: typeof datos.call_status === "string" ? datos.call_status : null,
      disconnectionReason: typeof datos.disconnection_reason === "string" ? datos.disconnection_reason : null,
      durationMs: null,
      analysis: analisis,
    },
    new Date(),
    defaultHolidayCalendar
  );
  const despues = db.getCallAttempt(attempt.id);
  const pedido = db.getOrderById(attempt.order_id);
  console.log("\n  ● APLICADO");
  console.log(`      intento : ${despues?.state} · resultado ${despues?.result ?? "—"}`);
  console.log(`      pedido  : #${pedido?.shopify_order_number} · estado ${pedido?.status} · cierre ${pedido?.closure_status}`);
  console.log();
  process.exit(0);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
