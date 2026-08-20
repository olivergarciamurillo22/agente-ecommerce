import type { ToolDefinition, ToolHandler } from "./index";

interface AgendarArgs {
  nombre: string;
  email?: string;
}

export const agendarDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "agendar",
    description:
      "Genera el link de agendamiento (Cal.com o Calendly) para enviar al lead. SOLO usar si calificar() devolvió score >= 7.",
    parameters: {
      type: "object",
      properties: {
        nombre: {
          type: "string",
          description: "Nombre del lead (para personalizar el link si se puede)",
        },
        email: {
          type: "string",
          description: "Email del lead si lo ha dado (opcional, pre-rellena el formulario)",
        },
      },
      required: ["nombre"],
    },
  },
};

export const agendarHandler: ToolHandler<AgendarArgs> = async (args) => {
  const baseUrl = process.env.CAL_BOOKING_URL;

  if (!baseUrl || baseUrl === "") {
    // TODO: Configurar CAL_BOOKING_URL en .env.local
    // Ejemplo: https://cal.com/tu-usuario/diagnostico
    // Guía: docs/04-configurar-tools.md
    return {
      ok: false,
      message:
        "Tool no configurada. El admin tiene que añadir CAL_BOOKING_URL en .env.local (ver docs/04-configurar-tools.md)",
    };
  }

  // Construir URL con parámetros si Cal.com lo soporta
  const url = new URL(baseUrl);
  url.searchParams.set("name", args.nombre);
  if (args.email) {
    url.searchParams.set("email", args.email);
  }

  return {
    ok: true,
    link: url.toString(),
    message: `Envía este link al lead para agendar: ${url.toString()}`,
  };
};
