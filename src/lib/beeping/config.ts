// ============================================================
// Configuración de Beeping. Todos los flags son FAIL-CLOSED: sin definir,
// todo apagado. El único secreto es BEEPING_BASIC_AUTH (la credencial Basic
// completa, generada en local por `npm run beeping:auth:init`): NUNCA se
// registra, se imprime ni sale del proceso salvo en la cabecera HTTP.
// ============================================================

import { getSetting, setSetting } from "../db";

/** Default seguro documentado; solo se cambia por env explícito. */
export const BEEPING_DEFAULT_BASE_URL = "https://app.gobeeping.com";

export interface BeepingConfig {
  baseUrl: string;
  /** Credencial Basic YA codificada (no email/contraseña). SECRETA. */
  basicAuth: string;
}

export function beepingConfig(): BeepingConfig | null {
  const basicAuth = (process.env.BEEPING_BASIC_AUTH ?? "").trim();
  if (!basicAuth) return null;
  const baseUrl = ((process.env.BEEPING_BASE_URL ?? "").trim() || BEEPING_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { baseUrl, basicAuth };
}

export function beepingCredentialsPresent(): boolean {
  return beepingConfig() !== null;
}

/** ¿Se permite LEER de Beeping? Requiere flag explícito + credencial. */
export function beepingEnabled(): boolean {
  return process.env.BEEPING_ENABLED === "1" && beepingCredentialsPresent();
}

/** ¿Se permiten ESCRITURAS (mark-to-send, cancel, update)? Capa aparte. */
export function beepingWriteEnabled(): boolean {
  return beepingEnabled() && process.env.BEEPING_WRITE_ENABLED === "1";
}

/**
 * ¿Liberar automáticamente al confirmar el cliente? HOY SIEMPRE MANUAL:
 * el flag existe para que el día del piloto real solo haya que encenderlo,
 * pero el código que lo consulta (release.ts) exige además writes abiertos.
 */
export function beepingAutoReleaseEnabled(): boolean {
  return beepingWriteEnabled() && process.env.BEEPING_AUTO_RELEASE_CONFIRMED === "1";
}

/**
 * ¿Puede la reconciliación de Beeping disparar WhatsApps de postventa?
 * Apagado por defecto MIENTRAS SE DESARROLLA: la sync actualiza tracking y
 * cierre igualmente, pero no encola avisos. (Los safety gates de WhatsApp
 * siguen detrás cuando esto se encienda.)
 */
export function beepingNotificationsEnabled(): boolean {
  return process.env.BEEPING_NOTIFICATIONS_ENABLED === "1";
}

// --- Tienda: autodetección y caché en settings (cero config manual) ---

const SHOP_ID_KEY = "beeping_shop_id";
const SHOP_NAME_KEY = "beeping_shop_name";

export function cachedBeepingShopId(): number | null {
  const v = getSetting(SHOP_ID_KEY);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function cachedBeepingShopName(): string | null {
  return getSetting(SHOP_NAME_KEY);
}

export function cacheBeepingShop(id: number, name: string): void {
  setSetting(SHOP_ID_KEY, String(id));
  setSetting(SHOP_NAME_KEY, name);
}
