// ============================================================
// CLAVES GESTIONADAS DESDE EL PANEL (10-09-2026)
//
// Hasta hoy TODAS las claves vivían solo en el `.env` del servidor, así que
// cambiar una exigía entrar por SSH. Con una instalación por cliente eso no
// escala: el cliente tiene que poder poner y renovar sus propias claves sin
// pasar por nosotros (el token de la biblioteca de anuncios, por ejemplo,
// caduca cada 60 días).
//
// CÓMO FUNCIONA, y por qué así:
//
//   · Se guardan CIFRADAS (AES-256-GCM) en `app_secrets`, nunca en claro. La
//     copia de seguridad de la base se mueve de máquina en máquina (ver el
//     runbook de despliegue): si guardáramos el valor en claro, cada backup
//     sería una filtración de credenciales.
//   · La llave maestra (`SECRETS_MASTER_KEY`) vive SOLO en el `.env`. Sin
//     ella el módulo se apaga entero y lo dice: no hay modo degradado que
//     guarde en claro «por comodidad». Fail-closed, como el resto del sistema.
//   · El valor NUNCA vuelve al navegador. La API devuelve metadatos: los
//     cuatro últimos caracteres, quién la puso y cuándo. Se escribe, no se lee.
//   · La base MANDA sobre el `.env` (mismo criterio que el tope diario de IA
//     en `system/ai-budget.ts`): lo que el cliente pone en el panel gana.
//   · Solo el rol `owner`. Un `agent` (atención al cliente) no las ve.
//
// PROPAGACIÓN ENTRE PROCESOS: el panel y el bot son dos procesos sobre la
// misma SQLite. Al arrancar, cada uno vuelca las claves de la base a
// `process.env` (`hydrateSecretsIntoEnv`), de modo que los ~60 puntos de
// lectura que ya existen (`process.env.X`) siguen funcionando sin tocarlos.
// Un contador de versión (`secretsVersion`) permite al proceso que no hizo el
// cambio darse cuenta y volver a volcar, sin reiniciar.
// ============================================================

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { systemDbHandle, getSetting, setSetting } from "../db";

/** Marcador que se toca en cada escritura: así el otro proceso se entera. */
export const SECRETS_VERSION_KEY = "app_secrets_version";

export type SecretRisk = "critico" | "alto" | "normal";

export interface ManagedSecret {
  name: string;
  label: string;
  group: string;
  /** Qué se rompe si esta clave falta o está mal. En español, para el panel. */
  impact: string;
  /** Dónde la saca el cliente. */
  where: string;
  risk: SecretRisk;
  /** true = se puede comprobar contra el proveedor antes de guardarla. */
  verifiable: boolean;
}

/**
 * Las 16 marcadas `secret: true` en `env-schema.ts` más `OPENROUTER_API_KEY`,
 * que es igual de secreta aunque el esquema no la marcara (ver docs).
 */
