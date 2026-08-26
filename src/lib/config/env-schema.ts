// ============================================================
// ESQUEMA DE CONFIGURACIÓN — la fuente ÚNICA de verdad sobre variables de
// entorno. Lo consumen `npm run env:doctor` y `npm run local:doctor`.
//
// POR QUÉ EXISTE: .env.example, los docs y el código tenían cada uno su
// lista, y ya nos mordió dos veces (variables vivas sin documentar,
// variables documentadas que nadie leía). Aquí se declara cada variable UNA
// vez: qué es, para qué PERFIL hace falta, si es secreta, cómo se valida y
// qué pasa si falta. El doctor audita el entorno REAL contra esto.
//
// REGLAS:
//  - NUNCA valores secretos aquí (ni de ejemplo con pinta de reales).
//  - Un secreto jamás se imprime: solo "configurado" / "falta".
//  - Lo que se gestiona desde SQLite `settings` se declara con
//    `managedBySettings`: el doctor te manda al panel, no al .env.
// ============================================================

export type Profile =
  | "local-safe"
  | "shopify-readonly"
  | "whatsapp-baileys"
  | "whatsapp-cloud-pilot"
  | "retell-pilot"
  | "nas-production";

export const PROFILES: Profile[] = [
  "local-safe",
  "shopify-readonly",
  "whatsapp-baileys",
  "whatsapp-cloud-pilot",
  "retell-pilot",
  "nas-production",
];

export type EnvCategory =
  | "CORE"
  | "SAFETY"
  | "SHOPIFY"
  | "WHATSAPP"
  | "META_CLOUD"
  | "RETELL_CALLS"
  | "DROPEA"
  | "DROPI"
  | "TRACKING"
  | "SYSTEM"
  | "LEGACY";

export interface EnvVarSpec {
  name: string;
  category: EnvCategory;
  secret: boolean;
  description: string;
  /** Perfiles en los que DEBE estar presente (con valor no vacío). */
  requiredFor: Profile[];
  /** Valor EXACTO que exige cada perfil (se compara el valor EFECTIVO:
   *  lo puesto en el entorno, o el default si no hay nada). */
  mustEqual?: Partial<Record<Profile, string>>;
  /** Valor efectivo cuando la variable no está puesta. */
  defaultValue?: string;
  /** Devuelve un mensaje de error si el VALOR (no vacío) es inválido. */
  validate?: (value: string) => string | null;
  /** LEGACY_DO_NOT_CONFIGURE = existe por compatibilidad, NO rellenar. */
  status?: "ACTIVE" | "FUTURE" | "LEGACY_DO_NOT_CONFIGURE";
  /** Clave de `settings` (SQLite) que tiene PRIORIDAD sobre el env. */
  managedBySettings?: string;
}

// --- Validadores ---

const bool01 = (v: string) => (v === "0" || v === "1" ? null : `debe ser 0 o 1 (vale "${v}")`);
const enumOf = (...ok: string[]) => (v: string) =>
  ok.includes(v) ? null : `debe ser uno de: ${ok.join(" | ")} (vale "${v}")`;
const intPos = (v: string) =>
  Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? null : `debe ser un entero positivo (vale "${v}")`;
const phoneE164 = (v: string) =>
  /^\+\d{9,15}$/.test(v.trim()) ? null : `debe ser E.164 con "+" (p.ej. +34950835615)`;
const phoneListDigits = (v: string) =>
  v.split(",").every((t) => /^[\d\s+]+$/.test(t.trim()) && t.replace(/\D/g, "").length >= 9)
    ? null
    : "lista separada por comas de teléfonos internacionales";
