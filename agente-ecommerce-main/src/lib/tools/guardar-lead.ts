import type { ToolDefinition, ToolHandler } from "./index";
import { upsertLead, leadPhone, airtableConfigured } from "../airtable";
import { rememberLead, getLeadMemory } from "../memory";

// Registra el lead en el CRM (Airtable, tabla de leads).
// El teléfono NO lo rellena el modelo: se toma del chat. El objetivo,
// situación y temperatura se vuelcan en la nota del agente.
interface GuardarLeadArgs {
  nombre?: string;
  email?: string;
  objetivo?: string;
  situacion?: string;
  temperatura?: string;
  notas?: string;
  conversationId?: number;
}

// Formato de email razonable (el modelo detecta los typos plausibles; esto
// solo frena basura claramente rota antes de escribir al CRM).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Nombres genéricos que el modelo inventa cuando no sabe el nombre real: no los guardamos.
const NOMBRE_PLACEHOLDER = /^(lead|usuario|cliente|contacto|desconocido|no proporcionado|none|n\/a|-)$/i;

export const guardarLeadDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "guardarLead",
    description:
      "Registra lo que vas sabiendo del lead. LLÁMALA cada vez que consigas un dato nuevo (nombre, email, objetivo, situación), aunque aún te falten otros, y CUANDO llames con el email incluye también el nombre si ya lo sabes. El lead solo entra en el CRM de ventas cuando ya tienes AL MENOS nombre Y email; hasta entonces la herramienta solo toma nota (no aparecerá en el CRM). Por eso tu misión es conseguir de forma natural, sin interrogar, el nombre y el email. Decir que lo guardas NO lo guarda: solo esta herramienta lo hace. El teléfono se toma del chat. Nunca inventes el nombre ni el email.",
    parameters: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre REAL del lead si lo sabes. Si no lo sabes, deja vacío (no inventes 'Lead' ni 'Usuario')" },
        email: { type: "string", description: "Email del lead (pídelo; debe ser real y bien escrito)" },
        objetivo: {
          type: "string",
          description: "Qué busca: 'Primer cliente', 'Ingreso extra', 'Montar agencia' o 'Automatizar su negocio'",
        },
        situacion: { type: "string", description: "'Desde cero' o 'Ya tiene negocio'" },
        temperatura: { type: "string", description: "'Caliente', 'Templado' o 'Frío' según interés y encaje" },
        notas: { type: "string", description: "Dolor, dudas u objeciones relevantes del lead" },
      },
      required: [],
    },
  },
};

export const guardarLeadHandler: ToolHandler<GuardarLeadArgs> = async (args) => {
  const phone = leadPhone(args.conversationId ?? 0);

  // Validación de email: si viene y está roto, no lo damos por bueno y pedimos otro.
  let email = args.email?.trim();
  let emailAviso = "";
  if (email && !EMAIL_RE.test(email)) {
    emailAviso = ` El email "${email}" no parece válido: pídeselo de nuevo bien escrito.`;
    email = undefined;
  }

  // Nombre real solamente: descartamos los genéricos que el modelo inventa.
  const nombre = args.nombre && !NOMBRE_PLACEHOLDER.test(args.nombre.trim()) ? args.nombre.trim() : undefined;
  const objetivo = args.objetivo?.trim() || undefined;
  const situacion = args.situacion?.trim() || undefined;
  const temperatura = args.temperatura?.trim() || undefined;

  // 1) La MEMORIA de largo plazo (Supabase) guarda los datos estructurados
  //    confirmados. Captura a TODO el mundo desde el primer dato. Best-effort.
  //    (El resumen de lo hablado lo mantiene el handler tras cada respuesta.)
  void rememberLead(phone, { name: nombre, email, objetivo, situacion, temperatura });

  // Estado ACUMULADO: lo de este turno + lo que ya supiéramos de turnos anteriores
  // (de la memoria). Así el CRM se completa aunque el nombre llegara en un mensaje
  // y el email en otro. Si no hay memoria configurada, mem es null y solo cuenta
  // lo de este turno.
  let mem: Awaited<ReturnType<typeof getLeadMemory>> = null;
  try {
    mem = await getLeadMemory(phone);
  } catch {
    mem = null;
  }
  const nombreFinal = nombre || mem?.name || undefined;
  const emailFinal = email || mem?.email || undefined;

  // 2) CRM de ventas (Airtable): SOLO se registra cuando ya hay nombre Y email.
  //    Antes de eso no ensuciamos el CRM: solo queda tomado nota en la memoria.
  if (!nombreFinal || !emailFinal) {
    const faltan = [!nombreFinal && "el nombre", !emailFinal && "el email"].filter(Boolean).join(" y ");
    return {
      ok: true,
      guardadoEnCRM: false,
      message: `Anotado. Todavía NO registro este lead en el CRM porque falta ${faltan}. Consíguelo de forma natural en la conversación; en cuanto lo tengas y me vuelvas a llamar, entra solo.${emailAviso}`,
      ...(emailAviso ? { pedirEmail: true } : {}),
    };
  }

  if (!airtableConfigured()) {
    return { ok: false, message: "CRM (Airtable) no configurado. Añade AIRTABLE_* en .env.local." };
  }

  // Componer la nota del CRM con lo cualitativo acumulado (de este turno o memoria).
  const notaPartes = [
    (objetivo || mem?.objetivo) && `Objetivo: ${objetivo || mem?.objetivo}`,
    (situacion || mem?.situacion) && `Situación: ${situacion || mem?.situacion}`,
    (temperatura || mem?.temperatura) && `Temperatura: ${temperatura || mem?.temperatura}`,
    args.notas?.trim() && `Notas: ${args.notas.trim()}`,
  ].filter(Boolean);
  const notas = notaPartes.length ? notaPartes.join(" · ") : undefined;

  const res = await upsertLead(phone, { nombre: nombreFinal, email: emailFinal, notas });

  return {
    ok: res.ok,
    guardadoEnCRM: res.ok,
    message: (res.ok ? "Lead registrado en el CRM (nombre + email). " : "") + res.message + emailAviso,
    ...(emailAviso ? { pedirEmail: true } : {}),
  };
};
