// ============================================================
// Agregación: una llamada → el estado de TODO, listo para el panel.
//
// Regla del "overall": el peor estado OPERATIVO manda. `disabled` y
// `unknown` no arrastran el global hacia abajo — que Dropea esté apagada
// a propósito no significa que el sistema esté mal — pero se enseñan.
// Excepción: SQLite es el suelo de todo; si está mal, todo está mal.
// ============================================================

import {
  getBackupHealth,
  getDatabaseHealth,
  getOutboxHealth,
  getSchedulersHealth,
  type BackupHealth,
  type DatabaseHealth,
  type OutboxHealth,
  type SchedulerHealth,
} from "./health-core";
import {
  getDropeaHealth,
  getDropiHealth,
  getShopifyHealth,
  getWhatsAppHealth,
  type DropeaHealth,
  type DropiHealth,
  type ShopifyHealth,
  type WhatsAppHealth,
} from "./health-integrations";
import { getTrackingOverview, type TrackingOverview } from "./tracking-overview";
import { getDeliveryMetrics, type DeliveryMetrics } from "./delivery-metrics";
import { getBusinessAlerts, type BusinessAlertsResult } from "./business-alerts";
import { getUnitEconomics, type UnitEconomics } from "./unit-economics";
import { listIntegrationEvents } from "./repo";
import { emergencyStop } from "../safety";
import type { HealthCard, HealthStatus, IntegrationEventRow } from "./types";

export interface SystemOverview {
  generatedAt: number;
  overall: HealthStatus;
  emergencyStop: boolean;
  cards: HealthCard[];
  whatsapp: WhatsAppHealth;
  shopify: ShopifyHealth;
  dropea: DropeaHealth;
  dropi: DropiHealth;
  database: DatabaseHealth;
  backups: BackupHealth;
  outbox: OutboxHealth;
  schedulers: SchedulerHealth[];
  tracking: TrackingOverview;
  /** Fase A · sección de negocio: entrega, alertas y economía. */
  business: {
    status: HealthStatus;
    delivery: DeliveryMetrics;
    alerts: BusinessAlertsResult;
    economics: UnitEconomics;
  };
  /** Últimos problemas (warning/critical) para el Overview. */
  recentProblems: IntegrationEventRow[];
}

const RANK: Record<HealthStatus, number> = {
  healthy: 0,
  disabled: 0,
  unknown: 0,
  warning: 1,
  critical: 2,
};

function worst(statuses: HealthStatus[]): HealthStatus {
  let acc: HealthStatus = "healthy";
  for (const s of statuses) if (RANK[s] > RANK[acc]) acc = s;
  return acc;
}

export function getSystemOverview(): SystemOverview {
  const whatsapp = getWhatsAppHealth();
  const shopify = getShopifyHealth();
  const dropea = getDropeaHealth();
  const dropi = getDropiHealth();
  const database = getDatabaseHealth();
  const backups = getBackupHealth();
  const outbox = getOutboxHealth();
  const schedulers = getSchedulersHealth();
  const tracking = getTrackingOverview();
  const t = Math.floor(Date.now() / 1000);
  const delivery = getDeliveryMetrics();
  const alerts = getBusinessAlerts(delivery);
  const economics = getUnitEconomics();

  const todosSinSenales = schedulers.every((s) => s.status === "unknown");
  const schedulersWorst: HealthStatus = todosSinSenales
    ? "unknown"
    : worst(schedulers.map((s) => s.status));
  const schedulersMsg = todosSinSenales
    ? "sin señales todavía (¿el bot está arrancado?)"
    : schedulersWorst === "healthy"
      ? "todos los relojes al día"
      : (schedulers.find((s) => s.status === schedulersWorst)?.message ?? "revisar");

  const cards: HealthCard[] = [
    {
      service: "whatsapp",
      label: "WhatsApp",
      status: whatsapp.status,
      message: whatsapp.message,
      lastCheckedAt: t,
      detail: "integrations",
    },
    {
      service: "shopify",
      label: "Shopify",
      status: shopify.status,
      message: shopify.message,
      lastCheckedAt: t,
      detail: "integrations",
    },
    {
      service: "dropea",
      label: "Dropea",
      status: dropea.status,
      message: dropea.message,
      lastCheckedAt: t,
      detail: "integrations",
    },
    {
      service: "dropi",
      label: "Dropi",
      status: dropi.status,
      message: dropi.message,
      lastCheckedAt: t,
      detail: "integrations",
    },
    {
      service: "sqlite",
      label: "Base de datos",
      status: database.status,
      message: database.message,
      lastCheckedAt: t,
      detail: "database",
    },
    {
      service: "backups",
      label: "Copias de seguridad",
      status: backups.status,
      message: backups.message,
      lastCheckedAt: t,
      detail: "backups",
    },
    {
      service: "outbox",
      label: "Cola de envíos",
      status: outbox.status,
      message: outbox.message,
      lastCheckedAt: t,
      detail: "outbox",
    },
    {
      service: "schedulers",
      label: "Tareas programadas",
      status: schedulersWorst,
      message: schedulersMsg,
      lastCheckedAt: t,
      detail: "schedulers",
    },
    {
      service: "tracking",
      label: "Envíos",
      status: tracking.status,
      message: tracking.message,
      lastCheckedAt: t,
      detail: "tracking",
    },
    {
      service: "business",
      label: "Negocio",
      status: alerts.status,
      message:
        alerts.status === "healthy"
          ? "tasa de entrega y operativa dentro de umbrales"
          : (alerts.alerts.find((a) => a.status === alerts.status)?.message ?? "revisar"),
      lastCheckedAt: t,
      detail: "business",
    },
  ];

  // SQLite manda: sin base de datos fiable, el resto de estados no vale nada.
  const overall: HealthStatus =
    database.status === "critical" ? "critical" : worst(cards.map((c) => c.status));

  const recentProblems = listIntegrationEvents({ limit: 30 }).filter(
    (e) => e.severity !== "info"
  ).slice(0, 8);

  return {
    generatedAt: t,
    overall,
    emergencyStop: emergencyStop(),
    cards,
    whatsapp,
    shopify,
    dropea,
    dropi,
    database,
    backups,
    outbox,
    schedulers,
    tracking,
    business: { status: alerts.status, delivery, alerts, economics },
    recentProblems,
  };
}
