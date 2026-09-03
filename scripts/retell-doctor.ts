// ============================================================
// Doctor de Retell — SOLO LECTURA (salvo --unblock). Ninguna llamada se marca.
//
//   npm run retell:doctor                 (contrato local + estado + en vivo si hay key)
//   npm run retell:doctor -- --unblock    (levanta el bloqueo global tras REVISAR)
//   npm run retell:doctor -- --json       (además, una línea JSON al final)
//
// Tres bloques, tres verdades distintas (hardening 03-09):
//   CONTRATO  → lo que se puede probar SIN red: 11 variables, prompt
//               versionado, golden fixture de create-phone-call, pin numérico.
//   ESTADO    → lo que dice la base local: bloqueo global, kill switch,
//               allowlist, DNC, revisiones pendientes, eventos críticos.
//   EN VIVO   → lo que solo se sabe con RETELL_API_KEY: agente, versión
//               publicada, prompt real, tools, número, webhook. Sin key NO se
//               finge: queda UNVERIFIED_EXTERNAL.
//
// Códigos de salida: 0 = contrato OK y en vivo OK · 2 = contrato OK, en vivo
// sin verificar (falta la key aquí) · 1 = contrato o en vivo con fallos.
// Nunca imprime la API key.
// ============================================================

import "./env-loader";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.retellai.com";
const ARGS = new Set(process.argv.slice(2));
const UNBLOCK = ARGS.has("--unblock");
const JSON_OUT = ARGS.has("--json");

/** Los 12 resultados que el backend entiende (results.ts). */
const CALL_RESULTS_ESPERADOS = [
  "confirmado", "confirmado_con_correccion", "cancelado", "no_reconoce_pedido",
  "numero_equivocado", "no_volver_a_llamar", "incidencia_precio", "no_disponible",
  "rellamar", "no_contesta", "buzon_de_voz", "fallo_tecnico",
];

interface Verdict {
  contract: "OK" | "FAIL";
  /** ¿La API key sirve para la API (crear llamadas)? */
  apiAuth: "PASS" | "FAIL" | "UNKNOWN";
  /** ¿Ha validado alguna firma REAL de webhook? Solo la key con distintivo
   *  "webhook" firma los webhooks: que la API funcione NO lo demuestra. */
  realWebhookSignature: "PASS" | "UNVERIFIED_EXTERNAL";
  contractIssues: string[];
  live: "OK" | "FAIL" | "UNVERIFIED_EXTERNAL";
  liveIssues: string[];
  blockedReason: string | null;
  killSwitchActive: boolean;
  autoCalls: "OFF";
}

async function get(p: string, key: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: err instanceof Error ? err.message : "red" } };
  }
}

const ok = (b: boolean) => (b ? "●" : "○");

