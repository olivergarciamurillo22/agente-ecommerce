// ============================================================
// PLANTILLAS DE META — el catálogo local de lo que existe (o existirá).
//
// Meta solo permite mensajes iniciados por la empresa FUERA de la ventana
// de 24 h si usan una plantilla APROBADA. Este módulo carga la
// especificación local (config/whatsapp-templates.json) y construye el
// mensaje de plantilla con sus variables.
//
// La especificación local NO es la aprobación: una plantilla solo funciona
// de verdad cuando Pedro la ha dado de alta en Meta y está APPROVED. Si el
// nombre no existe allí, la Cloud API devuelve un error visible — que es lo
// que queremos: nunca degradar a un texto libre que Meta va a rechazar.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getSetting, setSetting } from "../db";
import type { OutboundWhatsAppMessage } from "./provider";

export interface TemplateSpec {
  name: string;
  language: string;
  category: string;
  use: string;
  variables: string[];
  draft_body: string;
  buttons: Array<{ type: string; text: string; payload: string }>;
  fallback: string;
}

let cache: TemplateSpec[] | null = null;

export function loadTemplateSpecs(): TemplateSpec[] {
  if (cache) return cache;
  const p = path.join(process.cwd(), "config", "whatsapp-templates.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { templates: TemplateSpec[] };
  cache = parsed.templates;
  return cache;
}

export function getTemplateSpec(name: string): TemplateSpec | null {
  return loadTemplateSpecs().find((t) => t.name === name) ?? null;
}

/**
 * Spec local de un mapping. El catálogo tiene specs con DOS nombres: unos con
 * la clave lógica (order_confirmation_request) y otros con el nombre real de
 * la WABA (retraso_pedido). Buscar solo por la clave lógica daba un falso
 * negativo: `order_delay_restock` no tiene spec propia, pero `retraso_pedido`
 * sí — y con sus 2 botones, que el flujo de retraso SÍ atiende
 * (delay_ok/delay_cancel en handleOrderButtonReply). Sin este fallback el
 * doctor reportaba "la WABA tiene 2 y el flujo local espera 0".
 */
export function resolveMappingSpec(mapping: ProviderMapping): TemplateSpec | null {
  return getTemplateSpec(mapping.logicalKey) ?? getTemplateSpec(mapping.providerTemplate);
}

/**
 * Construye el mensaje de plantilla. Falla RUIDOSAMENTE si el nombre no
 * está en el catálogo o el número de variables no cuadra: mandar una
 * plantilla con parámetros de menos es un rechazo seguro de Meta, mejor
 * pillarlo aquí que en producción.
 */
export function buildTemplateMessage(
  name: string,
  params: string[]
): Extract<OutboundWhatsAppMessage, { kind: "template" }> {
  const spec = getTemplateSpec(name);
  if (!spec) throw new Error(`plantilla desconocida: "${name}" (no está en config/whatsapp-templates.json)`);
  if (params.length !== spec.variables.length) {
    throw new Error(
      `plantilla "${name}": esperaba ${spec.variables.length} variable(s) (${spec.variables.join(", ")}) y llegaron ${params.length}`
    );
  }
  return {
    kind: "template",
    templateName: spec.name,
    language: spec.language,
    bodyParams: params,
    // Los payloads viven en el catálogo local (config/whatsapp-templates.json),
    // no se inventan aquí — así no pueden desincronizarse de BUTTON_PAYLOADS.
    buttonPayloads: spec.buttons.map((b) => b.payload),
  };
}

// ============================================================
// MAPPING LÓGICO → PLANTILLA REAL DE LA WABA (incidente 132001, 01-09).
//
// El 132001 de producción ocurrió porque el código enviaba el nombre del
// BORRADOR local (order_confirmation_request) y la WABA real tiene
// aprobados otros nombres (pedido, pedido_confirmado…). Desde ahora:
//
//   clave LÓGICA (dominio)  →  provider_mappings  →  nombre REAL (Meta)
//
// y NINGÚN mapping se usa sin VERIFICAR contra la Graph API (read-only):
// `npm run whatsapp:templates:doctor` comprueba nombre, idioma, estado
// APPROVED, aridad del cuerpo y botones, y cachea el resultado en
// settings. Sin verificación el envío queda BLOQUEADO con motivo visible
// — nunca más un 404 silencioso en bucle.
// ============================================================

export interface ProviderMapping {
  logicalKey: string;
  providerTemplate: string;
  language: string;
  /** Qué variables del builder local van a la plantilla real, en orden. */
  params: string[];
  /** `false` = mapping DESHABILITADO a propósito: la plantilla existe y puede
   *  estar APPROVED en la WABA, pero no hay flujo local que la pueda atender
   *  con seguridad. Nunca se considera lista, ni con caché previa. */
  enabled?: boolean;
  note?: string;
}

/** Lo que el doctor verificó contra Meta y cacheó en settings. */
export interface VerifiedTemplate {
  provider: string;
  language: string;
  status: string;
  /** Nº de variables {{n}} del cuerpo REAL. */
  paramCount: number;
  buttonCount: number;
  buttonTypes: string[];
  category: string | null;
  verifiedAt: number;
}

export function loadProviderMappings(): ProviderMapping[] {
  const p = path.join(process.cwd(), "config", "whatsapp-templates.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { provider_mappings?: ProviderMapping[] };
  return parsed.provider_mappings ?? [];
}

export function getProviderMapping(logicalKey: string): ProviderMapping | null {
  return loadProviderMappings().find((m) => m.logicalKey === logicalKey) ?? null;
}

const VERIFIED_SETTING_PREFIX = "wa_tpl_verified:";

/** La verificación cacheada por el doctor. null = nunca verificada. */
export function getVerifiedTemplate(logicalKey: string): VerifiedTemplate | null {
  try {
    const raw = getSetting(`${VERIFIED_SETTING_PREFIX}${logicalKey}`);
    if (!raw) return null;
    return JSON.parse(raw) as VerifiedTemplate;
  } catch {
    return null;
  }
}

export function storeVerifiedTemplate(logicalKey: string, v: VerifiedTemplate): void {
  setSetting(`${VERIFIED_SETTING_PREFIX}${logicalKey}`, JSON.stringify(v));
}

/** El envío no puede salir: quién, por qué, y qué hacer. */
export class TemplateNotReadyError extends Error {
  readonly logicalKey: string;
  readonly blocker: string;
  constructor(logicalKey: string, blocker: string, detail: string) {
    super(`plantilla "${logicalKey}" no lista: ${detail}`);
    this.name = "TemplateNotReadyError";
    this.logicalKey = logicalKey;
    this.blocker = blocker;
  }
}

export interface TemplateReadiness {
  ready: boolean;
  blocker: string | null;
  detail: string;
  mapping: ProviderMapping | null;
  verified: VerifiedTemplate | null;
}

/**
 * ¿Puede salir HOY un mensaje con esta clave lógica? La misma verdad que
 * usa el envío, para pintarla en salud/readiness sin duplicar lógica.
 */
export function getTemplateReadiness(logicalKey: string): TemplateReadiness {
  const mapping = getProviderMapping(logicalKey);
  if (!mapping) {
    return {
      ready: false,
      blocker: "TEMPLATE_MAPPING_MISSING",
      detail: `"${logicalKey}" no tiene mapping a ninguna plantilla real de la WABA (config/whatsapp-templates.json → provider_mappings)`,
      mapping: null,
      verified: null,
    };
  }
  const verified = getVerifiedTemplate(logicalKey);
  const bloquea = (blocker: string, detail: string): TemplateReadiness => ({ ready: false, blocker, detail, mapping, verified });
  // Deshabilitado a propósito: gana a CUALQUIER otra comprobación, incluida
  // una caché de verificación previa. Si el mapping se apagó es porque no hay
  // flujo que atienda la plantilla; que Meta la apruebe no la vuelve segura.
  if (mapping.enabled === false) {
    return bloquea(
      "TEMPLATE_MAPPING_DISABLED",
      `el mapping "${logicalKey}" → "${mapping.providerTemplate}" está DESHABILITADO a propósito${mapping.note ? `: ${mapping.note}` : ""}`
    );
  }
  if (!verified) {
    return bloquea(
      "FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED",
      `el mapping "${logicalKey}" → "${mapping.providerTemplate}" NO está verificado contra Meta: ejecuta npm run whatsapp:templates:doctor donde haya credenciales de la WABA`
    );
  }
  if (verified.provider !== mapping.providerTemplate || verified.language !== mapping.language) {
    return bloquea(
      "TEMPLATE_VERIFICATION_STALE",
      `la verificación cacheada es de "${verified.provider}"/${verified.language} pero el mapping apunta a "${mapping.providerTemplate}"/${mapping.language}: re-ejecuta el doctor`
    );
  }
  if (verified.status !== "APPROVED") {
    return bloquea(
      "FIRST_CONFIRMATION_TEMPLATE_NOT_APPROVED",
      `"${mapping.providerTemplate}" está en estado ${verified.status} en la WABA, no APPROVED`
    );
  }
  if (verified.paramCount !== mapping.params.length) {
    return bloquea(
      "TEMPLATE_ARITY_MISMATCH",
      `"${mapping.providerTemplate}" tiene ${verified.paramCount} variable(s) y el mapping envía ${mapping.params.length} (${mapping.params.join(", ")}): ajustar 'params' del mapping`
    );
  }
  const localButtons = resolveMappingSpec(mapping)?.buttons.length ?? 0;
  if (verified.buttonCount > 0 && verified.buttonCount !== localButtons) {
    return bloquea(
      "TEMPLATE_BUTTONS_MISMATCH",
      `"${mapping.providerTemplate}" tiene ${verified.buttonCount} botón(es) y el flujo local espera ${localButtons}: revisar payloads antes de activar`
    );
  }
  return { ready: true, blocker: null, detail: `"${mapping.providerTemplate}" (${mapping.language}) APPROVED · ${verified.paramCount} variable(s) · ${verified.buttonCount} botón(es)`, mapping, verified };
}

/**
 * Construye el mensaje con la plantilla REAL de la WABA para una clave
 * lógica. Lanza TemplateNotReadyError (con bloqueante y detalle) si el
 * mapping no está verificado y aprobado: el llamador decide cómo
 * visibilizarlo, pero NUNCA sale un nombre que Meta no conozca.
 *
 * `values` es el diccionario de variables del builder local; el mapping
 * elige cuáles y en qué orden van a la plantilla real.
 */
export function buildApprovedTemplateMessage(
  logicalKey: string,
  values: Record<string, string>
): Extract<OutboundWhatsAppMessage, { kind: "template" }> {
  const r = getTemplateReadiness(logicalKey);
  if (!r.ready || !r.mapping) {
    throw new TemplateNotReadyError(logicalKey, r.blocker ?? "TEMPLATE_NOT_READY", r.detail);
  }
  const params = r.mapping.params.map((k) => {
    const v = (values[k] ?? "").trim();
    if (!v) throw new TemplateNotReadyError(logicalKey, "TEMPLATE_PARAM_EMPTY", `la variable "${k}" llegó vacía: no se envía una plantilla con huecos`);
    return v;
  });
  const spec = getTemplateSpec(logicalKey);
  const buttonPayloads = (spec?.buttons ?? []).map((b) => b.payload);
  return {
    kind: "template",
    templateName: r.mapping.providerTemplate,
    language: r.mapping.language,
    bodyParams: params,
    buttonPayloads: r.verified && r.verified.buttonCount > 0 ? buttonPayloads.slice(0, r.verified.buttonCount) : [],
  };
}

/**
 * Advertencia operativa (T1 §2.6): la categoría del catálogo LOCAL dice lo
 * que DEBERÍA ser la plantilla, no lo que Meta aprobó de verdad — eso solo
 * se ve en WhatsApp Manager. Nunca se infiere por el nombre.
 */
export function templateCategoryWarning(name: string): string | null {
  const spec = getTemplateSpec(name);
  if (!spec) return `la plantilla "${name}" no está en el catálogo local`;
  if (spec.category !== "UTILITY") {
    return `la plantilla "${name}" está declarada como ${spec.category} en el catálogo local — para confirmaciones de pedido debe ser UTILITY`;
  }
  return `verificar en WhatsApp Manager que "${name}" está aprobada como UTILITY: el catálogo local declara la intención, no la aprobación real`;
}
