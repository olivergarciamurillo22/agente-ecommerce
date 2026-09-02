// ============================================================
// Salud de las INTEGRACIONES: WhatsApp, Shopify, Dropea y Dropi.
//
// Solo lectura. Se apoya en dos fuentes:
//  1. Lo que ya persiste el negocio (connection_state, orders, outbox…).
//  2. service_health / integration_events, que rellenan los hooks de
//     instrumentación en los puntos de paso (cliente Dropea, admin de
//     Shopify, webhooks).
// Si una integración nunca ha dado señales: "unknown"/"never", jamás
// datos inventados.
// ============================================================

import { getConnectionState, getSetting, systemDbHandle } from "../db";
import { whatsappProviderName } from "../whatsapp/provider";
import { metaCloudConfigured } from "../whatsapp/meta-cloud";
import { canWriteToShopify, emergencyStop, maskPhone, testMode } from "../safety";
import { shopifyAdminConfigured } from "../shopify/admin";
import { dropeaCredentialsPresent, dropeaReadEnabled } from "../suppliers/dropea/client";
import { dropeaCreateModeSummary } from "../suppliers/dropea/create-gate";
import { dropiWebhookEnabled } from "../suppliers/dropi/webhook";
import { countIntegrationEvents, getServiceHealth, systemHealthEnabled } from "./repo";
import type { HealthStatus } from "./types";

const now = () => Math.floor(Date.now() / 1000);
const WEEK = 7 * 86400;

// ============================================================
// WhatsApp
// ============================================================

export interface WhatsAppHealth {
  status: HealthStatus;
  connectionStatus: string;
  /** Número del negocio ENMASCARADO. Nunca completo. */
  businessNumberMasked: string | null;
  lastConnectionChangeAt: number | null;
  lastOutboundAt: number | null;
  lastInboundAt: number | null;
  outboxPending: number;
  sendEnabled: boolean;
  emergencyStop: boolean;
  testMode: boolean;
  lastError: string | null;
  message: string;
  /** Proveedor activo: baileys | cloud_api. La UI no habla de QR si es cloud. */
  provider: "baileys" | "cloud_api";
  /** Solo en cloud_api: última recepción del webhook de Meta. */
  metaWebhookLastReceivedAt: number | null;
  /** Solo en cloud_api: entregados/leídos/fallados en las últimas 24 h. */
  deliveryStats24h: { delivered: number; read: number; failed: number } | null;
}