export const MANAGED_SECRETS: ManagedSecret[] = [
  { name: "SHOPIFY_ADMIN_ACCESS_TOKEN", label: "Shopify · token de la Admin API", group: "Shopify", impact: "Sin ella no se leen los pedidos ni se etiqueta el confirmado: el flujo entero se para.", where: "Shopify → Configuración → Aplicaciones → tu app → Token de acceso de la Admin API (empieza por shpat_).", risk: "critico", verifiable: true },
  { name: "SHOPIFY_WEBHOOK_SECRET", label: "Shopify · clave secreta de la API", group: "Shopify", impact: "Firma los webhooks. Si no cuadra, TODOS los pedidos entrantes se rechazan y no llega ninguna confirmación.", where: "La misma pantalla de la app, campo «Clave secreta de la API».", risk: "critico", verifiable: false },
  { name: "SHOPIFY_CLIENT_SECRET", label: "Shopify · secreto del cliente OAuth", group: "Shopify", impact: "Solo hace falta si la instalación usa OAuth en vez de app privada.", where: "Pantalla de la app, sección de credenciales de cliente.", risk: "alto", verifiable: false },
  { name: "META_WHATSAPP_ACCESS_TOKEN", label: "WhatsApp · token permanente", group: "WhatsApp", impact: "Sin ella no sale ni un mensaje. Ojo: el token de pruebas caduca en 24 h, hace falta el permanente del usuario del sistema.", where: "Meta Business → Usuarios del sistema → Generar token (permisos whatsapp_business_messaging y _management, caducidad Nunca).", risk: "critico", verifiable: true },
  { name: "META_WHATSAPP_APP_SECRET", label: "WhatsApp · clave secreta de la app", group: "WhatsApp", impact: "Valida la firma de lo que manda Meta. Si no cuadra, se ignoran las respuestas de los clientes.", where: "developers.facebook.com → tu app → Configuración → Básica → Clave secreta.", risk: "critico", verifiable: false },
  { name: "META_WHATSAPP_VERIFY_TOKEN", label: "WhatsApp · token de verificación del webhook", group: "WhatsApp", impact: "Solo se usa al dar de alta el webhook en Meta. Cambiarla obliga a volver a verificar el webhook allí.", where: "Te la inventas tú; tiene que ser la misma que pegues en Meta → WhatsApp → Webhooks.", risk: "critico", verifiable: false },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter · clave de API", group: "Inteligencia artificial", impact: "Sin ella se apagan el agente conversacional, el análisis de imágenes de anuncios y la redacción. Los pedidos siguen confirmándose igual.", where: "openrouter.ai → Keys → Create key.", risk: "normal", verifiable: true },
  { name: "OPENAI_API_KEY", label: "OpenAI · clave de API", group: "Inteligencia artificial", impact: "Sin ella no se validan direcciones ni se transcriben los audios. El resto del flujo no se entera.", where: "platform.openai.com → API keys → Create new secret key.", risk: "normal", verifiable: true },
  { name: "META_AD_LIBRARY_ACCESS_TOKEN", label: "Cazador · token de la biblioteca de anuncios", group: "Cazador de productos", impact: "Sin ella el Cazador no busca y lo dice. CADUCA CADA 60 DÍAS: es la que más vas a renovar.", where: "Token de una PERSONA FÍSICA con identidad verificada. El de usuario del sistema NO sirve aquí, aunque tenga ads_read.", risk: "normal", verifiable: true },
  { name: "META_ADS_ACCESS_TOKEN", label: "Meta Ads · token de lectura", group: "Cazador de productos", impact: "Sin ella no se leen las métricas de tus campañas. Solo lectura, nunca escribe.", where: "Meta Business → Usuarios del sistema → token con ads_read.", risk: "normal", verifiable: true },
  { name: "DROPEA_API_KEY", label: "Dropea · clave de API", group: "Proveedor", impact: "Sin ella no se consulta el catálogo ni los estados de envío del proveedor.", where: "Panel de Dropea, sección de integraciones.", risk: "alto", verifiable: true },
  { name: "DROPEA_WEBHOOK_SECRET", label: "Dropea · secreto del webhook", group: "Proveedor", impact: "Firma los avisos de estado del proveedor. Si no cuadra, se ignoran los cambios de estado del envío.", where: "La configuras tú en el panel de Dropea al dar de alta el webhook.", risk: "alto", verifiable: false },
  { name: "DROPIPRO_API_KEY", label: "Dropi · clave de API", group: "Proveedor", impact: "Solo si la instalación usa Dropi. Hoy es diagnóstico, no despacha.", where: "Panel de Dropi.", risk: "normal", verifiable: false },
  { name: "DROPIPRO_WEBHOOK_SECRET", label: "Dropi · secreto del webhook", group: "Proveedor", impact: "Firma los avisos de Dropi.", where: "Panel de Dropi, al dar de alta el webhook.", risk: "normal", verifiable: false },
  { name: "BEEPING_BASIC_AUTH", label: "Beeping · credencial", group: "Proveedor", impact: "Sin ella la integración de Beeping queda apagada, que es como está hoy.", where: "Te la entrega Beeping.", risk: "normal", verifiable: false },
  { name: "RETELL_API_KEY", label: "Llamadas · clave de Retell", group: "Llamadas", impact: "Sin ella no se pueden lanzar llamadas. Hoy las llamadas son manuales.", where: "Panel de Retell → API keys.", risk: "normal", verifiable: true },
  { name: "PRODUCT_HUNTER_API_TOKEN", label: "Cazador externo · token", group: "Cazador de productos", impact: "Solo si el Cazador apunta a un backend externo (PRODUCT_HUNTER_SOURCE=api).", where: "Te lo da quien opere ese backend.", risk: "normal", verifiable: false },
];

const BY_NAME = new Map(MANAGED_SECRETS.map((s) => [s.name, s]));
export const isManagedSecret = (name: string): boolean => BY_NAME.has(name);
export const managedSecret = (name: string): ManagedSecret | null => BY_NAME.get(name) ?? null;

