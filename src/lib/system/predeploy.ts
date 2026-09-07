// ============================================================
// COHERENCIA ENTRE FLAGS Y ENTORNO (07-09-2026) — docs/deploy/PREDESPLIEGUE.md
//
// Responde: "las variables que exigen las funciones ENCENDIDAS, ¿están?".
// No sustituye a `auditEnvironment` (env-schema), que audita variable a
// variable contra un perfil; esto audita COMBINACIONES: encender un flag sin
// su dependencia no es una variable que falte, es una función que no va a
// funcionar y que además puede parar la operativa.
//
// DELIBERADAMENTE APARTE de env-schema: meter reglas condicionales dentro de
// `auditEnvironment` cambiaría su veredicto `ready`, que la suite fija en
// verde para el perfil local-safe. Este módulo es puro (solo fs para leer
// dos ficheros de config) y NO importa src/lib/db: el orquestador del
// pre-despliegue no puede cargar db.ts sin inutilizar sus procesos hijo.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { looksLikePlaceholder } from "../config/env-schema";

export type PredeployStatus = "PASS" | "WARN" | "FAIL";

export interface FeatureCheck {
  name: string;
  status: PredeployStatus;
  detail: string;
}

export interface ChannelSummary {
  total: number;
  beeping: number;
  dropea: number;
}

export interface FeatureEnvInput {
  env: Record<string, string | undefined>;
  /** Resumen de dispatch_channels leído de la copia migrada; null si no se pudo leer. */
  channels: ChannelSummary | null;
  /** Raíz del repo, para leer config/. */
  cwd?: string;
}

function on(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name] ?? "").trim() === "1";
}

function present(env: Record<string, string | undefined>, name: string): boolean {
  const v = (env[name] ?? "").trim();
  return v !== "" && !looksLikePlaceholder(v);
}

function readJson(cwd: string, rel: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, rel), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Reglas de coherencia. Cada una dice qué se rompe si no se cumple, porque
 * quien lee el semáforo el día del despliegue necesita decidir, no adivinar.
 */