export function getWhatsAppHealth(): WhatsAppHealth {
  const base: WhatsAppHealth = {
    status: "unknown",
    connectionStatus: "unknown",
    businessNumberMasked: null,
    lastConnectionChangeAt: null,
    lastOutboundAt: null,
    lastInboundAt: null,
    outboxPending: 0,
    sendEnabled:
      process.env.APP_MODE === "production" && process.env.WHATSAPP_SEND_ENABLED === "1",
    emergencyStop: emergencyStop(),
    testMode: testMode(),
    lastError: null,
    message: "",
    provider: whatsappProviderName(),
    metaWebhookLastReceivedAt: null,
    deliveryStats24h: null,
  };

  // ── Proveedor CLOUD API: sin QR ni sesión — otra salud distinta ──
  if (base.provider === "cloud_api") {
    try {
      const db = systemDbHandle();
      const agg = db
        .prepare(
          `SELECT
             (SELECT MAX(COALESCE(sent_at, created_at)) FROM outbox WHERE sent = 1) AS lastOut,
             (SELECT MAX(created_at) FROM messages WHERE role = 'user') AS lastIn,
             (SELECT COUNT(*) FROM outbox WHERE sent = 0) AS pending,
             (SELECT COUNT(*) FROM outbox WHERE delivered_at >= unixepoch() - 86400) AS d24,
             (SELECT COUNT(*) FROM outbox WHERE read_at >= unixepoch() - 86400) AS r24,
             (SELECT COUNT(*) FROM outbox WHERE failed_at >= unixepoch() - 86400) AS f24`
        )
        .get() as { lastOut: number | null; lastIn: number | null; pending: number; d24: number; r24: number; f24: number };
      base.lastOutboundAt = agg.lastOut;
      base.lastInboundAt = agg.lastIn;
      base.outboxPending = agg.pending;
      base.deliveryStats24h = { delivered: agg.d24, read: agg.r24, failed: agg.f24 };
      const beat = getSetting("meta_webhook_last_received_at");
      base.metaWebhookLastReceivedAt = beat ? parseInt(beat, 10) || null : null;
    } catch {
      /* la parte común de abajo reporta el fallo */
    }
    if (!metaCloudConfigured()) {
      base.status = "warning";
      base.connectionStatus = "not_configured";
      base.message = "Cloud API activa como proveedor pero SIN credenciales de Meta: nada puede salir";
    } else {
      base.status = "healthy";
      base.connectionStatus = "configured";
      base.message = base.sendEnabled
        ? "API oficial de Meta configurada (conexión por token, sin QR)"
        : "API oficial de Meta configurada · envíos DESACTIVADOS (safe mode)";
      if (base.deliveryStats24h && base.deliveryStats24h.failed > 0) {
        base.status = "warning";
        base.message = `${base.deliveryStats24h.failed} mensaje(s) fallidos en 24 h — revisar la cola de envíos`;
      }
    }
    base.lastError = getServiceHealth("whatsapp")?.last_error_message ?? null;
    return base;
  }

  try {
    const conn = getConnectionState();
    base.connectionStatus = conn.status;
    base.businessNumberMasked = conn.phone ? maskPhone(conn.phone) : null;
    base.lastConnectionChangeAt = conn.updated_at ?? null;

    const db = systemDbHandle();
    const agg = db
      .prepare(
        `SELECT
           (SELECT MAX(COALESCE(sent_at, created_at)) FROM outbox WHERE sent = 1) AS lastOut,
           (SELECT MAX(created_at) FROM messages WHERE role = 'user') AS lastIn,
           (SELECT COUNT(*) FROM outbox WHERE sent = 0) AS pending`
      )
      .get() as { lastOut: number | null; lastIn: number | null; pending: number };
    base.lastOutboundAt = agg.lastOut;
    base.lastInboundAt = agg.lastIn;
    base.outboxPending = agg.pending;
  } catch (err) {
    base.status = "critical";
    base.message = `no se pudo leer el estado: ${err instanceof Error ? err.message : "error"}`;
    return base;
  }

  base.lastError = getServiceHealth("whatsapp")?.last_error_message ?? null;

  switch (base.connectionStatus) {
    case "connected": {
      base.status = "healthy";
      base.message = base.sendEnabled
        ? `conectado como ${base.businessNumberMasked}`
        : `conectado como ${base.businessNumberMasked} · envíos DESACTIVADOS (safe mode)`;
      // CONTRASTE: connection_state se queda en "connected" si el bot muere
      // sin despedirse. El latido del loop del outbox (~1/min) dice si el
      // proceso está VIVO de verdad. Sin latido reciente, ese "conectado"
      // no es creíble.
      if (systemHealthEnabled()) {
        const beat = getServiceHealth("scheduler:outbox")?.last_checked_at ?? null;
        if (!beat || now() - beat > 10 * 60) {
          base.status = "warning";
          base.message = `figura como conectado, pero el proceso del bot no da señales${
            beat ? ` desde hace ${Math.round((now() - beat) / 60)} min` : ""
          } — probablemente está parado`;
        }
      }
      break;
    }
    case "qr":
      base.status = "warning";
      base.message = "esperando que se escanee el QR";
      break;
    case "connecting":
      base.status = "warning";
      base.message = "reconectando…";
      break;
    default:
      base.status = "critical";
      base.message = "desconectado: el bot no está corriendo o perdió la sesión";
  }
  if (base.emergencyStop) base.message += " · EMERGENCY_STOP activo";
  return base;
}

// ============================================================
// Shopify
// ============================================================

export interface ShopifyHealth {
  status: HealthStatus;
  configured: boolean;
  /** static (shpat_) | client_credentials | none. Nunca el token. */
  authMode: "static" | "client_credentials" | "none";
  webhookSecretPresent: boolean;
  writesEnabled: boolean;
  lastWebhookAt: number | null;
  lastApiSuccessAt: number | null;
  lastApiErrorAt: number | null;
  lastApiError: string | null;
  lastTagWriteAt: number | null;
  /** Webhooks rechazados por HMAC inválido en las últimas 24 h. */
  webhookBadSignature24h: number;
  message: string;
}

