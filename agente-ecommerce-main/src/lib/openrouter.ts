import OpenAI from "openai";
import { buildSystemPrompt } from "./system-prompt";
import { toolDefinitions, executeTool } from "./tools";
import { insertUsage, getSetting } from "./db";
import type { Message } from "./db";

const MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

// Precios por millón de tokens (input, output) para estimar el coste.
const PRICING: Record<string, [number, number]> = {
  "anthropic/claude-haiku-4.5": [1, 5],
  "anthropic/claude-haiku-4-5": [1, 5],
  "openai/gpt-4o-mini": [0.15, 0.6],
  "openai/gpt-5-mini": [0.25, 2],
  "google/gemini-2.5-flash": [0.3, 2.5],
};

function costOf(model: string, inTok: number, outTok: number): number {
  const [pin, pout] = PRICING[model] ?? [0, 0];
  return (inTok / 1e6) * pin + (outTok / 1e6) * pout;
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === "") {
    throw new Error(
      "OPENROUTER_API_KEY no configurada. Ejecuta /setup en Claude Code o edita .env.local manualmente."
    );
  }
  _client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    // Una petición colgada no debe bloquear la respuesta minutos: 60s y 2
    // reintentos. Si aun así falla, el handler manda el aviso suave.
    timeout: 60_000,
    maxRetries: 2,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/whatsapp-ai-agent-kit",
      "X-Title": "WhatsApp AI Agent Kit",
    },
  });
  return _client;
}

interface GenerateReplyInput {
  history: Message[];
  conversationId: number;
  // Memoria de largo plazo de esta persona (Supabase). Vacío si es contacto
  // nuevo o si la memoria no está configurada.
  memoryContext?: string;
}

/**
 * Llama al LLM con el system prompt + el historial reciente.
 * Si el modelo decide ejecutar tools, las ejecuta y vuelve a llamar al LLM con los resultados.
 * Limite de 5 turnos para evitar loops infinitos.
 */
export async function generateReply(input: GenerateReplyInput): Promise<string> {
  const client = getClient();
  const systemPrompt = buildSystemPrompt(input.memoryContext);

  // Mapeo de roles: 'human' (mensajes del dashboard) → 'assistant' para el LLM
  // El LLM los ve como sus propias respuestas previas
  // baseMessages = system + conversación, SIN tool calls. messagesForLLM crece con
  // las tool calls y sus resultados; baseMessages se mantiene limpio para el
  // reintento de emergencia (forzar una respuesta normal sin herramientas).
  const baseMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...input.history.map((m): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
      return { role, content: m.content };
    }),
  ];
  const messagesForLLM: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...baseMessages];

  // Modelo y temperatura son editables en caliente desde el dashboard
  // (tabla settings); si no hay valor, caen al de la variable de entorno.
  const model = getSetting("model") || MODEL;
  const tempRaw = parseFloat(getSetting("temperature") || "");
  const temperature = Number.isFinite(tempRaw) ? Math.min(Math.max(tempRaw, 0), 1.5) : 0.4;

  const MAX_TURNS = 5;
  let turns = 0;
  let inTok = 0;
  let outTok = 0;
  let executedTool = false; // ¿se ejecutó alguna herramienta en este turno?
  // ÚLTIMO texto no vacío que escribió el modelo, venga solo o ACOMPAÑANDO a una
  // tool call. El prompt le pide saludar/responder en el MISMO turno en que llama
  // a guardarLead; ese texto ES la respuesta al lead y hay que devolverlo. El bug
  // era este: el modelo saludaba + llamaba la tool en el turno 1, el código tiraba
  // ese texto y esperaba uno nuevo en el turno 2, que venía vacío → aviso de emergencia.
  let textoEmitido = "";

  // Registra el consumo acumulado del turno (para el panel de métricas).
  const recordUsage = () => {
    if (inTok > 0 || outTok > 0) {
      try {
        insertUsage(input.conversationId, model, inTok, outTok, costOf(model, inTok, outTok));
      } catch {
        // el registro de métricas nunca debe romper la respuesta
      }
    }
  };

  // Reintento de emergencia: fuerza una respuesta normal (SIN herramientas) usando
  // solo la conversación limpia. Se usa cuando el modelo ejecutó tools pero no
  // escribió NADA de texto en ningún turno, para que el lead nunca quede sin respuesta.
  const respuestaLimpia = async (): Promise<string> => {
    try {
      const limpio = await client.chat.completions.create({
        model,
        messages: baseMessages,
        temperature,
      });
      if (limpio.usage) {
        inTok += limpio.usage.prompt_tokens ?? 0;
        outTok += limpio.usage.completion_tokens ?? 0;
      }
      return limpio.choices?.[0]?.message?.content?.trim() ?? "";
    } catch {
      return "";
    }
  };

  while (turns < MAX_TURNS) {
    turns++;

    const completion = await client.chat.completions.create({
      model,
      messages: messagesForLLM,
      tools: toolDefinitions,
      tool_choice: "auto",
      temperature,
    });

    if (completion.usage) {
      inTok += completion.usage.prompt_tokens ?? 0;
      outTok += completion.usage.completion_tokens ?? 0;
    }

    // OpenRouter a veces responde 200 con un cuerpo de error y sin choices.
    if (!completion.choices || completion.choices.length === 0) {
      const rescate = textoEmitido.trim() || (executedTool ? await respuestaLimpia() : "");
      recordUsage();
      return rescate;
    }

    const msg = completion.choices[0].message;

    // Captura SIEMPRE el texto que escriba el modelo, acompañe o no a una tool call.
    if (msg.content && msg.content.trim() !== "") textoEmitido = msg.content.trim();

    // Turno final: el modelo no pide ejecutar (más) herramientas.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Si el modelo ya dijo algo (ahora, o junto a una tool de un turno previo),
      // esa es la respuesta. Si NO dijo nada pese a usar tools, reintento limpio.
      const salida = textoEmitido.trim() || (executedTool ? await respuestaLimpia() : "");
      recordUsage();
      return salida;
    }

    // Hay tool calls: ejecutarlas y meter los resultados en la conversación.
    messagesForLLM.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      const name = call.function.name;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch {
        parsed = {};
      }

      const result = await executeTool(name, parsed, {
        conversationId: input.conversationId,
      });

      // Log de diagnóstico: qué tool llamó el modelo y con qué resultado.
      // Aparece en los logs del servidor para ver si guardarLead/Airtable falla.
      console.log(
        `[tool] ${name} → ok=${(result as { ok?: boolean }).ok} · ${
          (result as { message?: string }).message ?? ""
        }`
      );

      messagesForLLM.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
    executedTool = true;
  }

  // Límite de turnos: si el modelo escribió algo por el camino, úsalo; si no, neutro.
  recordUsage();
  return textoEmitido.trim() || "Déjame un momento — vuelvo contigo enseguida.";
}

/**
 * Llamada simple de texto (sin tools) al LLM. La usa el watchdog para auditar
 * conversaciones. No registra uso en métricas de venta (es coste interno).
 */
export async function completeText(
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number }
): Promise<string> {
  const client = getClient();
  const model = opts?.model || getSetting("model") || MODEL;
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts?.temperature ?? 0.3,
    max_tokens: opts?.maxTokens ?? 900,
  });
  return completion.choices?.[0]?.message?.content ?? "";
}

/**
 * Validador para /setup: hace una llamada mínima para comprobar que la API key funciona.
 * Devuelve true si la key es válida, false si no.
 */
export async function validateApiKey(): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getClient();
    await client.models.list();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
