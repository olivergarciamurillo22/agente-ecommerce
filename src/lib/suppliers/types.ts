// ============================================================
// Contrato interno con los proveedores de fulfillment (Dropi PRO / Dropea).
//
// NADA de esto habla todavía con una API real: los providers son stubs que
// se niegan explícitamente a crear pedidos hasta que tengamos el handoff.
//
// La idea central es el DESACOPLAMIENTO: el resto del sistema construye un
// `SupplierOrderInput` (nuestro, neutro) y cada provider decide después cómo
// traducirlo a su API. Así Shopify no queda atado a ningún proveedor.
// ============================================================

/** Plataformas que puede resolver el router. */
export type SupplierPlatform = "dropi" | "dropea" | "manual" | "unknown";

export const SUPPLIER_PLATFORMS: SupplierPlatform[] = ["dropi", "dropea", "manual", "unknown"];

/**
 * Máquina de estados de la sincronización con el proveedor.
 *
 *   not_ready       → el pedido aún no está confirmado: no se toca
 *   blocked_address → la dirección no sirve para enviar (ver AddressIssue)
 *   manual_review   → hace falta una decisión humana (routing desconocido,
 *                     o dirección propuesta sin aprobar)
 *   ready           → confirmado, con routing y dirección válidos: sincronizable
 *   simulated       → se ejecutó la simulación (sin red). Sigue sin enviarse
 *   syncing         → envío en curso (claim: impide duplicar)
 *   synced          → el proveedor lo aceptó y tenemos su id. TERMINAL
 *   failed          → el intento falló; se puede reintentar
 *   cancelled       → descartado, no se sincroniza
 */
export type SupplierSyncStatus =
  | "not_ready"
  | "blocked_address"
  | "manual_review"
  | "ready"
  | "simulated"
  | "syncing"
  | "synced"
  | "failed"
  | "cancelled";

export const SUPPLIER_SYNC_STATUSES: SupplierSyncStatus[] = [
  "not_ready",
  "blocked_address",
  "manual_review",
  "ready",
  "simulated",
  "syncing",
  "synced",
  "failed",
  "cancelled",
];

/** Qué dirección se usa con el proveedor. */
export type FinalAddressSource = "original" | "proposed";

/** Dirección ya resuelta y validada, lista para enviar. */
export interface SupplierAddress {
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postalCode: string;
  country: string | null;
}

export interface SupplierOrderItem {
  title: string;
  quantity: number;
  /** Precio unitario tal y como vino de Shopify (string, sin convertir). */
  price: string | null;
  /** SKU: hoy no lo guardamos; el handoff dirá si el proveedor lo necesita. */
  sku: string | null;
}

/**
 * DTO INTERNO Y NEUTRO. No refleja la API de Dropi ni la de Dropea: cada
 * provider lo traducirá a su formato cuando tengamos su documentación.
 */
export interface SupplierOrderInput {
  /** Nuestra referencia estable; sirve de idempotency key si la API lo admite. */
  shopifyOrderId: string;
  orderNumber: string;
  customerName: string | null;
  /** Dígitos internacionales, ya normalizados (ej. "34600111222"). */
  phone: string;
  email: string | null;
  finalAddress: SupplierAddress;
  /** De dónde salió esa dirección (trazabilidad para revisión humana). */
  addressSource: FinalAddressSource;
  items: SupplierOrderItem[];
  /** Total del pedido, string tal cual lo manda Shopify. */
  total: string;
  currency: string;
  /** Importe a cobrar al cliente en la entrega (COD). Hoy = total. */
  codAmount: string;
  /** Nota del cliente para el repartidor, si la dejó (opción 3 del WhatsApp). */
  deliveryNote: string | null;
}

// --- Resultados de los providers ---

export interface SupplierValidationResult {
  ok: boolean;
  /** Motivos por los que NO se puede enviar (vacío si ok). */
  issues: string[];
}

export interface SupplierCreateResult {
  /** Id del pedido en el proveedor. Guardarlo BLOQUEA recrearlo. */
  externalOrderId: string;
  /** Estado que reporta el proveedor, con sus propias palabras. */
  status?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrier?: string | null;
  /** true si fue una SIMULACIÓN (no existe en el proveedor). */
  simulated: boolean;
}

export interface SupplierStatusResult {
  status: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrier?: string | null;
}

/**
 * Interfaz común de un proveedor. Los métodos de ESCRITURA (`createOrder`,
 * `cancelOrder`) deben lanzar `ProviderNotConfiguredError` mientras no haya
 * implementación real: preferimos un fallo ruidoso a un mock silencioso que
 * parezca producción.
 */
export interface SupplierProvider {
  readonly platform: SupplierPlatform;
  /** ¿Tiene credenciales y endpoints configurados? */
  isConfigured(): boolean;
  /** Validación específica del proveedor (además de la genérica de dirección). */
  validateOrder(input: SupplierOrderInput): SupplierValidationResult;
  /** Simulación local: NO hace red. Devuelve lo que se habría enviado. */
  simulateCreateOrder(input: SupplierOrderInput): SupplierCreateResult;
  /** Creación REAL. Lanza ProviderNotConfiguredError hasta el handoff. */
  createOrder(input: SupplierOrderInput): Promise<SupplierCreateResult>;
  getOrder(externalOrderId: string): Promise<unknown>;
  getStatus(externalOrderId: string): Promise<SupplierStatusResult>;
  getTracking(externalOrderId: string): Promise<SupplierStatusResult>;
  cancelOrder(externalOrderId: string): Promise<void>;
}

/**
 * Se lanza cuando se intenta una operación real contra un proveedor que aún
 * no está implementado o configurado. Es deliberadamente ruidosa.
 */
export class ProviderNotConfiguredError extends Error {
  readonly platform: SupplierPlatform;
  constructor(platform: SupplierPlatform, detalle?: string) {
    super(
      `ProviderNotConfigured: el proveedor "${platform}" no tiene implementación real todavía` +
        (detalle ? ` (${detalle})` : "") +
        ". Pendiente del handoff de su API."
    );
    this.name = "ProviderNotConfiguredError";
    this.platform = platform;
  }
}
