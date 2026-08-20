import {
  guardarLeadDefinition,
  guardarLeadHandler,
} from "./guardar-lead";
import {
  calificarDefinition,
  calificarHandler,
} from "./calificar";
// agendar NO se registra: el kit de serie cierra por chat, sin agendar llamadas.
// El enlace de reserva (Cal.com/Calendly) se comparte por la sección de Enlaces
// de prompts/negocio.md. El archivo agendar.ts se conserva por si tu negocio
// necesita esa herramienta: regístrala aquí y rellena CAL_BOOKING_URL.
import { insertToolEvent } from "../db";
// derivarHumano NO se registra: el agente de serie cierra por chat y los avisos
// al dueño van por el watchdog (variable ALERT_WHATSAPP, ver docs/10). El
// archivo derivar-humano.ts se conserva por si quieres reactivar la derivación
// registrándola aquí.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ============================================================
// Tipos compartidos
// ============================================================

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

// El handler de cada tool define sus propios argumentos.
// Aquí trabajamos con un wrapper que acepta unknown args (los validamos al entrar).
export type ToolHandler<TArgs = Record<string, unknown>> = (
  args: TArgs & { conversationId?: number }
) => Promise<Record<string, unknown>>;

// ============================================================
// Registry — usamos wrappers que aceptan unknown y delegan a los handlers tipados
// ============================================================

export const toolDefinitions: ToolDefinition[] = [
  guardarLeadDefinition,
  calificarDefinition,
];

type GenericHandler = (
  args: Record<string, unknown> & { conversationId?: number }
) => Promise<Record<string, unknown>>;

const handlers: Record<string, GenericHandler> = {
  guardarLead: (args) =>
    guardarLeadHandler(args as unknown as Parameters<typeof guardarLeadHandler>[0]),
  calificar: (args) =>
    calificarHandler(args as unknown as Parameters<typeof calificarHandler>[0]),
};

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { conversationId: number }
): Promise<Record<string, unknown>> {
  const handler = handlers[toolName];
  if (!handler) {
    return { ok: false, message: `Tool desconocida: ${toolName}` };
  }

  // El teléfono real del lead es el del propio chat de WhatsApp. Los modelos
  // tienden a inventarlo o dejarlo vacío; por eso guardarLead/calificar lo
  // toman del conversationId (ver leadPhone en airtable.ts), nunca de los args.
  // Un fallo DENTRO de una tool nunca debe dejar al bot sin responder: se captura
  // y se devuelve como resultado controlado para que el modelo siga la charla.
  let result: Record<string, unknown>;
  try {
    result = await handler({ ...args, conversationId: context.conversationId });
  } catch (err) {
    return {
      ok: false,
      message: `La herramienta ${toolName} falló (${
        err instanceof Error ? err.message : String(err)
      }). Continúa la conversación con normalidad; no menciones este error al lead.`,
    };
  }

  // Registro para métricas (leads y embudo). Nunca debe romper la ejecución.
  if (result?.ok !== false) {
    try {
      const hasEmail = toolName === "guardarLead" && EMAIL_RE.test(String(args.email ?? ""));
      insertToolEvent(context.conversationId, toolName, hasEmail);
    } catch {
      // ignorar fallos de métricas
    }
  }

  return result;
}
