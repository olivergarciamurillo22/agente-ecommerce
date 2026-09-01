// ============================================================
// Doctor de Retell — SOLO LECTURA. Ninguna llamada se marca.
//
//   npm run retell:doctor
//
// Comprueba: API key, agente, política de versión (RETELL_AGENT_VERSION),
// número saliente, prompt del LLM EN VIVO contra el validador y contra la
// fuente versionada (config/retell/casamable-agent-prompt.md), tools
// disponibles y webhook. Nunca imprime la API key.
// ============================================================

import "./env-loader";
import fs from "node:fs";

const API = "https://api.retellai.com";

async function get(path: string, key: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { error: err instanceof Error ? err.message : "red" } };
  }
}

async function main(): Promise<void> {
  const { validatePromptPlaceholders, ALLOWED_PROMPT_VARIABLES } = await import("../src/lib/calls/prompt-validator");
  const { retellAgentVersion } = await import("../src/lib/calls/retell");

  console.log("\n════════ RETELL · doctor (solo lectura, sin llamadas) ════════\n");

  const key = (process.env.RETELL_API_KEY ?? "").trim();
  const agentId = (process.env.RETELL_AGENT_ID ?? "").trim();
  const fromNumber = (process.env.RETELL_FROM_NUMBER ?? "").trim();
  const version = retellAgentVersion();

  console.log("1. CONFIGURACIÓN");
  console.log(`   API key        : ${key ? "configurada (no se muestra)" : "FALTA (RETELL_API_KEY)"}`);
  console.log(`   Agent ID       : ${agentId || "FALTA (RETELL_AGENT_ID)"}`);
  console.log(`   From number    : ${fromNumber || "FALTA (RETELL_FROM_NUMBER)"}`);
  console.log(
    `   Versión fijada : ${version ? version : "◐ SIN FIJAR — las llamadas usan la última versión GUARDADA (incluye ediciones accidentales del dashboard). Fija RETELL_AGENT_VERSION."}`
  );

  // Prompt versionado local: SIEMPRE se valida, con o sin credenciales.
  console.log("\n2. PROMPT VERSIONADO (config/retell/casamable-agent-prompt.md)");
  let promptLocal = "";
  try {
    promptLocal = fs.readFileSync("config/retell/casamable-agent-prompt.md", "utf8");
    const v = validatePromptPlaceholders(promptLocal);
    console.log(`   ${v.ok ? "●" : "○"} validador: ${v.ok ? "OK" : `${v.issues.length} problema(s)`}`);
    for (const i of v.issues) console.log(`     ✗ [${i.kind}] ${i.detail}`);
    console.log(`   Variables usadas: ${v.used.length}/${ALLOWED_PROMPT_VARIABLES.length}`);
  } catch {
    console.log("   ○ no existe el fichero del prompt versionado");
  }

  if (!key) {
    console.log("\n◐ REAL CREDENTIAL VALIDATION PENDING — sin RETELL_API_KEY no se puede consultar el agente en vivo.");
    console.log("  Ejecuta este doctor donde esté la key (el NAS la tiene).\n");
    process.exit(1);
  }

  console.log("\n3. AGENTE EN VIVO");
  if (!agentId) {
    console.log("   ○ sin RETELL_AGENT_ID\n");
    process.exit(1);
  }
  const agent = await get(`/get-agent/${agentId}`, key);
  if (!agent.ok) {
    console.log(`   ○ no se pudo leer el agente (HTTP ${agent.status}): ${JSON.stringify(agent.json).slice(0, 150)}\n`);
    process.exit(1);
  }
  const a = agent.json as Record<string, unknown>;
  console.log(`   ● ${String(a.agent_name ?? agentId)}`);
  console.log(`   Versión actual : ${String(a.version ?? "?")} · publicada: ${a.is_published === true ? "sí" : "NO (draft)"}`);
  console.log(`   Voz            : ${String(a.voice_id ?? "?")} · idioma: ${String(a.language ?? "?")}`);
  if (version && String(a.version) !== version && version !== "latest_published") {
    console.log(`   ◐ la versión fijada (${version}) NO es la actual del dashboard (${String(a.version)}): las llamadas usarán la ${version} — comprueba que es la buena`);
  }

  // El prompt vive en el LLM del response engine.
  const engine = (a.response_engine ?? {}) as Record<string, unknown>;
  const llmId = typeof engine.llm_id === "string" ? engine.llm_id : null;
  console.log("\n4. PROMPT EN VIVO Y TOOLS");
  if (!llmId) {
    console.log(`   ◐ el response engine no es retell-llm (${String(engine.type ?? "?")}): no se puede auditar el prompt por API`);
  } else {
    const llm = await get(`/get-retell-llm/${llmId}`, key);
    if (!llm.ok) {
      console.log(`   ○ no se pudo leer el LLM (HTTP ${llm.status})`);
    } else {
      const l = llm.json as Record<string, unknown>;
      const promptVivo = String(l.general_prompt ?? "");
      const v = validatePromptPlaceholders(promptVivo);
      console.log(`   ${v.ok ? "●" : "○"} prompt EN VIVO: ${v.ok ? "válido" : `${v.issues.length} problema(s) — ESTO es lo que oye el cliente`}`);
      for (const i of v.issues) console.log(`     ✗ [${i.kind}] ${i.detail}`);
      if (promptLocal && promptVivo.trim() !== promptLocal.trim()) {
        console.log("   ◐ el prompt en vivo NO coincide con la fuente versionada del repo: sincronizar (pegar el del repo y publicar versión)");
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

  console.log("\n5. NÚMERO SALIENTE Y WEBHOOK");
  const numbers = await get(`/list-phone-numbers`, key);
  if (numbers.ok && Array.isArray(numbers.json)) {
    const propio = (numbers.json as Array<Record<string, unknown>>).find((n) => String(n.phone_number ?? "") === fromNumber);
    console.log(`   ${propio ? "●" : "○"} ${fromNumber || "(sin from number)"} ${propio ? "existe en la cuenta" : "NO está entre los números de la cuenta"}`);
  } else {
    console.log(`   ◐ no se pudieron listar los números (HTTP ${numbers.status})`);
  }
  console.log(`   Webhook agente : ${String((a.webhook_url as string) ?? "(no configurado a nivel de agente)")}`);

  console.log("\n● Doctor completado. Recuerda: esto NO sustituye la llamada de prueba al número autorizado.\n");
}

main().catch((err) => {
  console.error(`\n✗ Error inesperado: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