export function getShopifyHealth(): ShopifyHealth {
  const authMode: ShopifyHealth["authMode"] = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
    ? "static"
    : process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET
      ? "client_credentials"
      : "none";

  const base: ShopifyHealth = {
    status: "unknown",
    configured: shopifyAdminConfigured(),
    authMode,
    webhookSecretPresent: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET),
    writesEnabled: canWriteToShopify(),
    lastWebhookAt: null,
    lastApiSuccessAt: null,
    lastApiErrorAt: null,
    lastApiError: null,
    lastTagWriteAt: null,
    webhookBadSignature24h: countIntegrationEvents("shopify", "webhook_bad_signature", now() - 86400),
    message: "",
  };

  try {
    // El último webhook es, por construcción, el último pedido insertado.
    const r = systemDbHandle()
      .prepare("SELECT MAX(created_at) AS t FROM orders")
      .get() as { t: number | null };
    base.lastWebhookAt = r?.t ?? null;
  } catch {
    /* sin tabla orders no hay dato */
  }

  const health = getServiceHealth("shopify");
  base.lastApiSuccessAt = health?.last_success_at ?? null;
  base.lastApiErrorAt = health?.last_error_at ?? null;
  base.lastApiError = health?.last_error_message ?? null;
  try {
    const meta = health?.metadata_json ? (JSON.parse(health.metadata_json) as Record<string, unknown>) : null;
    base.lastTagWriteAt = typeof meta?.lastTagWriteAt === "number" ? meta.lastTagWriteAt : null;
  } catch {
    /* metadata corrupta: se ignora */
  }

  if (!base.configured) {
    base.status = base.webhookSecretPresent ? "warning" : "unknown";
    base.message = base.webhookSecretPresent
      ? "webhook configurado pero sin credenciales de la Admin API (no se puede etiquetar)"
      : "sin configurar";
  } else if (health?.status === "critical" || health?.status === "warning") {
    // El estado ACTUAL es el de la fila (cada registro lo actualiza): no se
    // reconstruye comparando timestamps, que solo tienen resolución de segundo.
    base.status = health.status;
    base.message = `último intento con la API falló: ${base.lastApiError ?? "error"}`;
  } else {
    base.status = "healthy";
    base.message = base.writesEnabled
      ? `API lista (${authMode}) · escrituras permitidas`
      : `API lista (${authMode}) · escrituras BLOQUEADAS por gates`;
  }

  // Firmas inválidas recientes (BUG2, 26-08): un rechazo silencioso en
  // integration_events es invisible si nadie mira el feed — llevábamos días
  // perdiendo cancelaciones sin enterarnos. Esto lo hace ruidoso aunque el
  // resto de la integración esté sana.
  if (base.webhookBadSignature24h > 0) {
    base.status = base.status === "critical" ? "critical" : "warning";
    base.message += ` · ${base.webhookBadSignature24h} webhook(s) con firma inválida en 24 h — comprobar que SHOPIFY_WEBHOOK_SECRET es el de ESTA tienda (npm run shopify:doctor)`;
  }

  return base;
}

// ============================================================
// Dropea
// ============================================================

export interface DropeaHealth {
  status: HealthStatus;
  credentialsPresent: boolean;
  apiEnabled: boolean;
  writeEnabled: boolean;
  createMode: string;
  legacyAppActive: boolean;
  market: string;
  /** Lo guarda dropea:doctor en settings; null hasta que se ejecute. */
  storeId: string | null;
  webhookSecretPresent: boolean;
  lastApiSuccessAt: number | null;
  lastApiErrorAt: number | null;
  lastApiError: string | null;
  lastWebhookAt: number | null;
  /** Contadores de los últimos 7 días, salidos del feed de eventos. */
  counters: {
    webhookBadSignature: number;
    webhookDuplicates: number;
    ordersAdopted: number;
    trackingUpdates: number;
    rateLimitHits: number;
  };
  message: string;
}

