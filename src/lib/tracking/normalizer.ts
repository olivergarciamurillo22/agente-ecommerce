// ============================================================
// Traducción de los estados del proveedor a los nuestros.
//
// ⚠️ PENDIENTE DEL HANDOFF: no conocemos todavía el catálogo real de estados
// de Dropi ni de Dropea. Aquí NO se adivina: lo que no esté en el mapa
// devuelve "unknown" y el pedido queda a revisión, en vez de suponer que
// "ENVIADO" significa lo que creemos.
//
// El mapa se completa de dos formas:
//   1. Con el catálogo real, en DEFAULT_MAP (código, revisado en PR).
//   2. Sobre la marcha, con SUPPLIER_STATUS_MAP en el .env, para no tener
//      que desplegar cada vez que aparece un estado nuevo.
// ============================================================

import pino from "pino";
import { TRACKING_STATUSES } from "./types";
import type { TrackingStatus } from "./types";

const logger = pino({ level: (process.env.LOG_LEVEL as pino.Level | undefined) ?? "info" });

/**
 * Mapa por defecto: SOLO términos genéricos que significan lo mismo en
 * cualquier transportista español o inglés. No cubre el vocabulario propio
 * de Dropi/Dropea, que llegará con su documentación.
 */
const DEFAULT_MAP: Record<string, TrackingStatus> = {
  // creado / pendiente
  created: "created",
  creado: "created",
  nuevo: "created",
  pending: "created",
  pendiente: "created",
  // preparación
  processing: "processing",
  procesando: "processing",
  preparando: "processing",
  preparation: "processing",
  confirmed: "processing",
  // enviado
  shipped: "shipped",
  enviado: "shipped",
  despachado: "shipped",
  // en tránsito
  in_transit: "in_transit",
  "in transit": "in_transit",
  transito: "in_transit",
  "en transito": "in_transit",
  "en camino": "in_transit",
  // en reparto
  out_for_delivery: "out_for_delivery",
  "out for delivery": "out_for_delivery",
  reparto: "out_for_delivery",
  "en reparto": "out_for_delivery",
  "en entrega": "out_for_delivery",
  // entregado
  delivered: "delivered",
  entregado: "delivered",
  completado: "delivered",
  // incidencia
  incident: "incident",
  incidencia: "incident",
  failed: "incident",
  fallido: "incident",
  exception: "incident",
  ausente: "incident",
  // devuelto
  returned: "returned",
  devuelto: "returned",
  devolucion: "returned",
  return: "returned",
  // cancelado
  cancelled: "cancelled",
  canceled: "cancelled",
  cancelado: "cancelled",
  anulado: "cancelled",
};

/**
 * Traducciones extra desde el entorno, para añadir el vocabulario real de
 * cada proveedor sin tocar código:
 *
 *   SUPPLIER_STATUS_MAP=EN_BODEGA:processing,GUIA_GENERADA:shipped
 */
function mapaDelEntorno(): Record<string, TrackingStatus> {
  const raw = (process.env.SUPPLIER_STATUS_MAP ?? "").trim();
  if (!raw) return {};
  const salida: Record<string, TrackingStatus> = {};
  for (const par of raw.split(",")) {
    const [externo, interno] = par.split(":");
    const clave = (externo ?? "").trim().toLowerCase();
    const valor = (interno ?? "").trim() as TrackingStatus;
    if (clave && valor) salida[clave] = valor;
  }
  return salida;
}

function normalizaClave(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Traduce el estado del proveedor al nuestro. Lo desconocido NO se adivina:
 * devuelve "unknown" y se registra una vez para poder añadirlo al mapa.
 */
export function normalizeSupplierStatus(rawStatus: string | null | undefined): TrackingStatus {
  if (!rawStatus || !rawStatus.trim()) return "unknown";

  const clave = normalizaClave(rawStatus);
  const conGuionBajo = clave.replace(/ /g, "_");
  const mapa = { ...DEFAULT_MAP, ...mapaDelEntorno() };

  const encontrado = mapa[clave] ?? mapa[conGuionBajo];
  if (encontrado) return encontrado;

  // Identidad: si el proveedor manda EXACTAMENTE una palabra de nuestro
  // propio vocabulario, significa eso y no hace falta mapa. Cubre huecos como
  // `delivery_attempted` y `at_pickup_point`, que existen en TrackingStatus
  // pero no estaban en el mapa por defecto — solo en el catálogo de Dropea,
  // así que cualquier otra vía los dejaba en "unknown" en silencio.
  if ((TRACKING_STATUSES as string[]).includes(conGuionBajo)) {
    return conGuionBajo as TrackingStatus;
  }

  logger.warn(
    `[TRACKING] estado desconocido del proveedor: "${rawStatus}". ` +
      `Añádelo a SUPPLIER_STATUS_MAP (ej. "${conGuionBajo}:in_transit") o al mapa por defecto.`
  );
  return "unknown";
}

/** ¿Está este estado reconocido? (para avisar de huecos en el mapa) */
export function isKnownSupplierStatus(rawStatus: string | null | undefined): boolean {
  return normalizeSupplierStatus(rawStatus) !== "unknown";
}