// ------------------------------------------------------------
// Llave maestra y cifrado
// ------------------------------------------------------------

/** Acepta 64 caracteres hex o 32 bytes en base64. Cualquier otra cosa se rechaza. */
export function parseMasterKey(raw: string | undefined | null): Buffer | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  try {
    const b = Buffer.from(v, "base64");
    if (b.length === 32) return b;
  } catch { /* cae al null de abajo */ }
  return null;
}

export function secretsAvailable(env: Record<string, string | undefined> = process.env): { ok: boolean; reason: string | null } {
  const raw = (env.SECRETS_MASTER_KEY ?? "").trim();
  if (!raw) return { ok: false, reason: "falta SECRETS_MASTER_KEY en el .env del servidor: sin llave maestra no se guardan claves cifradas (genera una con: npm run secrets:key)" };
  if (!parseMasterKey(raw)) return { ok: false, reason: "SECRETS_MASTER_KEY no tiene el formato correcto: se esperan 64 caracteres hexadecimales o 32 bytes en base64" };
  return { ok: true, reason: null };
}

/** Genera una llave maestra nueva. Se imprime una vez y se pega en el .env. */
export const generateMasterKey = (): string => crypto.randomBytes(32).toString("hex");

const ALGO = "aes-256-gcm";

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Devuelve null si el formato no cuadra o el descifrado falla (llave cambiada, dato corrupto). */
export function decryptSecret(blob: string, key: Buffer): string | null {
  const p = blob.split(":");
  if (p.length !== 4 || p[0] !== "v1") return null;
  try {
    const d = crypto.createDecipheriv(ALGO, key, Buffer.from(p[1], "base64"));
    d.setAuthTag(Buffer.from(p[2], "base64"));
    return Buffer.concat([d.update(Buffer.from(p[3], "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Los cuatro últimos caracteres, para que el cliente reconozca la clave sin verla entera. */
export const last4 = (v: string) => (v.length <= 4 ? "•".repeat(v.length) : v.slice(-4));

// ------------------------------------------------------------
// Almacén
// ------------------------------------------------------------

export type VerifyStatus = "ok" | "fallo" | "no_verificable" | "sin_verificar";

export interface SecretMeta extends ManagedSecret {
  /** true = hay valor guardado en la base (el del panel). */
  stored: boolean;
  /** true = hay valor en el .env (el que pusimos nosotros al instalar). */
  inEnv: boolean;
  /** De dónde sale el valor que se usa de verdad ahora mismo. */
  source: "panel" | "env" | "ninguna";
  last4: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  verifyStatus: VerifyStatus;
  verifyMessage: string | null;
  verifiedAt: number | null;
}

interface Row {
  name: string; value_enc: string; last4: string | null; updated_at: number;
  updated_by: string | null; verify_status: string | null; verify_message: string | null; verified_at: number | null;
}

export class SecretStore {
  private readonly key: Buffer | null;
  private readonly env: Record<string, string | undefined>;

  constructor(db?: Database.Database, env: Record<string, string | undefined> = process.env) {
    this.db = db ?? systemDbHandle();
    this.env = env;
    this.key = parseMasterKey(env.SECRETS_MASTER_KEY);
  }

  private readonly db: Database.Database;

  get available(): boolean { return this.key !== null; }

  /** El valor guardado, descifrado. null si no hay, o si la llave maestra ya no lo abre. */
  get(name: string): string | null {
    if (!this.key || !isManagedSecret(name)) return null;
    const r = this.db.prepare("SELECT value_enc FROM app_secrets WHERE name = ?").get(name) as { value_enc: string } | undefined;
    return r ? decryptSecret(r.value_enc, this.key) : null;
  }

  set(name: string, value: string, by: string | null, verify?: { status: VerifyStatus; message: string | null }): void {
    if (!this.key) throw new Error("sin llave maestra no se pueden guardar claves");
    if (!isManagedSecret(name)) throw new Error(`«${name}» no es una clave gestionable desde el panel`);
    const v = value.trim();
    if (!v) throw new Error("el valor está vacío");
    const ahora = Math.floor(Date.now() / 1000);
    this.db.prepare(`INSERT INTO app_secrets(name,value_enc,last4,updated_at,updated_by,verify_status,verify_message,verified_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET value_enc=excluded.value_enc,last4=excluded.last4,updated_at=excluded.updated_at,updated_by=excluded.updated_by,verify_status=excluded.verify_status,verify_message=excluded.verify_message,verified_at=excluded.verified_at`)
      .run(name, encryptSecret(v, this.key), last4(v), ahora, by, verify?.status ?? "sin_verificar", verify?.message ?? null, verify ? ahora : null);
    this.bump();
    // El proceso que escribe la ve al instante; el otro, en cuanto revise la versión.
    rememberEnvOriginal(name, this.env[name]);
    this.env[name] = v;
  }

  /** Borra la del panel: vuelve a mandar la del `.env`, si la hay. */
  clear(name: string): boolean {
    const info = this.db.prepare("DELETE FROM app_secrets WHERE name = ?").run(name);
    if (info.changes) {
      this.bump();
      const original = envOriginal(name);
      if (original === null) delete this.env[name]; else this.env[name] = original;
    }
    return info.changes > 0;
  }

  meta(env: Record<string, string | undefined> = this.env): SecretMeta[] {
    const filas = new Map((this.db.prepare("SELECT * FROM app_secrets").all() as Row[]).map((r) => [r.name, r]));
    return MANAGED_SECRETS.map((s) => {
      const r = filas.get(s.name);
      const inEnv = Boolean((envOriginal(s.name) ?? env[s.name] ?? "").trim());
      return {
        ...s,
        stored: Boolean(r), inEnv,
        source: r ? "panel" : inEnv ? "env" : "ninguna",
        last4: r?.last4 ?? null,
        updatedAt: r?.updated_at ?? null,
        updatedBy: r?.updated_by ?? null,
        verifyStatus: (r?.verify_status as VerifyStatus | undefined) ?? "sin_verificar",
        verifyMessage: r?.verify_message ?? null,
        verifiedAt: r?.verified_at ?? null,
      };
    });
  }

  /** Vuelca las claves de la base a `process.env`. Devuelve cuántas aplicó. */
  hydrate(env: Record<string, string | undefined> = this.env): number {
    if (!this.key) return 0;
    let n = 0;
    for (const r of this.db.prepare("SELECT name, value_enc FROM app_secrets").all() as Array<{ name: string; value_enc: string }>) {
      if (!isManagedSecret(r.name)) continue;
      const v = decryptSecret(r.value_enc, this.key);
      if (v === null) continue; // llave cambiada: se deja lo que haya en el .env
      rememberEnvOriginal(r.name, env[r.name]);
      env[r.name] = v;
      n++;
    }
    return n;
  }

  version(): number { const v = Number.parseInt(getSetting(SECRETS_VERSION_KEY) ?? "0", 10); return Number.isFinite(v) ? v : 0; }
  private bump(): void { setSetting(SECRETS_VERSION_KEY, String(this.version() + 1)); }
}

// El valor que tenía el `.env` antes de que lo pisara el panel: hace falta
// para poder volver atrás al borrar una clave sin reiniciar el proceso.
const ORIGINALES = new Map<string, string | undefined>();
function rememberEnvOriginal(name: string, actual: string | undefined): void {
  if (!ORIGINALES.has(name)) ORIGINALES.set(name, actual);
}
function envOriginal(name: string): string | null {
  if (!ORIGINALES.has(name)) return null;
  const v = ORIGINALES.get(name);
  return v === undefined ? null : v;
}
/** Solo para tests: olvida lo aprendido sobre el `.env`. */
export function resetEnvOriginals(): void { ORIGINALES.clear(); }

let ultimaVersion = -1;

/**
 * Vuelca la base a `process.env` si algo cambió desde la última vez. Se llama
 * al arrancar y cada pocos segundos en el proceso del bot: así una clave
 * cambiada desde el panel entra en vigor sin reiniciar nada.
 */
export function hydrateSecretsIntoEnv(db?: Database.Database, env: Record<string, string | undefined> = process.env): { applied: number; changed: boolean } {
  try {
    const store = new SecretStore(db ?? systemDbHandle(), env);
    if (!store.available) return { applied: 0, changed: false };
    const v = store.version();
    if (v === ultimaVersion) return { applied: 0, changed: false };
    const applied = store.hydrate(env);
    ultimaVersion = v;
    return { applied, changed: true };
  } catch {
    // Sin base todavía (arranque en frío) o tabla ausente: se sigue con el .env.
    return { applied: 0, changed: false };
  }
}

/** Solo para tests. */
export function resetHydrationCache(): void { ultimaVersion = -1; }
