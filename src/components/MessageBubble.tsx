"use client";

interface MessageBubbleProps {
  role: "user" | "assistant" | "human";
  content: string;
  timestamp: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
  if (role === "user") {
    // Mensajes entrantes (el lead) → izquierda, superficie cálida
    return (
      <div className="flex justify-start mb-2.5">
        <div className="max-w-[75%] bg-brand-surface-2 border border-brand-border rounded-2xl rounded-bl-md px-4 py-2.5 shadow-sm">
          <div className="text-sm whitespace-pre-wrap text-brand-text/95">{content}</div>
          <div className="text-[10px] text-brand-muted mt-1">{formatTime(timestamp)}</div>
        </div>
      </div>
    );
  }

  // Salientes → derecha. IA en dorado tenue; humano en verde WhatsApp.
  const isAI = role === "assistant";
  return (
    <div className="flex justify-end mb-2.5">
      <div
        className={`max-w-[75%] rounded-2xl rounded-br-md px-4 py-2.5 shadow-sm border ${
          isAI
            ? "bg-brand-surface-2 border-brand-border-strong"
            : "bg-wa-green/10 border-wa-green/30"
        }`}
      >
        <div
          className={`text-[10px] uppercase tracking-wider font-bold mb-1 flex items-center gap-1.5 ${
            isAI ? "text-brand-gold" : "text-wa-green"
          }`}
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${isAI ? "bg-brand-gold" : "bg-wa-green"}`}
          />
          {isAI ? "Agente IA" : "Tú"}
        </div>
        <div className="text-sm whitespace-pre-wrap text-brand-text/95">{content}</div>
        <div className="text-[10px] text-brand-muted mt-1">{formatTime(timestamp)}</div>
      </div>
    </div>
  );
}