const graphVersion = (v: string) => (/^v\d+\.\d+$/.test(v) ? null : `formato vNN.N (p.ej. v23.0), vale "${v}"`);
const domainShopify = (v: string) =>
  /\.myshopify\.com$/.test(v.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    ? null
    : "debe ser el dominio *.myshopify.com de la tienda";

// Los cuatro perfiles que corren en el Mac (todos menos nas-production).
const LOCAL_PROFILES: Profile[] = ["local-safe", "shopify-readonly", "whatsapp-baileys", "whatsapp-cloud-pilot", "retell-pilot"];

export const ENV_SCHEMA: EnvVarSpec[] = [
  // ── CORE ──
  {
    name: "APP_MODE",
    category: "CORE",
    secret: false,
    description: "production habilita envíos reales (junto con el resto de gates). En el Mac solo tiene sentido para pilotos conscientes.",
    requiredFor: [],
    defaultValue: "",
    validate: (v) => (v === "" || v === "production" ? null : `solo se reconoce "production" o vacío (vale "${v}")`),
  },
  {
    name: "DATA_DIR",
    category: "CORE",
    secret: false,
    description: "Dónde vive la SQLite. En el Mac, el default ./data es correcto y NUNCA debe apuntar a rutas del NAS.",
    requiredFor: [],
    defaultValue: "data",
  },
  { name: "BACKUP_DIR", category: "CORE", secret: false, description: "Directorio de backups locales.", requiredFor: [], defaultValue: "backups" },
  { name: "PORT", category: "CORE", secret: false, description: "Puerto del panel web.", requiredFor: [], defaultValue: "3000", validate: intPos },
  {
    name: "TZ",
    category: "CORE",
    secret: false,
    description: "Huso del proceso. Europe/Madrid en producción; en el Mac el chequeo de huso del Control Center avisa si difiere.",
    requiredFor: [],
    defaultValue: "",
  },

  // ── SAFETY (los interruptores que impiden acciones reales) ──
  {
    name: "TEST_MODE",
    category: "SAFETY",
    secret: false,
    description: "1 = solo se escribe a la allowlist. OJO: SIN DEFINIR también cuenta como activo (safety.ts usa !== \"0\", fail-closed) — solo un 0 explícito lo apaga.",
    requiredFor: [],
    mustEqual: { "local-safe": "1", "whatsapp-cloud-pilot": "1", "retell-pilot": "1" },
    defaultValue: "1",
    validate: bool01,
  },
  {
    name: "TEST_PHONE_ALLOWLIST",
    category: "SAFETY",
    secret: false,
    description: "Teléfonos a los que SÍ se escribe en TEST_MODE. Vacía = NADIE recibe nada (fail-closed).",
    requiredFor: ["whatsapp-cloud-pilot"],
    validate: phoneListDigits,
  },
  {
    name: "WHATSAPP_SEND_ENABLED",
    category: "SAFETY",
    secret: false,
    description: "1 = los envíos salen de verdad (exige además APP_MODE=production). En local-safe debe estar apagado.",
    requiredFor: [],
    mustEqual: { "local-safe": "0", "whatsapp-cloud-pilot": "1" },
    defaultValue: "0",
    validate: bool01,
  },
  {
    name: "SHOPIFY_WRITE_ENABLED",
    category: "SAFETY",
    secret: false,
    description: "1 = se permite escribir el tag WA_CONFIRMED en Shopify. En el Mac, siempre 0.",
    requiredFor: [],
    mustEqual: { "local-safe": "0", "shopify-readonly": "0" },
    defaultValue: "0",
    validate: bool01,
  },
  {
    name: "EMERGENCY_STOP",
    category: "SAFETY",
    secret: false,
    description: "Freno de emergencia global. OJO: SIN DEFINIR está ACTIVO (fail-closed, safety.ts usa !== \"0\") — hay que poner 0 explícito para operar.",
    requiredFor: [],
    defaultValue: "1",
    validate: bool01,
  },

  // ── SHOPIFY ──
  {
    name: "SHOPIFY_STORE_DOMAIN",
    category: "SHOPIFY",
    secret: false,
    description: "Dominio *.myshopify.com de la tienda.",
    requiredFor: ["shopify-readonly", "nas-production"],
    validate: domainShopify,
  },
  {
    name: "SHOPIFY_CLIENT_ID",
    category: "SHOPIFY",
    secret: false,
    description: "Client ID de la app (client_credentials). Alternativa: SHOPIFY_ADMIN_ACCESS_TOKEN estático.",
    requiredFor: [], // "uno de los dos" se comprueba aparte (oneOfChecks)
  },
  {
    name: "SHOPIFY_CLIENT_SECRET",
    category: "SHOPIFY",
    secret: true,
    description: "Client secret de la app. TAMBIÉN firma los webhooks creados por la app (BUG2).",
    requiredFor: [],
  },
  {
    name: "SHOPIFY_ADMIN_ACCESS_TOKEN",
    category: "SHOPIFY",
    secret: true,
    description: "Token Admin API estático (shpat_…). Alternativa al par client_id/secret.",
    requiredFor: [],
  },
  {
    name: "SHOPIFY_WEBHOOK_SECRET",
    category: "SHOPIFY",
    secret: true,
    description: "Secreto de los webhooks creados desde el admin. Los de la app firman con el CLIENT_SECRET; el código acepta ambos.",
    requiredFor: [],
  },
  {
    name: "SHOPIFY_API_VERSION",
    category: "SHOPIFY",
    secret: false,
    description: "Versión de la Admin API.",
    requiredFor: [],
    defaultValue: "2026-07",
  },

  // ── WHATSAPP (proveedor) ──
  {
    name: "WHATSAPP_PROVIDER",
    category: "WHATSAPP",
    secret: false,
    description: "Quién entrega: baileys (WhatsApp Web + QR) o cloud_api (API oficial de Meta). Uno solo.",
    requiredFor: [],
    mustEqual: { "whatsapp-baileys": "baileys", "whatsapp-cloud-pilot": "cloud_api" },
    defaultValue: "baileys",
    validate: enumOf("baileys", "cloud_api"),
  },
  {
    name: "PERSIST_DIR",
    category: "WHATSAPP",
    secret: false,
    description: "Solo Docker/NAS: dónde montar auth/ y data/. En el Mac no se usa.",
    requiredFor: [],
  },

  // ── META CLOUD ──
  {
    name: "META_WHATSAPP_API_ENABLED",
    category: "META_CLOUD",
    secret: false,
    description: "Interruptor maestro de la Cloud API. 0 = ni una llamada de red a Meta (fail-closed).",
    requiredFor: [],
    mustEqual: { "local-safe": "0", "whatsapp-cloud-pilot": "1" },
    defaultValue: "0",
    validate: bool01,
  },
  { name: "META_WHATSAPP_PHONE_NUMBER_ID", category: "META_CLOUD", secret: false, description: "Phone Number ID (en el piloto, el del número de PRUEBAS).", requiredFor: ["whatsapp-cloud-pilot"], validate: intPos },
  { name: "META_WHATSAPP_BUSINESS_ACCOUNT_ID", category: "META_CLOUD", secret: false, description: "WABA ID.", requiredFor: ["whatsapp-cloud-pilot"], validate: intPos },
  {
    name: "META_WHATSAPP_ACCESS_TOKEN",
    category: "META_CLOUD",
    secret: true,
    description: "Token de acceso. OJO: el de la pantalla de pruebas caduca en 24 h — para algo serio hace falta el permanente (usuario del sistema). El doctor solo comprueba presencia, no cuál de los dos es.",
    requiredFor: ["whatsapp-cloud-pilot"],
  },
  { name: "META_WHATSAPP_APP_SECRET", category: "META_CLOUD", secret: true, description: "App Secret: firma los webhooks entrantes (X-Hub-Signature-256).", requiredFor: ["whatsapp-cloud-pilot"] },
  { name: "META_WHATSAPP_VERIFY_TOKEN", category: "META_CLOUD", secret: true, description: "Token de verificación del webhook. Lo inventamos NOSOTROS (cadena larga aleatoria), no es de Meta.", requiredFor: ["whatsapp-cloud-pilot"] },
  { name: "META_WHATSAPP_API_VERSION", category: "META_CLOUD", secret: false, description: "Versión de la Graph API.", requiredFor: [], defaultValue: "v23.0", validate: graphVersion },
  // Las PLANTILLAS no se configuran por env: config/whatsapp-templates.json
  // es el catálogo (el doctor lo comprueba como fichero, no como variable).

  // ── RETELL / LLAMADAS ──
  { name: "RETELL_API_KEY", category: "RETELL_CALLS", secret: true, description: "API key de Retell.", requiredFor: ["retell-pilot"] },
  { name: "RETELL_AGENT_ID", category: "RETELL_CALLS", secret: false, description: "Agent ID del agente de confirmación.", requiredFor: ["retell-pilot"] },
  { name: "RETELL_FROM_NUMBER", category: "RETELL_CALLS", secret: false, description: "Número desde el que se llama, E.164 (+34950835615).", requiredFor: ["retell-pilot"], validate: phoneE164 },
  {
    name: "CALLS_ALLOWLIST",
    category: "RETELL_CALLS",
    secret: false,
    description: "Teléfonos a los que se puede llamar. Con TEST_MODE=1, vacía = NADIE (fail-closed del 26-08). PRIORIDAD: settings.calls_allowlist (panel) sobre esta variable.",
    requiredFor: ["retell-pilot"],
    validate: phoneListDigits,
    managedBySettings: "calls_allowlist",
  },
  {
    name: "AI_CALLS_ENABLED",
    category: "RETELL_CALLS",
    secret: false,
    description: "Kill switch de llamadas. SE GESTIONA DESDE EL PANEL (settings.ai_calls_enabled tiene prioridad): no lo pongas en el .env salvo para el valor inicial.",
    requiredFor: [],
    defaultValue: "0",
    validate: bool01,
    managedBySettings: "ai_calls_enabled",
  },
  {
    name: "CALLS_SHADOW_MODE",
    category: "RETELL_CALLS",
    secret: false,
    description: "1 = simula sin llamar. También del panel (settings.calls_shadow_mode).",
    requiredFor: [],
    defaultValue: "1",
    validate: bool01,
    managedBySettings: "calls_shadow_mode",
  },

  // ── DROPEA ──
  { name: "DROPEA_API_KEY", category: "DROPEA", secret: true, description: "API key de solo lectura (sin orders:create, a propósito).", requiredFor: [] },
  { name: "DROPEA_MARKET", category: "DROPEA", secret: false, description: "Mercado (es).", requiredFor: [], defaultValue: "es" },
  { name: "DROPEA_API_ENABLED", category: "DROPEA", secret: false, description: "1 = lectura de la API habilitada.", requiredFor: [], defaultValue: "0", validate: bool01 },
  {
    name: "DROPEA_WRITE_ENABLED",
    category: "DROPEA",
    secret: false,
    description: "SIEMPRE 0: la app oficial crea los pedidos. Ver CLAUDE.md §2.",
    requiredFor: [],
    mustEqual: { "local-safe": "0", "shopify-readonly": "0", "whatsapp-baileys": "0", "whatsapp-cloud-pilot": "0", "retell-pilot": "0" },
    defaultValue: "0",
    validate: bool01,
  },
  {
    name: "DROPEA_CREATE_MODE",
    category: "DROPEA",
    secret: false,
    description: "external_app: su app crea, nosotros adoptamos. NO cambiar.",
    requiredFor: [],
    defaultValue: "external_app",
    validate: enumOf("external_app", "own_api"),
  },
  { name: "DROPEA_WEBHOOK_SECRET", category: "DROPEA", secret: true, description: "Firma de sus webhooks. Solo NAS.", requiredFor: ["nas-production"] },
  { name: "DROPEA_LEGACY_CREATE_ACTIVE", category: "DROPEA", secret: false, description: "1 = su app sigue activa (segunda llave anti-duplicados).", requiredFor: [], defaultValue: "1", validate: bool01 },

  // ── DROPI — SIN API PÚBLICA: NO CONFIGURAR ──
  {
    name: "DROPIPRO_API_KEY",
    category: "DROPI",
    secret: true,
    description: "⛔ NO RELLENAR: Dropi no tiene API pública (confirmado por soporte, 25-08). Existe solo por compatibilidad del andamiaje.",
    requiredFor: [],
    status: "LEGACY_DO_NOT_CONFIGURE",
  },
  {
    name: "DROPIPRO_API_BASE_URL",
    category: "DROPI",
    secret: false,
    description: "⛔ NO RELLENAR: no hay API a la que apuntar.",
    requiredFor: [],
    status: "LEGACY_DO_NOT_CONFIGURE",
  },
  {
    name: "DROPIPRO_WEBHOOK_SECRET",
    category: "DROPI",
    secret: true,
    description: "⛔ NO RELLENAR: reservada por si Dropi algún día firma webhooks. Su receptor está apagado (503).",
    requiredFor: [],
    status: "FUTURE",
  },
  {
    name: "DROPIPRO_WEBHOOK_ENABLED",
    category: "DROPI",
    secret: false,
    description: "0 SIEMPRE: sin autenticación confirmada, aceptar avisos sería inventarse estados de envío.",
    requiredFor: [],
    mustEqual: { "local-safe": "0" },
    defaultValue: "0",
    validate: bool01,
  },
  { name: "DROPI_EXPECTED_VENDOR", category: "DROPI", secret: false, description: "Vendor que exige su app de Shopify (diagnóstico).", requiredFor: [], defaultValue: "Dropi PRO" },
];

// --- Requisitos "uno de" que no caben en una sola variable ---

export interface OneOfCheck {
  profile: Profile;
  label: string;
  anyOf: string[][];
  detail: string;
}

export const ONE_OF_CHECKS: OneOfCheck[] = [
  {
    profile: "shopify-readonly",
    label: "credenciales de la Admin API",
    anyOf: [["SHOPIFY_ADMIN_ACCESS_TOKEN"], ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]],
    detail: "o el token estático (shpat_…) o el par client_id+client_secret",
  },
];

