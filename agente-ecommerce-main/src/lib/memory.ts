// ============================================================
// Memoria de largo plazo del agente (Supabase, vía REST — sin SDK).
//
// SQLite (data/messages.db) sigue siendo el almacén operativo que alimenta el
// panel en vivo. Supabase es la CAPA DE MEMORIA PERSISTENTE por persona: un
// registro por teléfono con quién es, qué busca y un resumen de lo hablado, de
// modo que si la misma persona vuelve a escribir dentro de 2 meses, el agente
// la reconoce y retoma la conversación.
//
// Todo aquí es best-effort y está BLINDADO: si Supabase no está configurado o
// falla, las funciones no lanzan ni bloquean — el bot responde igual, solo que
// sin memoria de largo plazo. Nunca debe romper una respuesta al lead.
// ============================================================

const URL = process.env.SUPABASE_URL?.replace(/\/+$/, "") || "";
const KEY = process.env.SUPABASE_SERVICE_KEY || "";

export interface LeadMemory {
  phone: string;
  name?: string | null;
  email?: string | null;
  objetivo?: string | null;
  situacion?: string | null;
  temperatura?: string | null;
  resumen?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
}

/** ¿Hay memoria de largo plazo configurada? (si no, todo es no-op seguro). */
export function memoryConfigured(): boolean {
  return Boolean(URL && KEY);
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** fetch contra la REST API de Supabase, con timeout y sin lanzar nunca. */
async function sb(
  pathAndQuery: string,
  init: RequestInit,
  timeoutMs = 4000
): Promise<Response | null> {
  if (!memoryConfigured()) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${URL}/rest/v1/${pathAndQuery}`, { ...init, signal: ctrl.signal });
  } catch {
    return null; // timeout, red caída, etc. — memoria degrada en silencio
  } finally {
    clearTimeout(t);
  }
}

/** Lee la memoria de una persona por teléfono. null si no existe o si falla. */
export async function getLeadMemory(phone: string): Promise<LeadMemory | null> {
  if (!phone) return null;
  const res = await sb(
    `lead_memory?phone=eq.${encodeURIComponent(phone)}&limit=1`,
    { method: "GET", headers: headers() }
  );
  if (!res || !res.ok) return null;
  const rows = (await res.json().catch(() => [])) as LeadMemory[];
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** Upsert crudo (merge por phone). Siempre refresca last_seen. */
async function upsertLeadMemory(phone: string, patch: Partial<LeadMemory>): Promise<void> {
  const clean: Record<string, unknown> = { phone, last_seen: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  await sb(`lead_memory?on_conflict=phone`, {
    method: "POST",
    headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(clean),
  });
}

/**
 * Actualiza la memoria conversacional tras CADA respuesta: refresca last_seen,
 * guarda el nombre de WhatsApp (solo si aún no hay uno confirmado por el agente)
 * y sobrescribe el resumen con lo último hablado. Así lead_memory nunca queda
 * vacío y el agente reconoce a quien vuelve, aunque el lead nunca dé sus datos.
 * Best-effort (se llama con void).
 */
export async function rememberConversation(
  phone: string,
  data: { waName?: string | null; resumen?: string }
): Promise<void> {
  if (!memoryConfigured() || !phone) return;
  const patch: Partial<LeadMemory> = {};
  if (data.resumen && data.resumen.trim()) patch.resumen = data.resumen.trim();
  if (data.waName && data.waName.trim()) {
    // No pisamos el nombre que haya confirmado el agente: solo rellenamos si falta.
    const cur = await getLeadMemory(phone);
    if (!cur?.name) patch.name = data.waName.trim();
  }
  await upsertLeadMemory(phone, patch); // upsert añade last_seen aunque patch venga vacío
}

/**
 * Guarda los datos ESTRUCTURADOS del lead que el agente ha confirmado
 * (nombre, email, objetivo, situación, temperatura). Lo llama guardarLead.
 * El resumen de lo hablado lo mantiene rememberConversation, no esto.
 */
export async function rememberLead(
  phone: string,
  facts: {
    name?: string;
    email?: string;
    objetivo?: string;
    situacion?: string;
    temperatura?: string;
  }
): Promise<void> {
  if (!memoryConfigured() || !phone) return;
  await upsertLeadMemory(phone, {
    name: facts.name,
    email: facts.email,
    objetivo: facts.objetivo,
    situacion: facts.situacion,
    temperatura: facts.temperatura,
  });
}

/** Registra un mensaje en el log histórico de Supabase (best-effort, no bloquea). */
export function logMessage(phone: string, role: string, content: string): void {
  if (!memoryConfigured() || !phone || !content) return;
  void sb(`message_log`, {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({ phone, role, content }),
  });
}

/**
 * Convierte la memoria en el bloque de texto que se inyecta en el system prompt.
 * Devuelve "" si no hay nada útil que recordar (contacto nuevo).
 */
export function memoryToPrompt(mem: LeadMemory | null, incluirResumen = false): string {
  if (!mem) return "";
  const datos: string[] = [];
  if (mem.name) datos.push(`Se llama ${mem.name}`);
  if (mem.email) datos.push(`email ${mem.email}`);
  if (mem.objetivo) datos.push(`objetivo: ${mem.objetivo}`);
  if (mem.situacion) datos.push(`situación: ${mem.situacion}`);
  if (mem.temperatura) datos.push(`temperatura: ${mem.temperatura}`);
  // El resumen (transcripción reciente) solo se inyecta cuando la persona VUELVE
  // tras un tiempo; en una charla en curso sería redundante con el historial.
  const resumen = incluirResumen && mem.resumen ? mem.resumen : "";
  if (datos.length === 0 && !resumen) return "";

  const lineas = [
    "## Lo que YA sabes de esta persona (de conversaciones anteriores)",
    "",
    "Esta persona ya ha hablado contigo antes. NO empieces de cero ni le pidas el nombre otra vez: salúdala por su nombre y retoma con naturalidad, como quien se reencuentra con un conocido.",
    "",
  ];
  if (datos.length) lineas.push(`Datos: ${datos.join(", ")}.`);
  if (resumen) lineas.push(`De lo último que hablasteis:\n${resumen}`);
  return lineas.join("\n");
}
