import { getConversationById } from "./db";

// ============================================================
// Integración con el CRM de Airtable.
// Los leads del agente se registran en la tabla "🧲 Adquisición Leads"
// (la puerta de entrada del CRM), enlazados a la UTM "whatsapp - agente"
// para que la atribución (Campañas/Canal) funcione igual que el resto.
// UPSERT por "Contacto" (teléfono del chat) para no duplicar el registro
// aunque el agente guarde varias veces en la misma conversación.
// Añadido 2026-07-07. No forma parte del kit base.
//
// Config en .env.local:
//   AIRTABLE_API_KEY      Personal Access Token ("pat...")
//   AIRTABLE_BASE_ID      appXXXXXXXXXXXXXX
//   AIRTABLE_LEADS_TABLE  id de "🧲 Adquisición Leads" (tblXXXXXXXXXXXXXX)
//   AIRTABLE_AGENT_UTM    record de la UTM del agente (recXXXXXXXXXXXXXX)
//
// Requiere que exista en esa tabla el campo "📝 Notas Agente IA" (Long text).
// Si falta, el guardado degrada: reintenta sin notas para no perder el lead.
// ============================================================

const NOTES_FIELD = "📝 Notas Agente IA";

export function airtableConfigured(): boolean {
  return Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);
}

/** Teléfono del lead: el del propio chat de WhatsApp es la fuente de verdad. */
export function leadPhone(conversationId: number, fallback?: string): string {
  const convo = getConversationById(conversationId);
  return (convo?.phone || fallback || "").trim();
}

export interface LeadData {
  nombre?: string;
  email?: string;
  notas?: string;
}

export interface UpsertResult {
  ok: boolean;
  message: string;
}

function tableUrl(): string {
  const baseId = process.env.AIRTABLE_BASE_ID!;
  const table = process.env.AIRTABLE_LEADS_TABLE || "tblXXXXXXXXXXXXXX";
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
}
function authHeaders() {
  return { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" };
}

// Airtable no permite upsert nativo mezclando por un campo de teléfono, así que
// hacemos buscar-y-escribir: localizamos el registro por "Contacto" y, si existe,
// lo actualizamos; si no, lo creamos.
async function findRecordIdByPhone(phone: string): Promise<string | null> {
  const safe = phone.replace(/'/g, ""); // los teléfonos de WhatsApp no llevan comillas
  const url = `${tableUrl()}?maxRecords=1&filterByFormula=${encodeURIComponent(`{Contacto}='${safe}'`)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return null;
  const json = await res.json();
  return json.records?.[0]?.id ?? null;
}

async function writeRecord(fields: Record<string, unknown>, recordId: string | null): Promise<Response> {
  const url = recordId ? `${tableUrl()}/${recordId}` : tableUrl();
  return fetch(url, {
    method: recordId ? "PATCH" : "POST",
    headers: authHeaders(),
    body: JSON.stringify({ fields, typecast: true }),
  });
}

/**
 * Crea o actualiza el registro de captación del lead en "🧲 Adquisición Leads"
 * buscando por "Contacto". Enlaza la UTM del agente. Los campos vacíos se
 * omiten para no pisar datos de llamadas anteriores.
 */
export async function upsertLead(phone: string, data: LeadData): Promise<UpsertResult> {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    return { ok: false, message: "Airtable no configurado" };
  }
  if (!phone) return { ok: false, message: "No se puede guardar el lead sin teléfono" };

  const utm = process.env.AIRTABLE_AGENT_UTM || "recXXXXXXXXXXXXXX";
  const fields: Record<string, unknown> = { Contacto: phone, "🔗 UTMs": [utm] };
  if (data.nombre) fields["Lead"] = data.nombre;
  if (data.email) fields["Email"] = data.email;
  if (data.notas) fields[NOTES_FIELD] = data.notas;

  try {
    const recordId = await findRecordIdByPhone(phone);
    let res = await writeRecord(fields, recordId);

    // Si el campo de notas aún no existe, reintenta sin él para no perder el lead.
    if (!res.ok && NOTES_FIELD in fields) {
      const detail = await res.text();
      if (res.status === 422 && /unknown field name|📝|notas/i.test(detail)) {
        delete fields[NOTES_FIELD];
        res = await writeRecord(fields, recordId);
        if (res.ok) return { ok: true, message: "Lead guardado (sin notas: falta el campo '📝 Notas Agente IA')" };
      }
      return { ok: false, message: `Airtable ${res.status}: ${detail.slice(0, 160)}` };
    }

    if (!res.ok) return { ok: false, message: `Airtable ${res.status}: ${(await res.text()).slice(0, 160)}` };
    return { ok: true, message: recordId ? "Lead actualizado en Adquisición Leads" : "Lead creado en Adquisición Leads" };
  } catch (err) {
    return { ok: false, message: `Error Airtable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
