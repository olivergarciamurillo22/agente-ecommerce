// ============================================================
// Doctor de plantillas de WhatsApp — SOLO LECTURA contra Meta.
//
//   npm run whatsapp:templates:doctor
//   npm run whatsapp:templates:doctor -- --check-only   (no cachea nada)
//
// Compara cada mapping lógico→WABA (config/whatsapp-templates.json →
// provider_mappings) contra las plantillas REALES de la WABA: nombre,
// idioma, estado APPROVED, aridad del cuerpo ({{n}}) y botones. Si todo
// cuadra, cachea la verificación en settings — es lo que desbloquea el
// envío (incidente 132001: sin verificación, la confirmación inicial no
// sale y el panel dice por qué).
//
// Credenciales: META_WHATSAPP_ACCESS_TOKEN + META_WHATSAPP_BUSINESS_ACCOUNT_ID.
// Si faltan, prueba con META_ADS_ACCESS_TOKEN (mismo Business, si tiene
// whatsapp_business_management y la WABA es visible). Nunca imprime tokens.
// ============================================================

import "./env-loader";

interface MetaTemplate {
  name: string;
  status: string;
  language: string;
  category?: string;
  components?: Array<{
    type: string;
    text?: string;
    buttons?: Array<{ type: string; text?: string }>;
  }>;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

/** Nº de variables {{n}} del cuerpo: el índice MÁXIMO, no el recuento. */
export function bodyParamCount(bodyText: string): number {
  let max = 0;
  for (const m of bodyText.matchAll(/\{\{(\d+)\}\}/g)) {
    max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

async function fetchTemplates(token: string, wabaId: string, version: string): Promise<MetaTemplate[] | { error: string }> {
  const out: MetaTemplate[] = [];
  let url = `https://graph.facebook.com/${version}/${wabaId}/message_templates?fields=name,status,language,category,components&limit=100`;
  for (let page = 0; page < 5 && url; page++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      return { error: `sin respuesta de Meta: ${err instanceof Error ? err.message : "red"}` };
    }
    const j = (await res.json().catch(() => null)) as {
      data?: MetaTemplate[];
      paging?: { next?: string };
      error?: { message?: string; code?: number };
    } | null;
    if (!res.ok || !j || j.error) {
      return { error: (j?.error?.message ?? `HTTP ${res.status}`).slice(0, 200) };
    }
    out.push(...(j.data ?? []));
    url = j.paging?.next ?? "";
  }
  return out;
}

async function main(): Promise<void> {
  // OJO: nada de lo que se importe aquí puede tocar la DB en el camino de
  // --check-only. loadProviderMappings/getTemplateSpec leen el JSON de config;
  // storeVerifiedTemplate SÍ escribe, y por eso vive tras el gate de abajo.
  // getTemplateReadiness se retiró a propósito (ver el bloque sin credenciales).
  const { loadProviderMappings, resolveMappingSpec, storeVerifiedTemplate } = await import(
    "../src/lib/whatsapp/templates"
  );

  console.log("\n════════ WHATSAPP · doctor de plantillas (solo lectura) ════════\n");

  const wabaId = (process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ?? "").trim();
  const token = (process.env.META_WHATSAPP_ACCESS_TOKEN ?? "").trim() || (process.env.META_ADS_ACCESS_TOKEN ?? "").trim();
  const version = (process.env.META_WHATSAPP_API_VERSION ?? "v23.0").trim();

  const mappings = loadProviderMappings();
  console.log(`Mappings declarados: ${mappings.length}`);
  for (const m of mappings) {
    const off = m.enabled === false ? " ⊘ DESHABILITADO" : "";
    console.log(`  · ${m.logicalKey} → "${m.providerTemplate}" (${m.language}, ${m.params.length} variable(s): ${m.params.join(", ")})${off}`);
  }

  if (!wabaId || !token) {
    console.log("\n◐ REAL CREDENTIAL VALIDATION PENDING");
    console.log("  Faltan credenciales para hablar con la WABA:");
    if (!wabaId) console.log("  - META_WHATSAPP_BUSINESS_ACCOUNT_ID (el id de la WABA, no es secreto)");
    if (!token) console.log("  - META_WHATSAPP_ACCESS_TOKEN (o META_ADS_ACCESS_TOKEN con whatsapp_business_management)");
    console.log("  Ejecuta este doctor DONDE estén (el NAS las tiene): el resultado se cachea y desbloquea el envío.\n");
    // NO se consulta la caché de settings a propósito. Leerla abriría la base
    // de datos (getSetting → ctx → build) y build() MIGRA el esquema: un
    // preflight con --check-only contra el volumen de producción habría subido
    // 15→17 con el contenedor viejo todavía en marcha. Saber si había caché
    // previa no vale ese riesgo — sin credenciales no hay nada que verificar.
    console.log("  (no se consulta la caché local: --check-only nunca abre la base de datos)\n");
    process.exit(1);
  }

  console.log(`\nWABA: ${wabaId} · API ${version}`);
  const templates = await fetchTemplates(token, wabaId, version);
  if ("error" in templates) {
    console.log(`\n○ No se pudieron listar las plantillas: ${templates.error}\n`);
    process.exit(1);
  }
  console.log(`Plantillas en la WABA: ${templates.length}`);
  for (const t of templates) {
    console.log(`  · ${t.name} (${t.language}) — ${t.status}${t.category ? ` · ${t.category}` : ""}`);
  }

  let fallos = 0;
  let deshabilitados = 0;
  let activosOk = 0;
  console.log("\n──── Verificación de mappings ────");
  for (const m of mappings) {
    // El catálogo tiene specs por clave lógica Y por nombre real de la WABA:
    // resolver por ambas evita el falso negativo de retraso_pedido (2 botones
    // reales que el flujo de retraso SÍ atiende).
    const spec = resolveMappingSpec(m);
    const real = templates.find((t) => t.name === m.providerTemplate && t.language.startsWith(m.language));
    const etiqueta = `${m.logicalKey} → "${m.providerTemplate}"`;
    // Deshabilitado: se INSPECCIONA contra Meta (informativo), pero no se
    // cachea, no cuenta como fallo del preflight y jamás sale como PASS.
    if (m.enabled === false) {
      deshabilitados++;
      console.log(`⊘ ${etiqueta}: DISABLED / INTENTIONALLY BLOCKED`);
      if (real) {
        const b = real.components?.find((c) => c.type === "BUTTONS")?.buttons ?? [];
        console.log(`    en la WABA: ${real.language} · ${real.status} · ${bodyParamCount(real.components?.find((c) => c.type === "BODY")?.text ?? "")} variable(s) · ${b.length} botón(es)`);
      } else {
        console.log(`    no existe en la WABA con idioma ${m.language}`);
      }
      if (m.note) console.log(`    motivo: ${m.note.slice(0, 200)}`);
      continue;
    }
    if (!real) {
      console.log(`○ ${etiqueta}: NO EXISTE en la WABA con idioma ${m.language} — este nombre daría el 132001`);
      fallos++;
      continue;
    }
    const body = real.components?.find((c) => c.type === "BODY")?.text ?? "";
    const buttons = real.components?.find((c) => c.type === "BUTTONS")?.buttons ?? [];
    const paramCount = bodyParamCount(body);
    const problemas: string[] = [];
    if (real.status !== "APPROVED") problemas.push(`estado ${real.status} (no APPROVED)`);
    if (paramCount !== m.params.length) problemas.push(`aridad: la WABA tiene ${paramCount} variable(s) y el mapping envía ${m.params.length}`);
    const localButtons = spec?.buttons.length ?? 0;
    if (buttons.length > 0 && buttons.length !== localButtons) {
      problemas.push(`botones: la WABA tiene ${buttons.length} y el flujo local espera ${localButtons}`);
    }
    console.log(`${problemas.length === 0 ? "●" : "◐"} ${etiqueta}`);
    console.log(`    idioma ${real.language} · ${real.status} · ${paramCount} variable(s) · ${buttons.length} botón(es) [${buttons.map((b) => b.type).join(", ") || "—"}]`);
    if (body) console.log(`    cuerpo: ${body.replace(/\n/g, " ").slice(0, 160)}`);
    if (problemas.length > 0) {
      for (const p of problemas) console.log(`    ✗ ${p}`);
      fallos++;
      continue;
    }
    if (!hasFlag("check-only")) {
      storeVerifiedTemplate(m.logicalKey, {
        provider: m.providerTemplate,
        language: m.language,
        status: real.status,
        paramCount,
        buttonCount: buttons.length,
        buttonTypes: buttons.map((b) => b.type),
        category: real.category ?? null,
        verifiedAt: Math.floor(Date.now() / 1000),
      });
      console.log(`    ✓ verificación cacheada: el envío de "${m.logicalKey}" queda DESBLOQUEADO`);
    }
    activosOk++;
  }

  // El veredicto depende SOLO de los mappings activos: un mapping apagado a
  // propósito no puede tumbar el preflight, pero tampoco se cuenta como listo.
  console.log(`\n──── Resumen ────`);
  console.log(`  ACTIVE PASS : ${activosOk}`);
  console.log(`  DISABLED    : ${deshabilitados}`);
  console.log(`  FAIL        : ${fallos}`);
  console.log(
    fallos === 0
      ? `\n● Todos los mappings ACTIVOS verificados${deshabilitados > 0 ? ` (${deshabilitados} deshabilitado(s) a propósito, no se envían)` : ""}.\n`
      : `\n◐ ${fallos} mapping(s) con problemas: el envío de esos mensajes sigue BLOQUEADO (correcto).\n`
  );
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n✗ Error inesperado: ${err instanceof Error ? err.message : "desconocido"}\n`);
  process.exit(1);
});
