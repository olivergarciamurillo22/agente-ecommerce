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
    return base;
  }

  // El estado ACTUAL es el de la fila (cada registro lo actualiza): no se
  // reconstruye comparando timestamps, que solo tienen resolución de segundo.
  if (health?.status === "critical" || health?.status === "warning") {
    base.status = health.status;
    base.message = `último intento con la API falló: ${base.lastApiError ?? "error"}`;
  } else {
    base.status = "healthy";
    base.message = base.writesEnabled
      ? `API lista (${authMode}) · escrituras permitidas`
      : `API lista (${authMode}) · escrituras BLOQUEADAS por gates`;
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
