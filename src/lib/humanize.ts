// ============================================================
// Humanización de las respuestas del agente.
// 1) saneaHumano: quita los símbolos que delatan a una IA y que en WhatsApp
//    se ven raros o ni se renderizan (guiones largos, negritas markdown,
//    comillas tipográficas, viñetas, "…"). Escribe como una persona en el móvil.
// 2) dividirMensajes: parte la respuesta en varios mensajes cuando el modelo
//    lo indica con "|||", para adaptarse a quien escribe a ráfagas.
// Añadido 2026-07-07. No forma parte del kit base.
// ============================================================

// Separador que el modelo usa para indicar "esto va en mensajes separados".
export const MSG_SEP = "|||";

const MAX_MENSAJES = 5; // tope de seguridad: nunca spamear con más trozos

/**
 * Limpia una cadena para que suene a persona escribiendo por WhatsApp.
 * No toca enlaces ni emails (no contienen estos símbolos).
 */
export function saneaHumano(text: string): string {
  let t = text;

  // Guiones largos/medios → coma (inciso natural en español)
  t = t.replace(/\s*[—–]\s*/g, ", ");
  // Flechas (restos de estructura del prompt) → espacio
  t = t.replace(/\s*[→←➡️]\s*/g, " ");
  // Viñetas centradas / backticks → fuera
  t = t.replace(/[·•`]/g, "");
  // Negrita/cursiva markdown (** o *): el texto sí, los asteriscos no
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*\n]+)\*/g, "$1");
  // Encabezados o restos markdown al principio de línea
  t = t.replace(/^\s*#{1,6}\s*/gm, "");
  // Viñetas al inicio de línea (-, •, *) → nada
  t = t.replace(/^\s*[-•*]\s+/gm, "");
  // Comillas tipográficas → rectas (por punto de código, para no depender del literal)
  t = t.replace(/[“”„‟«»]/g, '"').replace(/[‘’‚‛]/g, "'");
  // Puntos suspensivos elegantes → tres puntos de teclado
  t = t.replace(/…/g, "...");
  // Comas duplicadas por la sustitución de guiones
  t = t.replace(/\s+,/g, ",").replace(/,\s*,/g, ",");
  // Espacios múltiples y limpieza por línea
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t
    .split("\n")
    .map((l) => l.trim())
    .join("\n");
  // Colapsar 3+ saltos de línea a 2
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

/**
 * Divide la respuesta en varios mensajes usando el separador MSG_SEP.
 * Cada trozo se sanea. Si no hay separador, devuelve un único mensaje.
 * Respeta un máximo: los trozos sobrantes se unen al último.
 */
export function dividirMensajes(text: string): string[] {
  const bruto = text
    .split(MSG_SEP)
    .map((p) => saneaHumano(p))
    .filter((p) => p.length > 0);

  if (bruto.length <= 1) return bruto.length === 1 ? bruto : [saneaHumano(text)].filter(Boolean);

  if (bruto.length > MAX_MENSAJES) {
    const cabeza = bruto.slice(0, MAX_MENSAJES - 1);
    const resto = bruto.slice(MAX_MENSAJES - 1).join(" ");
    return [...cabeza, resto];
  }
  return bruto;
}

/**
 * Retardo (ms) para simular que se escribe el mensaje: proporcional a su
 * longitud, con un mínimo y un máximo razonables para no aburrir.
 */
export function delayEscritura(mensaje: string): number {
  return Math.min(700 + mensaje.length * 30, 3500);
}
