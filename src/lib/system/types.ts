// ============================================================
// Tipos del Control Center. Todo lo que sale de aquí acaba en el
// dashboard o en la CLI, así que NUNCA transporta secretos ni PII.
// ============================================================

/** Estados normalizados de cualquier cosa vigilada. */
export type HealthStatus = "healthy" | "warning" | "critical" | "disabled" | "unknown";

/** Los servicios con fila propia en service_health. */
export type ServiceName =
  | "whatsapp"
  | "shopify"
  | "dropea"
  | "dropi"
  | "beeping"
  | "meta_ads"
  | "sqlite"
  | "backups"
  | "outbox"
  | "scheduler:orders"
  | "scheduler:tracking"
  | "scheduler:outbox"
  | "scheduler:watchdog"
  | "scheduler:reconcile"
  | "scheduler:calls"
  | "scheduler:beeping"
  | "scheduler:meta_ads";

export type EventIntegration =
  | "system"
  | "shopify"
  | "whatsapp"
  | "dropea"
  | "dropi"
  | "beeping"
  | "meta_ads"
  | "tracking"
  | "sqlite"
  | "backup";

export type EventSeverity = "info" | "warning" | "critical";

/** Tarjeta de estado que pinta el Overview. */
export interface HealthCard {
  service: string;
  /** Etiqueta en cristiano para el panel ("WhatsApp", "Copias de seguridad"…). */
  label: string;
  status: HealthStatus;
  /** Mensaje corto ya sanitizado. */
  message: string;
  lastCheckedAt: number | null;
  /** Subsección del panel a la que enlaza el detalle, si aplica. */
  detail?: string;
}

export interface ServiceHealthRow {
  service: string;
  status: HealthStatus;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error_message: string | null;
  last_checked_at: number;
  metadata_json: string | null;
}

export interface SchedulerRunRow {
  id: number;
  scheduler_name: string;
  started_at: number;
  finished_at: number | null;
  status: "ok" | "error";
  processed_count: number;
  error_count: number;
  last_error: string | null;
}

export interface IntegrationEventRow {
  id: number;
  integration: EventIntegration;
  event_type: string;
  severity: EventSeverity;
  order_ref: string | null;
  message: string;
  created_at: number;
}
