import { getMessages } from "./db";

// ============================================================
// Guardrails de seguridad (capa independiente del LLM).
// Valida lo que ENTRA (anti-flood, anti-coste) y lo que SALE (fugas del prompt,
// precios inventados, links no autorizados, promesas de ingresos) antes de
// tocar WhatsApp. La configuración específica de tu negocio (precios y dominios
// permitidos, canario) se lee de variables de entorno que /personaliza rellena
// a partir de tu negocio.md. Si no las configuras, el kit funciona igual, solo
// que con esos dos guardrails en modo permisivo.
// ============================================================

// Cadena única inyectada al final de prompts/negocio.md. Si aparece en una
// respuesta, el modelo está regurgitando su system prompt → se bloquea.
// Pon una tuya propia (SECURITY_CANARY); /setup te genera una aleatoria.
export const CANARY = process.env.SECURITY_CANARY || "CANARIO-KIT-CAMBIAME";

// Respuesta neutra que sustituye a cualquier salida bloqueada. Personalizable.
export const GUARD_FALLBACK =
  process.env.GUARD_FALLBACK_MSG ||
  "Eso no te lo puedo dar por aquí, pero encantado te ayudo con cualquier duda. ¿Qué te gustaría saber?";

const MAX_INPUT_CHARS = 1500; // se trunca, no se rechaza: un lead legítimo no escribe más
const MAX_USER_MSGS_PER_HOUR = 25; // por conversación; por encima = flood → modo HUMAN
const MAX_OUTPUT_CHARS = 1600; // permite 2-4 mensajes cortos; un volcado del prompt sería mucho mayor

// Únicas cifras que el agente puede pronunciar (los precios de tu negocio.md).
// Formato env: ALLOWED_PRICES="77,497,997". Vacío/no configurado = NO se
// comprueban precios (permisivo). Así el kit arranca sin configurar nada.
const PRECIOS_PERMITIDOS: Set<number> | null = parseAllowedPrices(process.env.ALLOWED_PRICES);

// Dominios que el agente puede enlazar. Formato: ALLOWED_HOSTS="tuweb.com,tienda.com".
// wa.me se permite siempre. Vacío/no configurado = NO se comprueban enlaces.
const HOSTS_PERMITIDOS: string[] | null = parseAllowedHosts(process.env.ALLOWED_HOSTS);

