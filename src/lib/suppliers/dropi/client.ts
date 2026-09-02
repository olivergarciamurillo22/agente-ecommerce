// ⛔⛔ HECHO CONFIRMADO (videollamada con soporte, 25-08-2026):
// DROPI **NO DISPONE DE API PÚBLICA**. Este fichero es andamiaje construido
// cuando se creía que la documentación llegaría — NO llegará salvo nueva
// evidencia. NO "terminar" esta integración: la vía real de Dropi es su app
// de Shopify (el vínculo se hace con el campo *vendor* del producto, ver
// docs/DROPI-API-CONTRACT.md y docs/archive/sesiones-2026-08/CONTEXTO-2026-08-25.md §2). Se conserva porque
// el router y los gates lo importan y porque falla cerrado — no porque
// exista un plan de implementarlo.
// ============================================================
// Cliente HTTP de Dropi PRO — ⛔ BLOQUEADO: FALTA LA DOCUMENTACIÓN.
//
// Tenemos credenciales, pero credenciales NO son documentación. Para escribir
// este cliente hace falta saber, como mínimo:
//
//   1. URL base de la API (producción y sandbox, si existe).
//   2. Cómo se autentica: ¿cabecera `Authorization: Bearer`, `X-Api-Key`,
//      firma HMAC por petición? Si es firma: qué se firma exactamente
//      (método + ruta + cuerpo + timestamp), con qué algoritmo y codificación.
//   3. Endpoint y esquema JSON de creación de pedido: nombres EXACTOS de los
//      campos de cliente, dirección, artículos e importe contra reembolso.
//   4. Cómo identifica los productos: ¿SKU nuestro, id suyo de catálogo?
//   5. Si acepta una referencia externa / clave de idempotencia (para pasar
//      nuestro shopify_order_id y no duplicar pedidos ante un reintento).
//   6. Endpoints de consulta de estado y de tracking.
//   7. Catálogo COMPLETO de estados posibles, con su significado.
//   8. Si permite cancelar y en qué condiciones.
//   9. Límites de peticiones (rate limits) y política de reintentos.
//  10. Webhooks: eventos disponibles, cabecera de firma, algoritmo y qué
//      parte del mensaje se firma.
//
// Escribir este fichero "a ojo" produciría un cliente que falla en
// producción con pedidos reales de clientes. Por eso está bloqueado a
// propósito, no a medias.
// ============================================================

import { ProviderNotConfiguredError } from "../types";

export interface DropiConfig {
  baseUrl: string;
  apiKey: string;
}

/** Configuración desde el entorno. Los secretos NUNCA se registran. */
export function dropiConfig(): DropiConfig | null {
  const baseUrl = (process.env.DROPIPRO_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.DROPIPRO_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/** ¿Hay credenciales? (tenerlas NO significa que el cliente esté implementado.) */
export function dropiCredentialsPresent(): boolean {
  return dropiConfig() !== null;
}

/**
 * Punto único de entrada a la API. Mientras no exista la documentación,
 * cualquier llamada falla de forma explícita.
 *
 * Cuando llegue el handoff, esta función pasa a hacer el fetch real con su
 * cabecera de autenticación, timeout y manejo de errores.
 */
export async function dropiRequest(): Promise<never> {
  throw new ProviderNotConfiguredError(
    "dropi",
    "cliente HTTP no implementado: faltan endpoints, formato de autenticación y esquema de pedido"
  );
}
