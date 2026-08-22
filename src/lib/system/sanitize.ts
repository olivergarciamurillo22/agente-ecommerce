// ============================================================
// Sanitizador de textos que van a persistirse en observabilidad
// (integration_events, service_health.last_error_message, metadata).
//
// Estas tablas se muestran en el dashboard y en la CLI, y podrían acabar
// en un pantallazo o en un log compartido. Por eso aquí se BORRA, no se
// confía: teléfonos enmascarados, emails fuera, cualquier cosa con pinta
// de token o clave fuera, y longitud acotada (un payload entero de webhook
// jamás debe caber en un mensaje de evento).
// ============================================================

const MAX_LEN = 300;

/** Con pinta de secreto: Bearer, shpat_/shpss_/shpca_, JWT, hex/base64 largos. */
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /shp(?:at|ss|ca)_[A-Za-z0-9]+/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.?[A-Za-z0-9_-]*/g, // JWT
  /\b[A-Fa-f0-9]{32,}\b/g, // hex largo (HMAC, api keys)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // base64 largo
  /(?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*\S+/gi,
];

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;

/** Secuencias de 9+ dígitos (teléfonos, DNI…): se enmascaran, no se borran,
 *  porque "34XXXXXX95" aún deja depurar sin exponer a nadie. */
const LONG_DIGITS = /\d[\d\s.-]{7,}\d/g;

function maskDigits(seq: string): string {
  const digits = seq.replace(/\D/g, "");
  if (digits.length < 9) return seq; // importes, ids cortos: se dejan
  return `${digits.slice(0, 2)}${"X".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/**
 * Deja un texto apto para guardarse y enseñarse. Idempotente.
 */
export function sanitizeForEvents(text: string): string {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[oculto]");
  out = out.replace(EMAIL, "[email]");
  out = out.replace(LONG_DIGITS, maskDigits);
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_LEN) out = `${out.slice(0, MAX_LEN - 1)}…`;
  return out;
}
