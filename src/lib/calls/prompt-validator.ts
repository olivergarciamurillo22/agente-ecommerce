// ============================================================
// VALIDADOR DEL PROMPT DE RETELL — que el incidente de la v5 no se repita.
//
// Lo que pasó con la v5: el prompt llevaba marcadores que el contrato de
// variables no producía, el agente los LEYÓ EN VOZ ALTA al cliente
// (incluido un "| dígito a dígito" que el modelo interpretó como filtro de
// plantilla), y aceptó confirmaciones de datos que nunca había pronunciado.
//
// Este validador se pasa ANTES de pegar un prompt nuevo en Retell:
//
//   npm run calls:validate-prompt -- ruta/al/prompt.txt
//
// La fuente de verdad del contrato es src/lib/calls/payload.ts: lo que
// buildCallVariables() produce es EXACTAMENTE lo que el prompt puede usar.
// ============================================================

/** Las variables que el payload de llamada produce — y ninguna más.
 *  Copia CONSCIENTE de las claves de buildCallVariables (payload.ts); el
 *  test de contrato verifica que ambas listas coinciden, así que si alguien
 *  añade una variable allí sin tocarla aquí, la suite lo dice. */
export const ALLOWED_PROMPT_VARIABLES = [
  "nombre_cliente",
  "producto",
  "unidades",
  "importe_total",
  "direccion",
  "localidad",
  "codigo_postal",
  "telefono",
  "fecha_pedido",
  "numero_pedido",
  "current_datetime",
] as const;

export interface PromptIssue {
  kind:
    | "unknown_placeholder" // {{algo}} que el payload no produce
    | "single_brace" // {variable} — Retell no lo sustituye, se lee en voz alta
    | "bracket_placeholder" // [variable] — ídem
    | "template_filter" // {{var | filtro}} — el modelo lo lee como texto
    | "empty_placeholder" // {{}} — hueco sin variable
    | "password_residue" // "password" en el texto (incidente [password 1])
    | "missing_required_variable" // el prompt no usa una variable obligatoria
    | "false_promise"; // promete una mutación que el backend no hace
  detail: string;
}

/** Variables que el prompt DEBE referenciar: sin ellas, la llamada no puede
 *  cumplir su función (saludar, identificar el pedido, confirmar dirección
 *  e importe). El resto son opcionales. */
export const REQUIRED_PROMPT_VARIABLES = [
  "nombre_cliente",
  "producto",
  "importe_total",
  "direccion",
  "localidad",
  "codigo_postal",
] as const;

export interface PromptValidation {
  ok: boolean;
  issues: PromptIssue[];
  /** Variables del contrato que el prompt usa (informativo). */
  used: string[];
}

/**
 * Valida los marcadores de un prompt contra el contrato de variables.
 * Determinista y de solo texto: no llama a Retell ni a nada.
 */
export function validatePromptPlaceholders(prompt: string): PromptValidation {
  const issues: PromptIssue[] = [];
  const used = new Set<string>();
  const allowed = new Set<string>(ALLOWED_PROMPT_VARIABLES);

  // {{ ... }} — el formato correcto de Retell.
  for (const m of prompt.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const dentro = m[1].trim();
    if (!dentro) {
      issues.push({ kind: "empty_placeholder", detail: '"{{}}" vacío: un hueco sin variable se lee tal cual' });
      continue;
    }
    if (dentro.includes("|")) {
      issues.push({
        kind: "template_filter",
        detail: `"{{${dentro}}}": los filtros tipo "| algo" no existen en Retell — el modelo los LEE EN VOZ ALTA (pasó en la v5)`,
      });
      continue;
    }
    if (!allowed.has(dentro)) {
      issues.push({
        kind: "unknown_placeholder",
        detail: `"{{${dentro}}}" no existe en el contrato de payload.ts: llegaría vacío o se leería tal cual`,
      });
    } else {
      used.add(dentro);
    }
  }

  // { variable } con UNA llave: Retell no lo sustituye.
  for (const m of prompt.matchAll(/(?<!\{)\{\s*([a-z_][a-z0-9_]*)\s*\}(?!\})/gi)) {
    issues.push({
      kind: "single_brace",
      detail: `"{${m[1]}}" con una sola llave: Retell no lo sustituye y el agente lo pronunciaría tal cual`,
    });
  }

  // [variable] — otro formato que no existe.
  for (const m of prompt.matchAll(/\[([a-z_][a-z0-9_]*)\]/gi)) {
    // Cualquier snake_case entre corchetes es un marcador fallido casi
    // seguro (en prosa normal nadie escribe [fecha_entrega]); y las palabras
    // del dominio, aunque no lleven guion bajo.
    if (allowed.has(m[1]) || m[1].includes("_") || /variable|nombre|producto|importe|direccion/i.test(m[1])) {
      issues.push({
        kind: "bracket_placeholder",
        detail: `"[${m[1]}]" entre corchetes: no es un marcador válido, se leería en voz alta`,
      });
    }
  }

  // "password" en cualquier parte: el incidente real fue el agente diciendo
  // "¿Hablo con [password 1]?" — residuo de autorrelleno en el dashboard.
  for (const m of prompt.matchAll(/password[\s_-]*\d*/gi)) {
    issues.push({ kind: "password_residue", detail: `contiene "${m[0]}": residuo de autorrelleno — EL incidente del 02-09` });
  }

  // Promesas falsas: el backend solo REGISTRA la solicitud de cancelación
  // (cancel_request); el agente no puede decir que cancela él.
  if (/lo cancelo ahora mismo|cancelo tu pedido ahora|queda cancelado ya/i.test(prompt)) {
    issues.push({
      kind: "false_promise",
      detail: 'promete "lo cancelo ahora mismo": el backend solo registra la solicitud — usar "dejo solicitada la cancelación"',
    });
  }

  // Variables obligatorias sin referenciar: el guion no puede funcionar.
  for (const req of REQUIRED_PROMPT_VARIABLES) {
    if (!used.has(req)) {
      issues.push({ kind: "missing_required_variable", detail: `el prompt no usa {{${req}}}: la llamada no puede ${req === "nombre_cliente" ? "saludar" : "confirmar"} sin ella` });
    }
  }

  return { ok: issues.length === 0, issues, used: [...used].sort() };
}