export function checkFeatureEnv(input: FeatureEnvInput): FeatureCheck[] {
  const { env, channels } = input;
  const cwd = input.cwd ?? process.cwd();
  const checks: FeatureCheck[] = [];
  const add = (name: string, status: PredeployStatus, detail: string) => checks.push({ name, status, detail });

  const addressAi = on(env, "ADDRESS_AI_VALIDATION_ENABLED");
  const intentAi = on(env, "POST_CONFIRMATION_AI_ENABLED");
  const cooldown = on(env, "AUTO_DISPATCH_COOLDOWN_ENABLED");
  const notice = on(env, "DISPATCH_NOTICE_WHATSAPP_ENABLED");
  const dropeaWrite = on(env, "DROPEA_WRITE_ENABLED");
  const tieneOpenAi = present(env, "OPENAI_API_KEY");

  // 1 · Capa 2 de direcciones.
  if (!addressAi) add("Direcciones · capa 2 (IA)", "PASS", "apagada (ADDRESS_AI_VALIDATION_ENABLED≠1): solo actúa la capa 1 determinista");
  else if (!tieneOpenAi) add("Direcciones · capa 2 (IA)", "FAIL", "ADDRESS_AI_VALIDATION_ENABLED=1 sin OPENAI_API_KEY válida: la capa 2 no se ejecutaría nunca y el flag miente");
  else add("Direcciones · capa 2 (IA)", "PASS", "encendida con clave presente");

  // 2 · IA de intención (y con ella la auto-cancelación ≥ 0,85).
  if (!intentAi) add("Intención post-confirmación (IA)", "PASS", "apagada (POST_CONFIRMATION_AI_ENABLED≠1): el texto libre va a persona, sin auto-cancelación");
  else {
    if (!tieneOpenAi) add("Intención post-confirmación (IA)", "FAIL", "POST_CONFIRMATION_AI_ENABLED=1 sin OPENAI_API_KEY válida");
    else add("Intención post-confirmación (IA)", "PASS", "encendida con clave presente");
    const faq = readJson(cwd, path.join("config", "faq-post-confirmacion.json"));
    const status = typeof faq?.status === "string" ? (faq.status as string) : "(ilegible)";
    if (/PROPUESTA|PENDIENTE/i.test(status)) add("FAQ post-confirmación", "FAIL", `la IA está encendida y la FAQ sigue en '${status}': se responderían textos sin aprobar`);
    else add("FAQ post-confirmación", "PASS", `aprobada (${status})`);
    // Auto-cancelación: el aviso por WhatsApp exige destinatario.
    if (!present(env, "ALERT_WHATSAPP")) add("Aviso de auto-cancelación", "FAIL", "con la IA encendida se puede cancelar sola un pedido; sin ALERT_WHATSAPP el aviso solo queda en la bandeja de atención, sin empujón a una persona");
    else add("Aviso de auto-cancelación", "PASS", "ALERT_WHATSAPP configurado: el aviso sale por la bandeja y por WhatsApp");
  }

  // 3 · Cooldown de auto-despacho y router de canal.
  if (!cooldown) add("Auto-despacho tras cooldown", "PASS", "apagado (AUTO_DISPATCH_COOLDOWN_ENABLED≠1): confirmar dispara el hook inmediato, como en v4.2");
  else if (!channels) add("Auto-despacho tras cooldown", "WARN", "encendido, pero no se ha podido leer dispatch_channels (sin copia): cobertura sin comprobar");
  else if (channels.total === 0) add("Auto-despacho tras cooldown", "FAIL", "AUTO_DISPATCH_COOLDOWN_ENABLED=1 con dispatch_channels VACÍA: ningún pedido se despacharía, todos quedarían RETENIDOS");
  else add("Auto-despacho tras cooldown", "PASS", `encendido con ${channels.total} regla(s) de canal (${channels.beeping} Beeping · ${channels.dropea} Dropea)`);

  const horas = Number.parseInt((env.AUTO_DISPATCH_COOLDOWN_HOURS ?? "6").trim(), 10);
  if (!Number.isFinite(horas) || horas < 1 || horas > 168) add("Horas de cooldown", "WARN", `AUTO_DISPATCH_COOLDOWN_HOURS='${env.AUTO_DISPATCH_COOLDOWN_HOURS}' fuera de 1–168: el código usará 6 h y la variable engaña`);
  else add("Horas de cooldown", "PASS", `${horas} h`);

  // 4 · Coherencia de Dropea.
  const hayDropea = (channels?.dropea ?? 0) > 0;
  if (hayDropea && !dropeaWrite) add("Canal Dropea", "FAIL", `${channels?.dropea} producto(s) enrutado(s) a Dropea con DROPEA_WRITE_ENABLED≠1: esos pedidos quedarían RETENIDOS siempre (write_disabled)`);
  else if (!hayDropea && dropeaWrite) add("Canal Dropea", "WARN", "DROPEA_WRITE_ENABLED=1 sin ningún producto en canal dropea: llave de escritura abierta sin uso");
  else if (hayDropea) add("Canal Dropea", "PASS", `${channels?.dropea} producto(s) en Dropea con escritura habilitada`);
  else add("Canal Dropea", "PASS", "sin productos en Dropea y escritura cerrada");

  // 5 · Aviso de despacho: exige plantilla real habilitada.
  if (!notice) add("Aviso de despacho (WhatsApp)", "PASS", "apagado (DISPATCH_NOTICE_WHATSAPP_ENABLED≠1)");
  else {
    const cfg = readJson(cwd, path.join("config", "whatsapp-templates.json"));
    const mappings = Array.isArray(cfg?.provider_mappings) ? (cfg.provider_mappings as Array<Record<string, unknown>>) : [];
    const m = mappings.find((x) => x.logicalKey === "dispatch_notice");
    if (!m) add("Aviso de despacho (WhatsApp)", "FAIL", "encendido y sin mapping 'dispatch_notice' en config/whatsapp-templates.json");
    else if (m.enabled === false) add("Aviso de despacho (WhatsApp)", "FAIL", `encendido pero el mapping 'dispatch_notice' → '${String(m.providerTemplate)}' está DESHABILITADO (plantilla sin aprobar en Meta)`);
    else add("Aviso de despacho (WhatsApp)", "WARN", "encendido y mapping habilitado: exige que whatsapp:templates:doctor la vea APPROVED en el NAS");
  }

  // 6 · Interruptores generales: informativos, pero deciden si algo sale.
  if (on(env, "EMERGENCY_STOP")) add("Interruptores generales", "WARN", "EMERGENCY_STOP=1: no saldrá ningún WhatsApp ni escritura externa (fail-closed deliberado)");
  else if ((env.APP_MODE ?? "").trim() !== "production") add("Interruptores generales", "WARN", `APP_MODE='${env.APP_MODE ?? ""}': fuera de production no se envía nada real`);
  else if (!on(env, "WHATSAPP_SEND_ENABLED")) add("Interruptores generales", "WARN", "WHATSAPP_SEND_ENABLED≠1: el bot no enviará mensajes reales");
  else add("Interruptores generales", "PASS", "production, envío habilitado y sin parada de emergencia");

  return checks;
}

/** Identidad del commit: el checkout debe ser EXACTAMENTE el que se va a desplegar. */
export function checkCommitIdentity(head: string | null, declared: string | undefined): FeatureCheck {
  const esperado = (declared ?? "").trim().toLowerCase();
  if (!esperado) {
    return {
      name: "Identidad del commit",
      status: "FAIL",
      detail: "no se ha declarado PRODUCTION_COMMIT (ni --commit): sin decir qué commit se despliega, el resto de comprobaciones no prueban nada sobre él",
    };
  }
  if (!/^[0-9a-f]{7,40}$/.test(esperado)) {
    return { name: "Identidad del commit", status: "FAIL", detail: `PRODUCTION_COMMIT='${esperado}' no es un SHA de git (7–40 hex)` };
  }
  if (!head) return { name: "Identidad del commit", status: "FAIL", detail: "no se ha podido leer el HEAD local (¿git disponible?)" };
  const real = head.trim().toLowerCase();
  if (!real.startsWith(esperado)) {
    return { name: "Identidad del commit", status: "FAIL", detail: `el checkout está en ${real.slice(0, 12)} y se declaró desplegar ${esperado.slice(0, 12)}: estás comprobando un código distinto del que vas a subir` };
  }
  return { name: "Identidad del commit", status: "PASS", detail: `HEAD ${real.slice(0, 12)} coincide con el commit declarado` };
}

export function worstStatus(checks: FeatureCheck[]): PredeployStatus {
  if (checks.some((c) => c.status === "FAIL")) return "FAIL";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  return "PASS";
}
