import type { ToolDefinition, ToolHandler } from "./index";
import { setMode } from "../db";

interface DerivarHumanoArgs {
  conversationId: number;
  razon: string;
}

export const derivarHumanoDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "derivarHumano",
    description:
      "Cambia la conversación a modo HUMAN. Úsala cuando el lead pida algo que no puedes resolver: precios específicos, casos raros, quejas, peticiones fuera del scope. La conversación queda silenciada para el bot y aparece destacada en el dashboard para que un humano responda.",
    parameters: {
      type: "object",
      properties: {
        razon: {
          type: "string",
          description: "Por qué se deriva. Útil para el humano que va a tomar la conversación.",
        },
      },
      required: ["razon"],
    },
  },
};

export const derivarHumanoHandler: ToolHandler<DerivarHumanoArgs> = async (args) => {
  if (!args.conversationId) {
    return {
      ok: false,
      message: "No se pudo derivar: falta conversationId (bug del wrapper de tools)",
    };
  }

  setMode(args.conversationId, "HUMAN");

  return {
    ok: true,
    message: `Conversación derivada a HUMAN. Razón: ${args.razon}`,
    instruccion:
      "Responde al usuario con algo como: 'Voy a derivarte con un compañero. Te responderá lo antes posible.' No respondas más en esta conversación.",
  };
};