export function getDropeaHealth(): DropeaHealth {
  const summary = dropeaCreateModeSummary();
  const health = getServiceHealth("dropea");
  const since = now() - WEEK;

  const base: DropeaHealth = {
    status: "unknown",
    credentialsPresent: dropeaCredentialsPresent(),
    apiEnabled: dropeaReadEnabled(),
    writeEnabled: summary.writeEnabled,
    createMode: summary.mode,
    legacyAppActive: summary.legacyAppActive,
    market: (process.env.DROPEA_MARKET ?? "es").toLowerCase(),
    storeId: getSetting("dropea_store_id"),
    webhookSecretPresent: Boolean(process.env.DROPEA_WEBHOOK_SECRET),
    lastApiSuccessAt: health?.last_success_at ?? null,
    lastApiErrorAt: health?.last_error_at ?? null,
    lastApiError: health?.last_error_message ?? null,
    lastWebhookAt: null,
    counters: {
      webhookBadSignature: countIntegrationEvents("dropea", "webhook_bad_signature", since),
      webhookDuplicates: countIntegrationEvents("dropea", "webhook_duplicate", since),
      ordersAdopted: countIntegrationEvents("dropea", "order_adopted", since),
      trackingUpdates: countIntegrationEvents("dropea", "tracking_update", since),
      rateLimitHits: countIntegrationEvents("dropea", "rate_limited", since),
    },
    message: "",
  };

  try {
    const r = systemDbHandle()
      .prepare("SELECT MAX(received_at) AS t FROM supplier_webhook_events WHERE platform = 'dropea'")
      .get() as { t: number | null };
    base.lastWebhookAt = r?.t ?? null;
  } catch {
    /* sin datos */
  }

  if (!base.credentialsPresent) {
    base.status = "disabled";
    base.message = "sin API key: integración preparada pero apagada";
  } else if (!base.apiEnabled) {
    base.status = "disabled";
    base.message = "API key presente pero DROPEA_API_ENABLED=0";
  } else if (health?.status === "critical" || health?.status === "warning") {
    // La fila guarda el estado ACTUAL (cada llamada lo actualiza): fiarse de
    // ella, no de comparar timestamps con resolución de segundo.
    const esAuth = /401|credencial|unauthorized|jwt|token/i.test(base.lastApiError ?? "");
    base.status = esAuth ? "critical" : health.status;
    base.message = `la API falló: ${base.lastApiError ?? "error"}`;
  } else if (!health || base.lastApiSuccessAt === null) {
    base.status = "unknown";
    base.message = "habilitada pero sin ninguna llamada todavía (ejecuta dropea:doctor)";
  } else {
    base.status = "healthy";
    base.message =
      base.createMode === "external_app"
        ? "lectura OK · creación de pedidos: la hace su app oficial"
        : "lectura OK";
  }
  // Firmas inválidas recientes: degradan solo una integración ACTIVA. Una
  // apagada ya rechaza todo; no hay nada nuevo que vigilar ahí.
  if (base.status !== "disabled" && base.counters.webhookBadSignature > 0) {
    base.status = base.status === "critical" ? "critical" : "warning";
    base.message += ` · ${base.counters.webhookBadSignature} webhook(s) con firma inválida en 7 días`;
  }
  return base;
}

// ============================================================
// Dropi
// ============================================================

export interface DropiHealth {
  status: HealthStatus;
  webhookEnabled: boolean;
  /** Seguimos sin evidencia de cómo autentica Dropi sus notificaciones. */
  webhookAuthKnown: boolean;
  statusMapConfigured: boolean;
  lastWebhookAt: number | null;
  unknownStatusesLast7d: number;
  trackingEventsLast7d: number;
  createOrderConfigured: boolean;
  message: string;
}

export function getDropiHealth(): DropiHealth {
  const base: DropiHealth = {
    status: "disabled",
    webhookEnabled: dropiWebhookEnabled(),
    webhookAuthKnown: false, // cambiará cuando Pedro confirme firma/token/IPs
    statusMapConfigured: Boolean((process.env.DROPI_STATUS_MAP ?? "").trim()),
    lastWebhookAt: null,
    unknownStatusesLast7d: countIntegrationEvents("dropi", "unknown_status", now() - WEEK),
    trackingEventsLast7d: countIntegrationEvents("dropi", "tracking_update", now() - WEEK),
    createOrderConfigured: false, // los pedidos de Dropi se crean a mano hoy
    message: "",
  };
  try {
    const r = systemDbHandle()
      .prepare("SELECT MAX(received_at) AS t FROM supplier_webhook_events WHERE platform = 'dropi'")
      .get() as { t: number | null };
    base.lastWebhookAt = r?.t ?? null;
  } catch {
    /* sin datos */
  }

  if (!base.webhookEnabled) {
    base.status = "disabled";
    base.message = "receptor apagado (fail-closed): falta confirmar cómo firma Dropi";
  } else if (!base.webhookAuthKnown) {
    // NUNCA healthy sin autenticación verificada, aunque esté encendido.
    base.status = "warning";
    base.message = "receptor ENCENDIDO sin autenticación verificada — revisar decisión";
  } else {
    base.status = base.statusMapConfigured ? "healthy" : "warning";
    base.message = base.statusMapConfigured
      ? "webhook activo"
      : "webhook activo pero sin DROPI_STATUS_MAP: estados tratados como desconocidos";
  }
  return base;
}

