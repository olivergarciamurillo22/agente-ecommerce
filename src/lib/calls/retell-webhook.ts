// ============================================================
// Verificación de la firma de los webhooks de Retell.
//
// CONTRATO OFICIAL (docs.retellai.com "Secure webhook" + fuente del SDK
// oficial `retell-sdk@5.64.0`, fichero `src/lib/webhook_auth.ts`, leída el
// 03-09-2026):
//
//   X-Retell-Signature: v={timestamp_ms},d={hmac_sha256_hex}
//   digest = HMAC-SHA256(clave, raw_body + String(Number(timestamp)))
//   ventana de frescura: 5 minutos en valor absoluto
//   el digest son EXACTAMENTE 64 caracteres hex
//
// LA CLAVE NO ES CUALQUIERA. Las palabras de la documentación oficial:
// «Only the API key that has a webhook badge next to it can be used to
// verify the webhook». Una cuenta de Retell puede tener varias API keys y
// SOLO la que lleva el distintivo "webhook" firma los webhooks salientes.
// Firmar y verificar en local con otra key cuadra siempre (misma clave a
// los dos lados) y aun así TODAS las firmas reales fallan. Esa es la causa
// del incidente de producción del 03-09.
//
// POR QUÉ NO SE IMPORTA EL SDK: `retell-sdk` es el cliente completo de la
// API y aquí sólo se necesitan estas ~30 líneas. Añadir una dependencia de
// ejecución al contenedor del NAS (reconstrucción + superficie de
// suministro) no se justifica para reimplementar un HMAC que se ha
// contrastado línea a línea con la fuente del proveedor. El test
// "RETELL · firma: vectores del algoritmo oficial" fija esa equivalencia.
// ============================================================

import crypto from "node:crypto";

export const RETELL_SIGNATURE_MAX_AGE_MS = 5 * 60_000;
const SHA_256_HEX_LENGTH = 64;
/** Igual que el SDK: cabecera COMPLETA, sin espacios alrededor. */
const SIGNATURE_RE = /^v=(\d+),d=([0-9a-f]+)$/i;

export type RetellSignatureFailure =
  | "no_key"
  | "no_signature"
  | "malformed_header"
  | "bad_digest_format"
  | "timestamp_out_of_window"
  | "digest_mismatch";

export interface RetellSignatureResult {
  valid: boolean;
  /** Por qué falló. `null` si la firma es válida. */
  reason: RetellSignatureFailure | null;
}

/** Comparación en tiempo constante sobre cadenas de igual longitud. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifica la firma contra el cuerpo EXACTO recibido (el `await req.text()`
 * previo a cualquier JSON.parse: re-serializar cambia bytes y la firma deja
 * de valer, que es justo lo que debe pasar).
 */
export function verifyRetellWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  apiKey: string,
  nowMs: number = Date.now()
): RetellSignatureResult {
  if (!apiKey) return { valid: false, reason: "no_key" };
  if (!signatureHeader) return { valid: false, reason: "no_signature" };

  const m = SIGNATURE_RE.exec(signatureHeader);
  if (!m) return { valid: false, reason: "malformed_header" };

  const digestRecibido = m[2];
  if (digestRecibido.length !== SHA_256_HEX_LENGTH) {
    return { valid: false, reason: "bad_digest_format" };
  }

  // El SDK hace `input + poststamp` con poststamp YA convertido a número:
  // se replica la conversión para no diferir en cabeceras con ceros a la
  // izquierda o valores fuera del rango entero seguro.
  const poststamp = Number(m[1]);
  if (!Number.isSafeInteger(poststamp)) return { valid: false, reason: "malformed_header" };
  if (Math.abs(nowMs - poststamp) > RETELL_SIGNATURE_MAX_AGE_MS) {
    return { valid: false, reason: "timestamp_out_of_window" };
  }

  const esperado = crypto.createHmac("sha256", apiKey).update(rawBody + poststamp).digest("hex");
  return safeEqualHex(esperado, digestRecibido.toLowerCase())
    ? { valid: true, reason: null }
    : { valid: false, reason: "digest_mismatch" };
}

/**
 * Descripción SEGURA de la cabecera, para diagnosticar sin filtrar nada.
 * Nunca incluye el digest (permitiría atacar offline) ni la clave.
 * `trimWouldChange` existe porque un proxy que añada espacios rompería la
 * verificación de forma invisible: mejor verlo que aceptarlo en silencio.
 */
export function describeRetellSignature(signatureHeader: string | null | undefined): {
  present: boolean;
  length: number;
  startsWithV: boolean;
  timestampPresent: boolean;
  digestPresent: boolean;
  digestLength: number;
  digestCharset: "hex" | "other" | "n/a";
  commaCount: number;
  trimWouldChange: boolean;
} {
  if (!signatureHeader) {
    return {
      present: false,
      length: 0,
      startsWithV: false,
      timestampPresent: false,
      digestPresent: false,
      digestLength: 0,
      digestCharset: "n/a",
      commaCount: 0,
      trimWouldChange: false,
    };
  }
  const partes = signatureHeader.split(",");
  const v = partes.find((p) => p.trim().startsWith("v="))?.trim().slice(2) ?? "";
  const d = partes.find((p) => p.trim().startsWith("d="))?.trim().slice(2) ?? "";
  return {
    present: true,
    length: signatureHeader.length,
    startsWithV: signatureHeader.startsWith("v="),
    timestampPresent: /^\d+$/.test(v),
    digestPresent: d.length > 0,
    digestLength: d.length,
    digestCharset: d.length === 0 ? "n/a" : /^[0-9a-f]+$/i.test(d) ? "hex" : "other",
    commaCount: (signatureHeader.match(/,/g) ?? []).length,
    trimWouldChange: signatureHeader !== signatureHeader.trim(),
  };
}

/** Firma un cuerpo con el MISMO algoritmo (tests y ensayos, jamás producción). */
export function signRetellWebhookForTests(rawBody: string, apiKey: string, timestampMs: number = Date.now()): string {
  const digest = crypto.createHmac("sha256", apiKey).update(rawBody + timestampMs).digest("hex");
  return `v=${timestampMs},d=${digest}`;
}