function parseAllowedPrices(raw?: string): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const nums = raw
    .split(",")
    .map((s) => parseInt(s.replace(/[^\d]/g, ""), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return nums.length ? new Set(nums) : null;
}

function parseAllowedHosts(raw?: string): string[] | null {
  if (!raw || !raw.trim()) return null;
  const hosts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  hosts.push("wa.me"); // WhatsApp siempre permitido
  return Array.from(new Set(hosts));
}

// Marcadores que jamás deben llegar a un lead: canario, restos de estructura
// del prompt, placeholders internos y secretos.
const MARCADORES_FUGA: RegExp[] = [
  new RegExp(CANARY, "i"),
  /\[PENDIENTE/i,
  /DATOS EDITABLES/i,
  /ESTADO_PLAZAS/i,
  /negocio\.md/i,
  /system prompt/i,
  /prompt del sistema/i,
  /mis instrucciones/i,
  /sk-or-/i,
  /OPENROUTER/i,
  /^##\s/m, // cabeceras markdown = volcado de secciones del prompt
];

// Promesas de resultados/ingresos que la marca tiene prohibidas.
// OJO: NO debe disparar con "garantía de 7 días" ni con "devolvemos el 100%"
// (por eso los patrones exigen una PALABRA de resultado —cliente/ingreso/…—,
// nunca una cifra suelta: "garantizo la devolución del 100%" debe pasar).
const PROMESAS_PROHIBIDAS: RegExp[] = [
  // garantiz… + (hasta 40 chars) + palabra de resultado ("garantizo tu primer cliente")
  /garantiz\w*[^.!?\n]{0,40}(cliente|ingres\w+|factur\w+|resultad\w+|ganar|gan[eé]\w*|rico)/i,
  // te aseguro/prometo/garantizo … resultado
  /te\s+(aseguro|prometo|garantizo)\b[^.!?\n]{0,40}(cliente|ingres\w+|factur\w+|resultad\w+|ganar)/i,
  // "ganarás 3000€", "vas a ganar 5000"
  /(ganar[áa]s|vas\s+a\s+ganar|te\s+aseguro\s+que\s+ganas)\s+[\d$€]/i,
  /ingresos\s+garantizados/i,
];

export interface InboundVerdict {
  allowed: boolean;
  text: string;
  reason?: string;
}

export interface OutboundVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Filtro de ENTRADA. Trunca mensajes desproporcionados (control de coste de
 * tokens) y corta el flood: más de MAX_USER_MSGS_PER_HOUR mensajes/hora en la
 * misma conversación se considera abuso o bucle → el handler la pasa a HUMAN.
 */
export function guardInbound(conversationId: number, rawText: string): InboundVerdict {
  let text = rawText.trim();

  if (text.length > MAX_INPUT_CHARS) {
    text = text.slice(0, MAX_INPUT_CHARS) + " …";
  }

  const unaHoraAtras = Math.floor(Date.now() / 1000) - 3600;
  const recientes = getMessages(conversationId, 2 * MAX_USER_MSGS_PER_HOUR + 10);
  const delUsuarioUltimaHora = recientes.filter(
    (m) => m.role === "user" && m.created_at >= unaHoraAtras
  ).length;

  if (delUsuarioUltimaHora >= MAX_USER_MSGS_PER_HOUR) {
    return { allowed: false, text, reason: `flood: ${delUsuarioUltimaHora} mensajes en 1h` };
  }

  return { allowed: true, text };
}

function extraerImportes(text: string): number[] {
  const importes: number[] = [];
  const patrones = [
    /\$\s?([\d.,]+)/g, // $77
    /([\d.,]+)\s?(?:d[óo]lares|usd)\b/gi, // 77 dólares / usd
    /([\d.,]+)\s?€/g, // 77€
    /€\s?([\d.,]+)/g, // €77
    /([\d.,]+)\s?euros?\b/gi, // 77 euros
    /(\d{2,}(?:[.,]\d{3})*)\s+al\s+(?:mes|a[ñn]o|d[íi]a)\b/gi, // "30 al mes" (2+ dígitos: evita "2 al día")
  ];
  for (const patron of patrones) {
    for (const m of text.matchAll(patron)) {
      // "2.994" y "2,994" son separadores de miles; "77" es directo
      const limpio = m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(/[.,]\d{1,2}$/, "");
      const n = parseInt(limpio, 10);
      if (!Number.isNaN(n) && n > 0) importes.push(n);
    }
  }
  return importes;
}

// Todos los números que aparecen en un texto (normalizados). Sirve para saber si
// una cifra ya la mencionó el lead: en ese caso el agente puede repetirla (p.ej.
// "los 1000 que ibas a cobrar a tu cliente") sin que se confunda con un precio.
function numerosEnTexto(text: string): Set<number> {
  const nums = new Set<number>();
  for (const m of text.matchAll(/\d[\d.,]*/g)) {
    const limpio = m[0].replace(/[.,](?=\d{3}\b)/g, "").replace(/[.,]\d{1,2}$/, "");
    const n = parseInt(limpio, 10);
    if (!Number.isNaN(n) && n > 0) nums.add(n);
  }
  return nums;
}

/**
 * Filtro de SALIDA. Si la respuesta del LLM contiene una fuga de prompt,
 * un precio no autorizado, un link fuera de la lista blanca, una promesa
 * de ingresos o un formato roto, se bloquea y el handler envía GUARD_FALLBACK.
 */
export function guardOutbound(text: string, contextoUsuario = ""): OutboundVerdict {
  if (text.length > MAX_OUTPUT_CHARS) {
    return { ok: false, reason: `salida demasiado larga (${text.length} chars)` };
  }

  for (const marcador of MARCADORES_FUGA) {
    if (marcador.test(text)) {
      return { ok: false, reason: `posible fuga de prompt (${marcador})` };
    }
  }

  // Precios: solo si has configurado ALLOWED_PRICES (si no, permisivo).
  if (PRECIOS_PERMITIDOS) {
    const numerosLead = contextoUsuario ? numerosEnTexto(contextoUsuario) : null;
    for (const importe of extraerImportes(text)) {
      if (!PRECIOS_PERMITIDOS.has(importe)) {
        // Si el lead ya mencionó esa cifra, el agente la está repitiendo (el precio
        // que cobró a un cliente, un presupuesto suyo…), no inventando uno: se permite.
        if (numerosLead && numerosLead.has(importe)) continue;
        return { ok: false, reason: `importe no autorizado: ${importe}` };
      }
    }
  }

  // Enlaces: solo si has configurado ALLOWED_HOSTS (si no, permisivo).
  if (HOSTS_PERMITIDOS) {
    for (const m of text.matchAll(/https?:\/\/([^\s/)»"'<>]+)[^\s)»"'<>]*/gi)) {
      const host = m[1].toLowerCase();
      if (!HOSTS_PERMITIDOS.some((h) => host === h || host.endsWith("." + h))) {
        return { ok: false, reason: `link fuera de lista blanca: ${host}` };
      }
    }
    // Enlaces SIN esquema http, que WhatsApp hace clicables igual ("paypal-x.com/pago").
    // Solo dominios con path (dominio.tld/algo) para no marcar emails ni menciones sueltas.
    const sinHttp = text.replace(/https?:\/\/\S+/gi, " ");
    for (const m of sinHttp.matchAll(/(?<![@\w])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\/\S/gi)) {
      const host = m[1].toLowerCase();
      if (!HOSTS_PERMITIDOS.some((h) => host === h || host.endsWith("." + h))) {
        return { ok: false, reason: `link sin esquema fuera de lista: ${host}` };
      }
    }
  }

  for (const promesa of PROMESAS_PROHIBIDAS) {
    if (promesa.test(text)) {
      return { ok: false, reason: "promesa de ingresos/resultados prohibida" };
    }
  }

  return { ok: true };
}