// --- Retell / llamadas: salud OPERATIVA (sin inventar billing) ---

export interface CallsHealth {
  enabled: boolean;
  shadowMode: boolean;
  /** true si hay allowlist con números (la protección del piloto). */
  allowlistActive: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  /** Retell no expone saldo por API que tengamos verificado: se dice la
   *  verdad ("hay que mirarlo a mano"), nunca un healthy falso. */
  paymentStatus: "unknown_manual_check_required";
  /** V3 (incidente [password 1]): el preflight visible en salud. */
  promptValidated: boolean;
  agentVersionPinned: boolean;
  configuredAgentVersion: string | null;
  /** La versión que usó la ÚLTIMA llamada real (auditoría). */
  lastCallAgentVersion: string | null;
  /** Bloqueo GLOBAL (hardening 03-09): auth/billing del proveedor o deriva de
   *  versión. Mientras exista, NO sale ninguna llamada, ni manual. */
  blockedReason: string | null;
  /** EMERGENCY_STOP / safe mode: apaga las llamadas por encima del kill switch propio. */
  killSwitchActive: boolean;
  /** Contadores de observabilidad (24 h): derivas, respuestas ambiguas del
   *  proveedor (posible llamada creada sin confirmar) y bloqueos. */
  driftEvents24h: number;
  ambiguousEvents24h: number;
  blockedEvents24h: number;
  status: HealthStatus;
  message: string;
}

function countCallEvents24h(db: ReturnType<typeof systemDbHandle>, eventType: string): number {
  try {
    const r = db
      .prepare("SELECT COUNT(*) AS n FROM integration_events WHERE event_type = ? AND created_at >= unixepoch() - 86400")
      .get(eventType) as { n: number };
    return r.n;
  } catch {
    return 0;
  }
}

function callsPromptValidated(): boolean {
  try {
    // Import estático arriba sería un ciclo potencial; el validador es puro.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { validatePromptPlaceholders } = require("../calls/prompt-validator") as typeof import("../calls/prompt-validator");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const prompt = fs.readFileSync("config/retell/casamable-agent-prompt.md", "utf8");
    return validatePromptPlaceholders(prompt).ok;
  } catch {
    return false;
  }
}