// --- Auditoría ---

export type ItemState = "ok" | "missing" | "invalid" | "wrong_value" | "not_needed" | "do_not_configure";

export interface AuditItem {
  spec: EnvVarSpec;
  state: ItemState;
  /** Valor efectivo, SOLO para no-secretos. Secretos: null siempre. */
  shownValue: string | null;
  problem: string | null;
}

export interface EnvAudit {
  profile: Profile;
  items: AuditItem[];
  /** Peligros transversales (p.ej. producción sin TEST_MODE en el Mac). */
  dangers: string[];
  missingRequired: string[];
  ready: boolean;
}

/** Valores que PARECEN rellenos pero no son credenciales: cuentan como vacío.
 *  (Por eso la plantilla deja los secretos VACÍOS: un "fake-token-123" acaba
 *  pegado donde no debe y este detector existe para pillarlo.) */
const PLACEHOLDER_RE = /^(your[-_].*|changeme|change[-_]me|xxx+|todo|tbd|fake[-_].*|placeholder|<[^>]*>|\.\.\.)$/i;

export function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value.trim());
}

function effectiveValue(spec: EnvVarSpec, env: NodeJS.ProcessEnv): { raw: string | undefined; effective: string } {
  let raw = env[spec.name]?.trim();
  if (raw !== undefined && (raw === "" || looksLikePlaceholder(raw))) raw = undefined;
  return { raw, effective: raw !== undefined ? raw : (spec.defaultValue ?? "") };
}

