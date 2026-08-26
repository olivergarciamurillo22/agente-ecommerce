// ⛔⛔ HECHO CONFIRMADO (videollamada con soporte, 25-08-2026):
// DROPI **NO DISPONE DE API PÚBLICA**. Este fichero es andamiaje construido
// cuando se creía que la documentación llegaría — NO llegará salvo nueva
// evidencia. NO "terminar" esta integración: la vía real de Dropi es su app
// de Shopify (el vínculo se hace con el campo *vendor* del producto, ver
// docs/DROPI-API-CONTRACT.md y CONTEXTO-2026-08-25 §2). Se conserva porque
// el router y los gates lo importan y porque falla cerrado — no porque
// exista un plan de implementarlo.
// ============================================================
// Traducción de los estados de Dropi a los nuestros.
//
// ⚠️ DELIBERADAMENTE VACÍO. Conocemos los CAMPOS (`status_id`, `status_name`)
// pero NO el catálogo de valores. Mientras un estado no esté confirmado por
// Pedro o por documentación de Dropi:
//
//   → se normaliza a "unknown"
//   → se guarda el texto original en supplier_status_raw
//   → NO se dispara ningún aviso de reparto al cliente
//
// Adivinar aquí significaría mandarle a un cliente "tu pedido está en
// reparto, ten el efectivo preparado" cuando en realidad no lo está.
// ============================================================

import type { TrackingStatus } from "../../tracking/types";

/**
 * Mapa por `status_id` (el identificador numérico es más estable que el
 * nombre, que puede cambiar de redacción o de idioma).
 *
 * Se rellena SOLO con estados confirmados. Ejemplo de cómo quedará:
 *   [4, "out_for_delivery"],   // "EN REPARTO" ← pendiente de confirmar
 */
const DROPI_STATUS_BY_ID: Array<[number, TrackingStatus]> = [
  // (vacío hasta que Pedro confirme el catálogo de estados de Dropi)
];

/**
 * Mapa por nombre, como respaldo. Igual de vacío y por el mismo motivo.
 */
const DROPI_STATUS_BY_NAME: Array<[string, TrackingStatus]> = [
  // (vacío hasta confirmación)
];

/**
 * Traducciones desde el entorno, para poder confirmar estados sin desplegar:
 *
 *   DROPI_STATUS_MAP=4:out_for_delivery,7:delivered
 *   DROPI_STATUS_MAP=EN REPARTO:out_for_delivery
 *
 * Acepta tanto id numérico como nombre.
 */
function mapaDelEntorno(): Map<string, TrackingStatus> {
  const salida = new Map<string, TrackingStatus>();
  const raw = (process.env.DROPI_STATUS_MAP ?? "").trim();
  if (!raw) return salida;
  for (const par of raw.split(",")) {
    const sep = par.lastIndexOf(":");
    if (sep < 0) continue;
    const clave = par.slice(0, sep).trim().toLowerCase();
    const valor = par.slice(sep + 1).trim() as TrackingStatus;
    if (clave && valor) salida.set(clave, valor);
  }
  return salida;
}

/**
 * Normaliza un estado de Dropi. Devuelve "unknown" si no está confirmado:
 * es la respuesta segura, no un fallo.
 */
export function normalizeDropiStatus(statusId: number, statusName: string): TrackingStatus {
  const entorno = mapaDelEntorno();
  const porIdEnv = entorno.get(String(statusId));
  if (porIdEnv) return porIdEnv;
  const porNombreEnv = entorno.get(statusName.trim().toLowerCase());
  if (porNombreEnv) return porNombreEnv;

  const porId = DROPI_STATUS_BY_ID.find(([id]) => id === statusId);
  if (porId) return porId[1];

  const nombre = statusName.trim().toLowerCase();
  const porNombre = DROPI_STATUS_BY_NAME.find(([n]) => n.toLowerCase() === nombre);
  if (porNombre) return porNombre[1];

  return "unknown";
}

/** ¿Está este estado de Dropi confirmado en algún mapa? */
export function isDropiStatusKnown(statusId: number, statusName: string): boolean {
  return normalizeDropiStatus(statusId, statusName) !== "unknown";
}