function lastCallAgentVersion(): string | null {
  try {
    const r = systemDbHandle()
      .prepare("SELECT agent_version FROM call_attempts WHERE agent_version IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get() as { agent_version: string } | undefined;
    return r?.agent_version ?? null;
  } catch {
    return null;
  }
}

export function getCallsHealth(): CallsHealth {
  const base: CallsHealth = {
    enabled: false,
    shadowMode: true,
    allowlistActive: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    paymentStatus: "unknown_manual_check_required",
    promptValidated: callsPromptValidated(),
    // Pin = NÚMERO de versión publicada. "latest_published" o un tag se
    // mueven solos: no cuentan como fijado (hardening 03-09).
    agentVersionPinned: /^\d+$/.test((process.env.RETELL_AGENT_VERSION ?? "").trim()),
    configuredAgentVersion: (process.env.RETELL_AGENT_VERSION ?? "").trim() || null,
    lastCallAgentVersion: lastCallAgentVersion(),
    blockedReason: null,
    killSwitchActive: false,
    driftEvents24h: 0,
    ambiguousEvents24h: 0,
    blockedEvents24h: 0,
    status: "unknown",
    message: "",
  };
  try {
    const db = systemDbHandle();
    base.blockedReason =
      ((db.prepare("SELECT value FROM settings WHERE key = 'calls_blocked_reason'").get() as { value: string } | undefined)?.value ?? "").trim() || null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const safety = require("../safety") as typeof import("../safety");
    base.killSwitchActive = safety.externalActionsLocked();
    base.driftEvents24h = countCallEvents24h(db, "call_agent_version_drift");
    base.ambiguousEvents24h = countCallEvents24h(db, "call_provider_ambiguous");
    base.blockedEvents24h = countCallEvents24h(db, "call_provider_blocked");
    const cfgRow = (k: string) =>
      (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
    base.enabled = (cfgRow("ai_calls_enabled") ?? process.env.AI_CALLS_ENABLED ?? "0") === "1";
    base.shadowMode = (cfgRow("calls_shadow_mode") ?? process.env.CALLS_SHADOW_MODE ?? "1") === "1";
    const allow = (cfgRow("calls_allowlist") ?? process.env.CALLS_ALLOWLIST ?? "").trim();
    base.allowlistActive = allow.length > 0;

    const agg = db
      .prepare(
        `SELECT
           (SELECT MAX(started_at) FROM call_attempts WHERE started_at IS NOT NULL) AS lastAttempt,
           (SELECT MAX(ended_at) FROM call_attempts WHERE state = 'completed') AS lastSuccess,
           (SELECT MAX(COALESCE(ended_at, started_at)) FROM call_attempts WHERE state = 'manual_review') AS lastFailure`
      )
      .get() as { lastAttempt: number | null; lastSuccess: number | null; lastFailure: number | null };
    base.lastAttemptAt = agg.lastAttempt;
    base.lastSuccessAt = agg.lastSuccess;
    base.lastFailureAt = agg.lastFailure;

    // Fallos consecutivos: intentos recientes en manual_review posteriores al
    // último completado. Una racha aquí suele ser saldo agotado o credencial.
    const racha = db
      .prepare(
        `SELECT COUNT(*) AS n FROM call_attempts
          WHERE state = 'manual_review'
            AND COALESCE(ended_at, started_at, scheduled_at) > COALESCE((
              SELECT MAX(ended_at) FROM call_attempts WHERE state = 'completed'
            ), 0)`
      )
      .get() as { n: number };
    base.consecutiveFailures = racha.n;

    if (base.blockedReason) {
      // Bloqueo global: lo pone el propio sistema (401/402 del proveedor o
      // deriva de versión) y solo lo quita un humano tras revisar.
      base.status = "critical";
      base.message = `llamadas BLOQUEADAS (ni manuales): ${base.blockedReason} — revisar y desbloquear con npm run retell:doctor -- --unblock`;
    } else if (!base.enabled) {
      base.status = "healthy";
      base.message = base.shadowMode
        ? "apagadas (kill switch cerrado) · shadow ON: simula sin llamar"
        : "apagadas (kill switch cerrado)";
      if (base.killSwitchActive) base.message += " · EMERGENCY_STOP activo";
    } else if (base.killSwitchActive) {
      base.status = "warning";
      base.message = "encendidas, pero EMERGENCY_STOP/safe mode está activo: NO sale ninguna llamada (ni manual) hasta levantarlo";
    } else if (!base.shadowMode && !(process.env.RETELL_API_KEY ?? "").trim()) {
      // Operador difícil: encender el kill switch sin credencial dejaba el
      // panel en verde mientras ninguna llamada podía salir.
      base.status = "critical";
      base.message = "encendidas pero FALTA RETELL_API_KEY: ninguna llamada puede salir — pégala en el .env del NAS y reinicia el contenedor";
    } else if (!base.allowlistActive && (cfgRow("calls_pilot_mode") ?? process.env.CALLS_PILOT_MODE ?? "1") !== "0") {
      base.status = "warning";
      base.message = "encendidas SIN allowlist en modo PILOTO: el fail-closed bloquea todas las llamadas — rellena calls_allowlist, o calls_pilot_mode=0 si la decisión es producción sin restricción";
    } else if (base.consecutiveFailures >= 3) {
      base.status = "critical";
      base.message = `${base.consecutiveFailures} llamadas seguidas a revisión sin ninguna completada: revisar saldo de Retell y credenciales (el saldo NO se puede comprobar desde aquí)`;
    } else {
      base.status = "healthy";
      base.message = `encendidas${base.shadowMode ? " en shadow" : ""} · allowlist ${base.allowlistActive ? "activa" : "SIN restricción (producción de llamadas, calls_pilot_mode=0)"}`;
    }
  } catch (err) {
    base.status = "warning";
    base.message = `no se pudo leer: ${err instanceof Error ? err.message : "error"}`;
  }
  return base;
}
