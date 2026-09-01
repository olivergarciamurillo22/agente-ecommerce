// ============================================================
// Integraciones para la pestaña Ajustes → Integraciones (§v2).
//
//   GET  → tarjetas de salud de TODAS las integraciones. Cada salud va en
//          su propio try/catch: una integración rota jamás tumba el endpoint.
//   POST → { service: "beeping" | "meta_ads" } — prueba de conexión
//          READ-ONLY contra la API real. Nunca devuelve ni loguea secretos.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";
import { getShopifyHealth, getWhatsAppHealth, getDropeaHealth, getDropiHealth, getCallsHealth } from "@/lib/system/health-integrations";
import { getDatabaseHealth, getBackupHealth } from "@/lib/system/health-core";
import { getBeepingHealth } from "@/lib/beeping/health";
import { getMetaAdsHealth } from "@/lib/meta-ads/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface IntegrationCard {
  id: string;
  label: string;
  status: "healthy" | "warning" | "critical" | "disabled" | "unknown";
  /** Mensaje humano en español: sale tal cual de las funciones de salud. */
  message: string;
  configured: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  extra?: Record<string, unknown>;
  /** Una frase corta: qué hace esta integración en el flujo. */
  description: string;
}

/** Ejecuta un builder de tarjeta; si revienta, la tarjeta lo cuenta sin romper el resto. */
function safeCard(id: string, label: string, description: string, build: () => Omit<IntegrationCard, "id" | "label" | "description">): IntegrationCard {
  try {
    return { id, label, description, ...build() };
  } catch (err) {
    return {
      id,
      label,
      description,
      status: "unknown",
      message: `no se pudo leer la salud: ${err instanceof Error ? err.message : "error"}`,
      configured: false,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: err instanceof Error ? err.message : "error",
    };
  }
}

export async function GET() {
  const cards: IntegrationCard[] = [
    safeCard("shopify", "Shopify", "Recibe los pedidos y refleja cancelaciones y fulfillments.", () => {
      const h = getShopifyHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.configured,
        lastSuccessAt: h.lastApiSuccessAt,
        lastErrorAt: h.lastApiErrorAt,
        lastError: h.lastApiError,
        extra: { authMode: h.authMode, webhookSecretPresent: h.webhookSecretPresent, lastWebhookAt: h.lastWebhookAt },
      };
    }),
    safeCard("whatsapp", "WhatsApp", "Confirma los pedidos con el cliente por mensaje.", () => {
      const h = getWhatsAppHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.connectionStatus !== "not_configured" && h.connectionStatus !== "unknown",
        lastSuccessAt: h.lastOutboundAt,
        lastErrorAt: null,
        lastError: h.lastError,
        extra: { provider: h.provider, outboxPending: h.outboxPending, sendEnabled: h.sendEnabled },
      };
    }),
    safeCard("calls", "Llamadas (Retell)", "Llama por teléfono a los clientes que no contestan al WhatsApp.", () => {
      const h = getCallsHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.enabled,
        lastSuccessAt: h.lastSuccessAt,
        lastErrorAt: h.lastFailureAt,
        lastError: null,
        extra: { shadowMode: h.shadowMode, allowlistActive: h.allowlistActive, consecutiveFailures: h.consecutiveFailures },
      };
    }),
    safeCard("beeping", "Beeping", "Prepara y envía los pedidos confirmados desde el almacén.", () => {
      const h = getBeepingHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.configured,
        lastSuccessAt: h.lastApiSuccessAt,
        lastErrorAt: h.lastApiErrorAt,
        lastError: h.lastApiError,
        extra: {
          shopName: h.shopName,
          awaitingRelease: h.awaitingRelease,
          ambiguousReleases: h.ambiguousReleases,
          writeEnabled: h.writeEnabled,
          autoRelease: h.autoRelease,
          lastSyncCheckpointAt: h.lastSyncCheckpointAt,
        },
      };
    }),
    safeCard("dropea", "Dropea", "Proveedor dropshipping del cortaúñas: tracking y estado de entrega.", () => {
      const h = getDropeaHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.credentialsPresent,
        lastSuccessAt: h.lastApiSuccessAt,
        lastErrorAt: h.lastApiErrorAt,
        lastError: h.lastApiError,
        extra: { lastWebhookAt: h.lastWebhookAt, createMode: h.createMode, market: h.market },
      };
    }),
    safeCard("dropi", "Dropi", "Proveedor dropshipping del resto del catálogo (hoy gestionado a mano).", () => {
      const h = getDropiHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.webhookEnabled,
        lastSuccessAt: h.lastWebhookAt,
        lastErrorAt: null,
        lastError: null,
        extra: { statusMapConfigured: h.statusMapConfigured, unknownStatusesLast7d: h.unknownStatusesLast7d },
      };
    }),
    safeCard("meta_ads", "Meta Ads", "Trae el gasto de publicidad para calcular el beneficio real.", () => {
      const h = getMetaAdsHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.configured,
        lastSuccessAt: h.lastApiSuccessAt,
        lastErrorAt: h.lastApiErrorAt,
        lastError: h.lastApiError,
        extra: { apiVersion: h.apiVersion, snapshotDays: h.snapshotDays, spendDays30d: h.spendDays30d },
      };
    }),
    safeCard("database", "Base de datos", "Guarda todos los pedidos y conversaciones en el SQLite local.", () => {
      const h = getDatabaseHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.reachable,
        lastSuccessAt: h.lastWriteAt,
        lastErrorAt: null,
        lastError: h.integrity === "ok" ? null : h.integrity,
        extra: { schemaVersion: h.schemaVersion, expectedSchemaVersion: h.expectedSchemaVersion, dbSizeBytes: h.dbSizeBytes },
      };
    }),
    safeCard("backups", "Copias de seguridad", "Copias automáticas de la base de datos para poder restaurar.", () => {
      const h = getBackupHealth();
      return {
        status: h.status,
        message: h.message,
        configured: h.lastBackupAt !== null,
        lastSuccessAt: h.lastBackupAt,
        lastErrorAt: null,
        lastError: h.integrity === "ok" || h.integrity === "no comprobado" ? null : h.integrity,
        extra: { count: h.count, ageHours: h.ageHours, lastBackupFile: h.lastBackupFile },
      };
    }),
  ];

  return NextResponse.json({ ok: true, cards });
}

export async function POST(req: NextRequest) {
  let body: { service?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  if (body.service === "beeping") {
    try {
      const client = await import("@/lib/beeping/client");
      const result = await client.healthCheck();
      // Solo el recuento: ni credencial ni detalle de tiendas viajan al navegador.
      return NextResponse.json({ ok: result.ok, shopsCount: result.shops.length, error: result.error });
    } catch (err) {
      return NextResponse.json({ ok: false, shopsCount: 0, error: err instanceof Error ? err.message : "error desconocido" });
    }
  }

  if (body.service === "meta_ads") {
    try {
      const client = await import("@/lib/meta-ads/client");
      const info = await client.getAccountInfo();
      let adsRead = false;
      try {
        const perms = await client.getTokenPermissions();
        adsRead = perms.some((p) => p.permission === "ads_read" && p.status === "granted");
      } catch {
        /* la cuenta respondió: el permiso queda como no verificado (false) */
      }
      return NextResponse.json({
        ok: true,
        accountName: info.name,
        currency: info.currency,
        timezone: info.timezone,
        adsRead,
      });
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "error desconocido" });
    }
  }

  return NextResponse.json({ ok: false, error: "este servicio no tiene prueba de conexión" }, { status: 400 });
}