export function auditEnvironment(profile: Profile, env: NodeJS.ProcessEnv = process.env): EnvAudit {
  const items: AuditItem[] = [];
  const missingRequired: string[] = [];
  const dangers: string[] = [];

  for (const spec of ENV_SCHEMA) {
    const { raw, effective } = effectiveValue(spec, env);
    const required = spec.requiredFor.includes(profile);
    const expected = spec.mustEqual?.[profile];
    let state: ItemState = "ok";
    let problem: string | null = null;

    if (spec.status === "LEGACY_DO_NOT_CONFIGURE") {
      state = raw !== undefined ? "invalid" : "do_not_configure";
      problem = raw !== undefined ? "está RELLENADA y no debe estarlo: no existe API que la use" : null;
    } else if (required && raw === undefined) {
      state = "missing";
      problem = "falta y este perfil la necesita";
      missingRequired.push(spec.name);
    } else if (raw !== undefined && raw !== "" && spec.validate) {
      const err = spec.validate(raw);
      if (err) {
        state = "invalid";
        problem = err;
        if (required) missingRequired.push(spec.name);
      }
    }

    if (state === "ok" && expected !== undefined && effective !== expected) {
      state = "wrong_value";
      problem = `este perfil exige ${spec.name}=${expected} (efectivo: "${effective || "(vacío)"}")`;
      missingRequired.push(spec.name);
    }

    if (state === "ok" && !required && expected === undefined && raw === undefined) {
      state = "not_needed";
    }

    items.push({
      spec,
      state,
      shownValue: spec.secret ? null : (raw ?? (spec.defaultValue ? `(default: ${spec.defaultValue})` : null)),
      problem,
    });
  }

  // "Uno de": credenciales alternativas.
  for (const check of ONE_OF_CHECKS) {
    if (check.profile !== profile) continue;
    const satisfecho = check.anyOf.some((grupo) => grupo.every((n) => (env[n] ?? "").trim() !== ""));
    if (!satisfecho) {
      missingRequired.push(check.label);
      dangers.push(`Faltan ${check.label}: ${check.detail}.`);
    }
  }

  // Peligros transversales (siempre se evalúan en perfiles de Mac).
  const esLocal = profile !== "nas-production";
  const appMode = (env.APP_MODE ?? "").trim();
  const testMode = (env.TEST_MODE ?? "0").trim();
  if (esLocal && appMode === "production" && testMode !== "1") {
    dangers.push(
      "🚨 APP_MODE=production con TEST_MODE≠1 EN ESTE ORDENADOR: si además hay credenciales reales, esto puede escribir a CLIENTES REALES. En el Mac, TEST_MODE=1 siempre."
    );
  }
  if (profile === "local-safe") {
    for (const [n, v] of [
      ["WHATSAPP_SEND_ENABLED", "1"],
      ["SHOPIFY_WRITE_ENABLED", "1"],
      ["DROPEA_WRITE_ENABLED", "1"],
      ["META_WHATSAPP_API_ENABLED", "1"],
    ] as const) {
      if ((env[n] ?? "").trim() === v) {
        dangers.push(`⚠️ ${n}=1 en el perfil local-safe: apágalo (=0) para trabajar sin riesgo de efectos reales.`);
      }
    }
    if ((env.AI_CALLS_ENABLED ?? "0").trim() === "1") {
      dangers.push("⚠️ AI_CALLS_ENABLED=1 en local-safe. Las llamadas se gestionan desde el panel; en el Mac, apagadas.");
    }
  }
  if (profile === "retell-pilot" && (env.CALLS_ALLOWLIST ?? "").trim() === "") {
    dangers.push(
      "NO ACTIVES ai_calls_enabled hasta que este perfil esté verde: sin allowlist, el fail-closed bloqueará todas las llamadas (y así debe ser)."
    );
  }
  if (profile === "nas-production") {
    dangers.push("Este perfil es SOLO diagnóstico documental: no se ejecuta desde el Mac. El .env del NAS lo gestiona Pedro.");
  }

  const ready = missingRequired.length === 0 && !dangers.some((d) => d.startsWith("🚨"));
  return { profile, items, dangers, missingRequired: [...new Set(missingRequired)], ready };
}
