import OpenAI from "openai";

// Clasifica las dudas/objeciones de los leads en temas, con un LLM.
// Se usa desde el panel de métricas (cacheado por día en la tabla insights).

export interface Duda {
  tema: string;
  count: number;
  pct: number;
  ejemplo?: string;
}

const MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";

export async function classifyDudas(mensajes: string[]): Promise<Duda[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || mensajes.length < 3) return [];

  // Limpiar y acotar para no gastar de más
  const muestra = mensajes
    .map((m) => m.replace(/\s+/g, " ").trim())
    .filter((m) => m.length > 2)
    .slice(0, 250);
  if (muestra.length < 3) return [];

  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });

  const prompt = `Eres analista de un funnel de ventas. Abajo hay ${muestra.length} mensajes que leads reales han escrito por WhatsApp al agente de un negocio.

Agrupa las DUDAS, OBJECIONES e INTENCIONES en 5-8 temas claros y accionables (por ejemplo: "Preguntan el precio", "Miedo a no ser capaces", "No saben si es para su nivel", "Formas de pago", "Quieren ver contenido gratis primero"...). Detecta también temas nuevos que no te he sugerido.

Devuelve SOLO un array JSON, sin texto alrededor, con esta forma:
[{"tema": "string corto", "count": number, "ejemplo": "cita textual breve de un mensaje"}]
"count" es cuántos de los mensajes caen en ese tema. Ordena de más a menos frecuente.

MENSAJES:
${muestra.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
    const text = res.choices[0]?.message?.content ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as Array<{ tema?: string; count?: number; ejemplo?: string }>;
    const total = muestra.length;
    return parsed
      .filter((d) => d.tema && typeof d.count === "number")
      .map((d) => ({
        tema: String(d.tema),
        count: d.count as number,
        pct: Math.round(((d.count as number) / total) * 100),
        ejemplo: d.ejemplo ? String(d.ejemplo).slice(0, 140) : undefined,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  } catch {
    return [];
  }
}
