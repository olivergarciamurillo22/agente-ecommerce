// ============================================================
// TAXONOMÍA DE ERRORES — que "falló" diga QUÉ hacer.
//
// El problema: hoy un fallo llega al Control Center como una cadena suelta
// ("HTTP 401", "ECONNRESET", "localidad vacía"). Todas se pintan igual, así
// que Pedro no puede distinguir lo que se arregla solo de lo que necesita
// que alguien toque una credencial. Y el código tampoco: reintentar un 401
// eternamente es tan malo como no reintentar un timeout.
//
// La categoría responde a UNA pregunta: ¿quién y cuándo lo arregla?
// ============================================================

export type ErrorCategory =
  /** Transitorio. Reintentar solo lo arregla. Red, 5xx, timeouts. */
  | "retryable"
  /** Definitivo. Reintentar es gastar cupo: el resultado será el mismo. */
  | "non_retryable"
  /** Necesita un humano mirando ESTE caso concreto. */
  | "manual_review"
  /** Falta o sobra algo en el `.env`. Lo arregla Pedro, una vez, y afecta a todo. */
  | "configuration_error"
  /** Credencial inválida o caducada. También Pedro, y urge: nada funciona. */
  | "auth_error"
  /** Nos estamos pasando de peticiones. Se arregla esperando y bajando ritmo. */
  | "rate_limit"
  /** Los datos no valen (dirección incompleta, teléfono ausente). */
  | "validation_error"
  /** El tercero está mal o dice algo que no entendemos. No es culpa nuestra. */
  | "external_provider_error"
  /** Un fallo nuestro. Es un bug hasta que se demuestre lo contrario. */
  | "internal_error";

export const ERROR_CATEGORIES: ErrorCategory[] = [
  "retryable",
  "non_retryable",
  "manual_review",
  "configuration_error",
  "auth_error",
  "rate_limit",
  "validation_error",
  "external_provider_error",
  "internal_error",
];

/** ¿Tiene sentido volver a intentarlo solo? */
export function isRetryable(c: ErrorCategory): boolean {
  return c === "retryable" || c === "rate_limit";
}

/** ¿Tiene que verlo un humano sí o sí? */
export function needsHuman(c: ErrorCategory): boolean {
  return (
    c === "manual_review" ||
    c === "configuration_error" ||
    c === "auth_error" ||
    c === "internal_error"
  );
}

/** Qué severidad le corresponde en el feed de eventos. */
export function categorySeverity(c: ErrorCategory): "info" | "warning" | "critical" {
  if (c === "auth_error" || c === "configuration_error") return "critical";
  if (c === "retryable" || c === "rate_limit") return "info";
  return "warning";
}

/** Texto para Pedro. Sin jerga: dice qué pasa y de quién depende. */
export function categoryLabel(c: ErrorCategory): string {
  switch (c) {
    case "retryable":
      return "Fallo pasajero — se reintenta solo";
    case "non_retryable":
      return "No se puede reintentar";
    case "manual_review":
      return "Necesita que alguien lo mire";
    case "configuration_error":
      return "Falta configuración en el .env";
    case "auth_error":
      return "Credencial inválida o caducada";
    case "rate_limit":
      return "Demasiadas peticiones — se espera y se reintenta";
    case "validation_error":
      return "Datos del pedido incompletos o inválidos";
    case "external_provider_error":
      return "El proveedor ha respondido algo raro";
    case "internal_error":
      return "Fallo interno del agente";
  }
}

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  /** Cadena original, ya recortada. Nunca con PII. */
  raw: string;
}

/**
 * Clasifica un error de una fuente EXTERNA (HTTP a Shopify, Dropea, Retell).
 *
 * `status` manda sobre el texto cuando existe: un código HTTP es una señal
 * mucho más fiable que buscar palabras en un mensaje que el tercero puede
 * cambiar cualquier día.
 */
export function classifyHttpError(status: number | null, err?: unknown): ClassifiedError {
  const raw = (err instanceof Error ? err.message : err ? String(err) : "").slice(0, 300);

  if (status === 401 || status === 403) {
    return { category: "auth_error", message: `credencial rechazada (HTTP ${status})`, raw };
  }
  if (status === 429) {
    return { category: "rate_limit", message: "límite de peticiones alcanzado (HTTP 429)", raw };
  }
  if (status !== null && status >= 500) {
    return { category: "retryable", message: `el proveedor devolvió HTTP ${status}`, raw };
  }
  if (status === 404) {
    return { category: "non_retryable", message: "el recurso no existe (HTTP 404)", raw };
  }
  if (status === 422 || status === 400) {
    return { category: "validation_error", message: `datos rechazados (HTTP ${status})`, raw };
  }
  if (status !== null && status >= 400) {
    return { category: "external_provider_error", message: `respuesta inesperada (HTTP ${status})`, raw };
  }

  // Sin código: solo queda el texto. Se mira lo que es estable de verdad —
  // los códigos de error de red de Node, no frases traducibles.
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|aborted|timeout/i.test(raw)) {
    return { category: "retryable", message: "problema de red pasajero", raw };
  }
  if (/no configurad|not configured|missing .*(key|token|secret)|sin credenciales|falta .*(key|token|secreto)/i.test(raw)) {
    return { category: "configuration_error", message: "falta configuración", raw };
  }
  return { category: "external_provider_error", message: raw || "error sin detalle", raw };
}

/** Clasifica un error interno nuestro (no viene de un tercero). */
export function classifyInternalError(err: unknown): ClassifiedError {
  const raw = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  if (/no such table|no such column|SQLITE_|database is locked|readonly database/i.test(raw)) {
    return { category: "internal_error", message: "problema con la base de datos", raw };
  }
  return { category: "internal_error", message: raw || "error interno", raw };
}

/**
 * Clasifica un problema de DATOS de un pedido (dirección, teléfono, mapping).
 * Se separa de los anteriores porque el arreglo no es técnico: alguien tiene
 * que corregir el pedido o dar de alta un mapping.
 */
export function classifyOrderDataError(motivo: string): ClassifiedError {
  const raw = motivo.slice(0, 300);
  if (/mapping|sin asociaci|unmapped|mixed_supplier|no_items/i.test(raw)) {
    return { category: "manual_review", message: "el pedido necesita una decisión humana", raw };
  }
  return { category: "validation_error", message: "faltan datos del pedido", raw };
}
