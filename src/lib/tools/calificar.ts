import type { ToolDefinition, ToolHandler } from "./index";

// Calificación ligera del lead: ayuda al modelo a decidir cuánto empujar.
// NO escribe en el CRM (la
// temperatura resultante se guarda como nota vía guardarLead).
interface CalificarArgs {
  quiereMonetizarIA?: boolean;
  objetivoClaro?: boolean;
  aceptaModelo?: boolean;
  puedeDedicarTiempo?: boolean;
  urgenciaAlta?: boolean;
}

export const calificarDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "calificar",
    description:
      "Calcula un score 1-10 del lead para orientar cuánto empujar. Score >= 7 = caliente (empuja al cierre). Empezar desde cero NO resta: es el perfil normal. Usa la temperatura resultante al guardar el lead.",
    parameters: {
      type: "object",
      properties: {
        quiereMonetizarIA: {
          type: "boolean",
          description: "¿Quiere ganar dinero con la IA (primer cliente, ingreso extra, agencia, automatizar)?",
        },
        objetivoClaro: { type: "boolean", description: "¿Tiene un objetivo concreto, no solo curiosidad?" },
        aceptaModelo: { type: "boolean", description: "¿Acepta el modelo de $77/mes o pregunta cómo entrar?" },
        puedeDedicarTiempo: { type: "boolean", description: "¿Puede dedicar algunas horas a la semana?" },
        urgenciaAlta: { type: "boolean", description: "¿Quiere empezar ya?" },
      },
    },
  },
};

export const calificarHandler: ToolHandler<CalificarArgs> = async (args) => {
  let score = 0;
  if (args.quiereMonetizarIA) score += 4;
  if (args.aceptaModelo) score += 3;
  if (args.objetivoClaro) score += 2;
  if (args.puedeDedicarTiempo) score += 1;
  if (args.urgenciaAlta) score += 1;
  if (score > 10) score = 10;

  const temperatura = score >= 7 ? "Caliente" : score >= 4 ? "Templado" : "Frío";

  return {
    ok: true,
    score,
    temperatura,
    mensaje:
      score >= 7
        ? "Lead caliente. Empuja al cierre / envía el enlace de entrada. Guarda el lead con temperatura Caliente."
        : "Lead templado o frío. Resuelve su objeción antes de empujar; captura el lead igualmente con su temperatura.",
  };
};