async function main(): Promise<void> {
  const { validatePromptPlaceholders, ALLOWED_PROMPT_VARIABLES } = await import("../src/lib/calls/prompt-validator");
  const { retellAgentVersion, agentVersionPinIssue, buildCreatePhoneCallBody, retellFromNumber } = await import("../src/lib/calls/retell");
  const { RETELL_CALL_VARIABLE_KEYS, validateRetellCallVariables } = await import("../src/lib/calls/payload");

  const verdict: Verdict = {
    contract: "OK",
    apiAuth: "UNKNOWN",
    realWebhookSignature: "UNVERIFIED_EXTERNAL",
    contractIssues: [],
    live: "UNVERIFIED_EXTERNAL",
    liveIssues: [],
    blockedReason: null,
    killSwitchActive: false,
    autoCalls: "OFF",
  };
  const contractFail = (m: string) => {
    verdict.contract = "FAIL";
    verdict.contractIssues.push(m);
  };

  console.log("\n════════ RETELL · doctor (solo lectura, sin llamadas) ════════\n");

  const key = (process.env.RETELL_API_KEY ?? "").trim();
  const agentId = (process.env.RETELL_AGENT_ID ?? "").trim();
  const fromNumber = retellFromNumber();
  const version = retellAgentVersion();
  const pinIssue = agentVersionPinIssue(version);

  // ------------------------------------------------------------------
  console.log("1. CONFIGURACIÓN");
  console.log(`   API key        : ${key ? "configurada (no se muestra)" : "FALTA (RETELL_API_KEY)"}`);
  console.log(`   Agent ID       : ${agentId || "FALTA (RETELL_AGENT_ID)"}`);
  console.log(`   From number    : ${fromNumber || "FALTA (RETELL_FROM_NUMBER)"}`);
  console.log(`   Versión fijada : ${pinIssue ? `○ ${pinIssue} — SIN pin numérico NO sale ninguna llamada` : `● ${version} (número de versión publicada)`}`);

  // ------------------------------------------------------------------
  console.log("\n2. CONTRATO LOCAL (sin red)");
  const nVars = RETELL_CALL_VARIABLE_KEYS.length;
  console.log(`   ${ok(nVars === 11)} variables dinámicas: ${nVars} (${[...RETELL_CALL_VARIABLE_KEYS].join(", ")})`);
  if (nVars !== 11) contractFail(`el contrato declara ${nVars} variables, no 11`);
  const mismas = [...ALLOWED_PROMPT_VARIABLES].sort().join(",") === [...RETELL_CALL_VARIABLE_KEYS].sort().join(",");
  console.log(`   ${ok(mismas)} el validador del prompt usa EXACTAMENTE esas variables`);
  if (!mismas) contractFail("prompt-validator y payload declaran variables distintas");

  let promptLocal = "";
  try {
    promptLocal = fs.readFileSync("config/retell/casamable-agent-prompt.md", "utf8");
    const v = validatePromptPlaceholders(promptLocal);
    console.log(`   ${ok(v.ok)} prompt versionado (config/retell/casamable-agent-prompt.md): ${v.ok ? "OK" : `${v.issues.length} problema(s)`} · variables usadas ${v.used.length}/${ALLOWED_PROMPT_VARIABLES.length}`);
    for (const i of v.issues) console.log(`     ✗ [${i.kind}] ${i.detail}`);
    if (!v.ok) contractFail("el prompt versionado no valida");
  } catch {
    console.log("   ○ no existe el fichero del prompt versionado");
    contractFail("falta config/retell/casamable-agent-prompt.md");
  }

  // Forma EXACTA del cuerpo de create-phone-call (contrato oficial). Se
  // comprueba con el builder real y un juego de variables sintético: así
  // funciona también dentro de la imagen Docker, que NO lleva tests/.
  // Si el golden fixture está disponible (repo), se contrasta además con él.
  const CAMPOS_OFICIALES = ["from_number", "to_number", "retell_llm_dynamic_variables", "metadata", "override_agent_id", "override_agent_version"];
  try {
    const varsSinteticas: Record<string, string> = {
      nombre_cliente: "Marta", producto: "1x Cortaúñas Eléctrico 3 en 1", unidades: "una unidad",
      importe_total: "veintinueve euros con noventa y cinco céntimos", direccion: "Calle Mayor 5", localidad: "Almería",
      codigo_postal: "04001", telefono: "+34600000000", fecha_pedido: "ayer", numero_pedido: "4242",
      current_datetime: "martes, 1 de septiembre de 2026, 10:30",
    };
    const prevAgent = process.env.RETELL_AGENT_ID;
    process.env.RETELL_AGENT_ID = agentId || "agent_DOCTOR_SELFTEST";
    const body = buildCreatePhoneCallBody(
      { toNumber: "+34600000000", fromNumber: fromNumber || "+34950835615", dynamicVariables: varsSinteticas, metadata: { attempt_id: "0", order_number: "4242" } },
      "7"
    );
    if (prevAgent === undefined) delete process.env.RETELL_AGENT_ID;
    else process.env.RETELL_AGENT_ID = prevAgent;
    const keysOk = Object.keys(body).sort().join(",") === [...CAMPOS_OFICIALES].sort().join(",");
    const versionNum = typeof body.override_agent_version === "number" && Number.isInteger(body.override_agent_version);
    const issues = validateRetellCallVariables(varsSinteticas);
    console.log(`   ${ok(keysOk && versionNum && issues.length === 0)} cuerpo de create-phone-call: campos ${keysOk ? "oficiales" : "DISTINTOS de los oficiales"} · override_agent_version ${versionNum ? "numérico" : "NO numérico"} · variables sintéticas ${issues.length === 0 ? "seguras" : issues.join("; ")}`);
    if (!keysOk) contractFail("el cuerpo de create-phone-call ya no tiene los campos oficiales");
    if (!versionNum) contractFail("override_agent_version no es un entero");
    if (issues.length) contractFail("las variables sintéticas no pasan el preflight (contrato roto)");
    const fixturePath = path.join("tests", "fixtures", "retell", "create-phone-call.expected.json");
    if (fs.existsSync(fixturePath)) {
      const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
      const fxOk = Object.keys(fx).sort().join(",") === [...CAMPOS_OFICIALES].sort().join(",")
        && Object.keys((fx.retell_llm_dynamic_variables as Record<string, string>) ?? {}).sort().join(",") === [...RETELL_CALL_VARIABLE_KEYS].sort().join(",");
      console.log(`   ${ok(fxOk)} golden fixture (tests/fixtures/retell): ${fxOk ? "coincide" : "NO coincide con el contrato"}`);
      if (!fxOk) contractFail("el golden fixture no coincide con el contrato");
    } else {
      console.log("   · golden fixture no disponible en esta imagen (se verifica en la suite del repo)");
    }
  } catch (err) {
    console.log(`   ○ no se pudo construir el cuerpo de create-phone-call: ${err instanceof Error ? err.message : "error"}`);
    contractFail("el builder del cuerpo falla");
  }
  console.log(`   ${ok(!pinIssue)} pin numérico de versión${pinIssue ? ` — ${pinIssue}` : ""}`);
  if (pinIssue) verdict.liveIssues.push(pinIssue);

  // ------------------------------------------------------------------
  console.log("\n3. ESTADO LOCAL (base de datos)");
  try {
    const cfg = await import("../src/lib/calls/config");
    const safety = await import("../src/lib/safety");
    const { systemDbHandle } = await import("../src/lib/db");
    const { logIntegrationEvent } = await import("../src/lib/system/repo");
    const db = systemDbHandle();
    verdict.killSwitchActive = safety.externalActionsLocked();
    verdict.blockedReason = cfg.callsBlockedReason();
    console.log(`   ${ok(!verdict.killSwitchActive)} EMERGENCY_STOP / safe mode: ${verdict.killSwitchActive ? "ACTIVO — no sale ninguna llamada, ni manual" : "levantado"}`);
    console.log(`   kill switch propio: ai_calls_enabled=${cfg.aiCallsEnabled() ? "1" : "0"} · shadow=${cfg.callsShadowMode() ? "1" : "0"} · piloto=${cfg.callsPilotMode() ? "1 (allowlist obligatoria)" : "0 (PRODUCCIÓN de llamadas)"} · allowlist=${cfg.callsAllowlist().length} número(s) · tope diario=${cfg.callsDailyCap()}`);
    const dnc = (db.prepare("SELECT COUNT(*) AS n FROM call_dnc").get() as { n: number }).n;
    const review = (db.prepare("SELECT COUNT(*) AS n FROM call_attempts WHERE state = 'manual_review'").get() as { n: number }).n;
    const inFlight = (db.prepare("SELECT COUNT(*) AS n FROM call_attempts WHERE state IN ('dialing','in_flight')").get() as { n: number }).n;
    console.log(`   DNC: ${dnc} teléfono(s) · intentos en revisión manual: ${review} · en curso: ${inFlight}`);
    const marcaFirma = (db.prepare("SELECT value FROM settings WHERE key = 'retell_webhook_signature_verified_at'").get() as { value: string } | undefined)?.value;
    if (marcaFirma) {
      verdict.realWebhookSignature = "PASS";
      console.log(`   ● firma REAL de webhook verificada el ${new Date(Number(marcaFirma) * 1000).toISOString()}`);
    } else {
      console.log("   ◐ ninguna firma REAL de webhook ha validado todavía (UNVERIFIED_EXTERNAL)");
    }
    if (verdict.blockedReason) {
      console.log(`   ○ LLAMADAS BLOQUEADAS por el sistema: ${verdict.blockedReason}`);
      if (UNBLOCK) {
        cfg.clearCallsBlocked();
        logIntegrationEvent("system", "call_unblocked_manual", "info", `bloqueo de llamadas levantado a mano (retell:doctor --unblock). Motivo previo: ${verdict.blockedReason}`.slice(0, 300));
        console.log("   ● bloqueo LEVANTADO (--unblock). Queda registrado en eventos. Si el motivo era deriva de versión: fija RETELL_AGENT_VERSION al número correcto ANTES de la siguiente llamada.");
        verdict.blockedReason = null;
      } else {
        console.log("   → revisar el motivo (eventos críticos abajo) y, solo entonces: npm run retell:doctor -- --unblock");
      }
    } else {
      console.log("   ● sin bloqueo global");
      if (UNBLOCK) console.log("   (--unblock: no había nada que levantar)");
    }
    const eventos = db
      .prepare(
        `SELECT event_type, severity, order_ref, message, created_at FROM integration_events
          WHERE event_type IN ('call_agent_version_drift','call_provider_blocked','call_provider_ambiguous','call_unblocked_manual')
            AND created_at >= unixepoch() - 7*86400
          ORDER BY id DESC LIMIT 8`
      )
      .all() as Array<{ event_type: string; severity: string; order_ref: string | null; message: string; created_at: number }>;
    console.log(`   eventos críticos de llamadas (7 días): ${eventos.length}`);
    for (const e of eventos) {
      console.log(`     · ${new Date(e.created_at * 1000).toISOString()} [${e.severity}] ${e.event_type}${e.order_ref ? ` #${e.order_ref}` : ""}: ${e.message.slice(0, 140)}`);
    }
  } catch (err) {
    console.log(`   ◐ sin acceso a la base local (${err instanceof Error ? err.message.slice(0, 80) : "error"}): este bloque solo tiene sentido donde corre el agente`);
  }

  // ------------------------------------------------------------------
  console.log("\n4. EN VIVO (Retell)");
  if (!key) {
    console.log("   ◐ UNVERIFIED_EXTERNAL — sin RETELL_API_KEY no se puede consultar el agente. Ejecuta este doctor donde esté la key (el NAS).");
  } else if (!agentId) {
    console.log("   ○ sin RETELL_AGENT_ID");
    verdict.live = "FAIL";
    verdict.liveIssues.push("falta RETELL_AGENT_ID");
  } else {
    // La API key SÍ sirve para la API (crear llamadas). Es una cosa DISTINTA
    // de que sirva para verificar webhooks: eso solo lo puede decir una firma
    // real (§6 del contrato: la key con distintivo "webhook").
    const agentActual = await get(`/get-agent/${agentId}`, key);
    verdict.apiAuth = agentActual.status === 401 || agentActual.status === 403 ? "FAIL" : agentActual.ok ? "PASS" : "UNKNOWN";

    // SE AUDITA LA VERSIÓN FIJADA, no el borrador. Sin pin numérico no hay
    // nada que auditar: mirar el draft y cantar PASS sería mentir, porque las
    // llamadas NO usan el draft.
    const agent = pinIssue ? agentActual : await get(`/get-agent/${agentId}?version=${encodeURIComponent(version)}`, key);
    if (!agent.ok) {
      console.log(`   ○ no se pudo leer el agente${pinIssue ? "" : ` en su versión ${version}`} (HTTP ${agent.status}): ${JSON.stringify(agent.json).slice(0, 150)}`);
      verdict.live = "FAIL";
      verdict.liveIssues.push(`get-agent HTTP ${agent.status}`);
    } else if (pinIssue) {
      console.log("   ○ sin pin numérico solo se puede mirar el BORRADOR, y las llamadas no usan el borrador: no se declara PASS.");
      verdict.live = "FAIL";
      verdict.liveIssues.push("sin RETELL_AGENT_VERSION numérica no hay versión que auditar");
    } else {
      verdict.live = "OK";
      const a = agent.json as Record<string, unknown>;
      console.log(`   Auditando la versión FIJADA: ${version}`);
      if (String(a.version ?? "") !== version) {
        console.log(`   ○ Retell devolvió la versión ${String(a.version ?? "?")} al pedir la ${version}`);
        verdict.live = "FAIL";
        verdict.liveIssues.push(`get-agent?version=${version} devolvió ${String(a.version ?? "?")}`);
      }
      console.log(`   ● ${String(a.agent_name ?? agentId)}`);
      console.log(`   Versión        : ${String(a.version ?? "?")} · publicada: ${a.is_published === true ? "sí" : "NO (borrador)"}`);
      if (a.is_published !== true) {
        verdict.live = "FAIL";
        verdict.liveIssues.push(`la versión ${version} NO está publicada (es un borrador y puede cambiar bajo los pies)`);
      }
      console.log(`   Voz            : ${String(a.voice_id ?? "?")} · idioma: ${String(a.language ?? "?")}`);
      const actual = agentActual.ok ? String((agentActual.json as Record<string, unknown>).version ?? "?") : "?";
      if (actual !== version) {
        console.log(`   · el borrador del dashboard va por la ${actual}; las llamadas usan la ${version} (esperado si hay cambios sin publicar)`);
      }
      // ¿Existe la versión fijada como PUBLICADA? (list agent versions)
      if (!pinIssue) {
        const versions = await get(`/get-agent-versions/${agentId}`, key);
        if (versions.ok && Array.isArray(versions.json)) {
          const fila = (versions.json as Array<Record<string, unknown>>).find((v) => String(v.version) === version);
          if (!fila) {
            console.log(`   ○ la versión ${version} NO aparece entre las versiones del agente: la llamada fallaría o derivaría`);
            verdict.live = "FAIL";
            verdict.liveIssues.push(`la versión fijada ${version} no existe en Retell`);
          } else {
            console.log(`   ${ok(fila.is_published === true)} versión ${version}: ${fila.is_published === true ? "PUBLICADA (inmutable)" : "NO publicada — publica esa versión o fija otra"}`);
            if (fila.is_published !== true) verdict.liveIssues.push(`la versión ${version} no está publicada`);
          }
        } else {
          console.log(`   ◐ no se pudieron listar las versiones (HTTP ${versions.status}): comprobar a mano en el dashboard que la ${version} está publicada`);
        }
      }

      const engine = (a.response_engine ?? {}) as Record<string, unknown>;
      const llmId = typeof engine.llm_id === "string" ? engine.llm_id : null;
      console.log("\n   PROMPT EN VIVO Y TOOLS");
      if (!llmId) {
        console.log(`   ◐ el response engine no es retell-llm (${String(engine.type ?? "?")}): no se puede auditar el prompt por API`);
      } else {
        const llm = await get(`/get-retell-llm/${llmId}`, key);
        if (!llm.ok) {
          console.log(`   ○ no se pudo leer el LLM (HTTP ${llm.status})`);
          verdict.liveIssues.push(`get-retell-llm HTTP ${llm.status}`);
        } else {
          const l = llm.json as Record<string, unknown>;
          const promptVivo = String(l.general_prompt ?? "");
          const v = validatePromptPlaceholders(promptVivo);
          console.log(`   ${ok(v.ok)} prompt EN VIVO: ${v.ok ? "válido" : `${v.issues.length} problema(s) — ESTO es lo que oye el cliente`}`);
          for (const i of v.issues) console.log(`     ✗ [${i.kind}] ${i.detail}`);
          if (!v.ok) {
            verdict.live = "FAIL";
            verdict.liveIssues.push("el prompt en vivo no valida");
          }
          if (promptLocal && promptVivo.trim() !== promptLocal.trim()) {
            console.log("   ◐ el prompt en vivo NO coincide con la fuente versionada del repo: sincronizar (pegar el del repo y publicar versión)");
            verdict.liveIssues.push("prompt en vivo ≠ prompt versionado");
          }
          const tools = (Array.isArray(l.general_tools) ? l.general_tools : []) as Array<Record<string, unknown>>;
          console.log(`   Tools (${tools.length}):`);
          for (const t of tools) console.log(`     · ${String(t.name ?? t.type ?? "?")} (${String(t.type ?? "?")})`);
          const nombres = new Set(tools.map((t) => String(t.name ?? "")));
          for (const esperada of ["extraer_datos_llamada", "finalizarllamada"]) {
            if (![...nombres].some((n) => n.replace(/[_\s]/g, "").toLowerCase() === esperada.replace(/[_\s]/g, ""))) {
              console.log(`     ◐ el prompt menciona "${esperada}" y el agente no tiene una tool con ese nombre`);
            }
          }
        }
      }

      // ── Análisis post-llamada de ESTA versión, contra el contrato REAL ──
      console.log("\n   ANÁLISIS POST-LLAMADA (de la versión fijada)");
      const pca = (Array.isArray(a.post_call_analysis_data) ? a.post_call_analysis_data : []) as Array<Record<string, unknown>>;
      if (pca.length === 0) {
        console.log("   ○ la versión no declara post_call_analysis_data: sin análisis no llega ningún resultado");
        verdict.live = "FAIL";
        verdict.liveIssues.push("sin post_call_analysis_data en la versión fijada");
      } else {
        const nombres = new Set(pca.map((c) => String(c.name ?? "")));
        console.log(`   campos: ${[...nombres].join(", ")}`);
        // Resultado: el selector con los 12 enums del backend (o su alias real).
        const campoResultado = pca.find((c) => c.name === "resultado_llamada" || c.name === "resultado");
        if (!campoResultado) {
          console.log("   ○ falta el campo del resultado (resultado_llamada / resultado)");
          verdict.live = "FAIL";
          verdict.liveIssues.push("la versión fijada no declara el campo del resultado");
        } else {
          const opciones = (Array.isArray(campoResultado.choices) ? campoResultado.choices : []).map(String);
          const faltan = CALL_RESULTS_ESPERADOS.filter((r) => !opciones.includes(r));
          const sobran = opciones.filter((o) => !CALL_RESULTS_ESPERADOS.includes(o));
          console.log(`   ${ok(faltan.length === 0 && sobran.length === 0)} ${String(campoResultado.name)}: ${opciones.length} opciones` +
            (faltan.length ? ` · FALTAN: ${faltan.join(", ")}` : "") + (sobran.length ? ` · SOBRAN: ${sobran.join(", ")}` : ""));
          if (faltan.length) verdict.liveIssues.push(`el selector de resultado no ofrece: ${faltan.join(", ")}`);
          if (sobran.length) verdict.liveIssues.push(`el selector de resultado ofrece valores que el backend no entiende: ${sobran.join(", ")}`);
        }
        // Campos PLANOS del contrato real (datos_corregidos NO se exige).
        for (const campo of ["direccion_corregida", "localidad_corregida", "codigo_postal_corregido", "telefono_alternativo", "pidio_no_llamar", "momento_rellamada"]) {
          if (!nombres.has(campo)) {
            console.log(`   ◐ no declara "${campo}": ese dato nunca llegará`);
            verdict.liveIssues.push(`falta el campo ${campo} en el análisis`);
          }
        }
        if (nombres.has("datos_corregidos")) {
          console.log("   · declara datos_corregidos (contenedor): el backend lo acepta, pero el contrato preferido es PLANO");
        }
      }

      console.log("\n   NÚMERO SALIENTE Y WEBHOOK");
      const numbers = await get(`/list-phone-numbers`, key);
      if (numbers.ok && Array.isArray(numbers.json)) {
        const propio = (numbers.json as Array<Record<string, unknown>>).find((n) => String(n.phone_number ?? "") === fromNumber);
        console.log(`   ${ok(Boolean(propio))} ${fromNumber || "(sin from number)"} ${propio ? "existe en la cuenta" : "NO está entre los números de la cuenta"}`);
        if (!propio) {
          verdict.live = "FAIL";
          verdict.liveIssues.push("RETELL_FROM_NUMBER no está en la cuenta");
        }
      } else {
        console.log(`   ◐ no se pudieron listar los números (HTTP ${numbers.status})`);
      }
      const webhook = typeof a.webhook_url === "string" ? a.webhook_url : "";
      console.log(`   Webhook agente : ${webhook || "(no configurado a nivel de agente: se usa el de la cuenta)"}`);
      if (webhook && !/\/api\/webhooks\/retell\/call-events$/.test(webhook)) {
        console.log("   ◐ el webhook del agente NO apunta a /api/webhooks/retell/call-events");
        verdict.liveIssues.push("webhook del agente no apunta al endpoint del agente");
      }
    }
  }

  // ------------------------------------------------------------------
  console.log("\n════════ VEREDICTO ════════");
  console.log(`  RETELL_CONTRACT : ${verdict.contract}${verdict.contractIssues.length ? ` — ${verdict.contractIssues.join(" · ")}` : ""}`);
  console.log(`  RETELL_LIVE     : ${verdict.live}${verdict.liveIssues.length ? ` — ${verdict.liveIssues.join(" · ")}` : ""}`);
  console.log(`  RETELL_API_AUTH : ${verdict.apiAuth}${verdict.apiAuth === "PASS" ? " (la key sirve para CREAR llamadas)" : ""}`);
  console.log(`  RETELL_REAL_WEBHOOK_SIGNATURE : ${verdict.realWebhookSignature}${verdict.realWebhookSignature === "UNVERIFIED_EXTERNAL" ? " (ninguna firma REAL ha validado: comprueba que RETELL_API_KEY es la que lleva el distintivo 'webhook')" : ""}`);
  console.log(`  CALLS_BLOCKED   : ${verdict.blockedReason ?? "none"}${verdict.killSwitchActive ? " · EMERGENCY_STOP activo" : ""}`);
  console.log("  AUTO_CALLS      : OFF (piloto manual: este doctor no lo enciende)");
  console.log("  Recuerda: esto NO sustituye la llamada de prueba real al móvil de Pedro (docs/retell/PRODUCTION-VALIDATION.md).\n");
  if (JSON_OUT) console.log(JSON.stringify(verdict));

  if (verdict.contract === "FAIL" || verdict.live === "FAIL") process.exit(1);
  if (verdict.live === "UNVERIFIED_EXTERNAL") process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ Error inesperado: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
