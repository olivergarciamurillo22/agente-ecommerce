export type FreeTextIntent = "CANCELLATION_OR_REJECTION" | "NORMAL_DELIVERY_NOTE" | "UNKNOWN";

export function normalizeFreeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clasificación determinista y conservadora. No cancela nada: únicamente
 * detecta mensajes que deben saltarse cualquier captura automática y llegar
 * a una persona. Las raíces cubren flexiones y errores comunes sin exigir
 * una frase exacta.
 */
export function classifyFreeTextIntent(
  text: string,
  context: "general" | "delivery_note" = "general"
): FreeTextIntent {
  const n = normalizeFreeText(text);
  if (!n) return "UNKNOWN";
  const cancellation =
    /\b(cancel\w*|anul\w*)\b/.test(n) ||
    /\bno (?:lo |la )?quiero\b/.test(n) ||
    /\bno quiero (?:el |este |ningun )?pedido\b/.test(n) ||
    /\bsin mi permiso\b/.test(n) ||
    /\bpedido (?:por |de )?error\b/.test(n) ||
    /\b(?:equivocacion|me equivoque|se equivoco)\b/.test(n) ||
    /\bdevolv\w*\b/.test(n) ||
    /\bno me lo (?:envie\w*|mande\w*)\b/.test(n);
  if (cancellation) return "CANCELLATION_OR_REJECTION";
  return context === "delivery_note" ? "NORMAL_DELIVERY_NOTE" : "UNKNOWN";
}
