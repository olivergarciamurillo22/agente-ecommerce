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
