"use client";

// ============================================================
// Burbuja de mensaje con el aspecto de WhatsApp REAL: entrante blanca a la
// izquierda, saliente verde a la derecha, colita triangular, y la hora
// sentada en la última línea del texto (no en una línea propia).
//
// Diferencia deliberada con WhatsApp: NO se pintan los "ticks" de entregado
// o leído. No tenemos ese dato por mensaje, y un doble tick azul falso haría
// creer a Pedro que el cliente ha leído algo que quizá ni salió. Se muestra
// la hora, que sí es cierta.
//
// Sí se distingue quién escribió lo saliente (la IA o Pedro): en el panel
// eso importa, y va como una marca discreta junto a la hora — no como un
// titular que rompa el hilo.
// ============================================================

export type MessageRole = "user" | "assistant" | "human";

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

/** Separador de día, como el chip gris de WhatsApp ("HOY", "AYER", fecha). */
export function DateSeparator({ timestamp }: { timestamp: number }) {
  const d = new Date(timestamp * 1000);
  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - 86400_000);
  const mismoDia = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const label = mismoDia(d, hoy)
    ? "HOY"
    : mismoDia(d, ayer)
      ? "AYER"
      : d.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: d.getFullYear() === hoy.getFullYear() ? undefined : "numeric" });

  return (
    <div className="flex justify-center my-3">
      <span className="rounded-lg bg-white/85 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-chat-meta shadow-sm">
        {label}
      </span>
    </div>
  );
}

export default function MessageBubble({
  role,
  content,
  timestamp,
}: {
  role: MessageRole;
  content: string;
  timestamp: number;
}) {
  const saliente = role !== "user";
  const esIA = role === "assistant";

  return (
    <div className={`flex ${saliente ? "justify-end" : "justify-start"} mb-1.5 px-1`}>
      <div
        className={`chat-bubble relative max-w-[85%] md:max-w-[75%] rounded-lg px-2.5 py-1.5 shadow-sm ${
          saliente ? "chat-bubble-out bg-chat-out rounded-tr-none ml-8" : "chat-bubble-in bg-chat-in rounded-tl-none mr-8"
        }`}
      >
        <div className="text-[14.5px] leading-[1.35] text-brand-text whitespace-pre-wrap break-words">
          {content}
          {/* Reserva el hueco de la hora en la ÚLTIMA línea del texto */}
          <span className="chat-time-spacer" aria-hidden />
        </div>
        <div className="absolute bottom-1 right-2.5 flex items-center gap-1 text-[11px] leading-none text-chat-meta">
          {saliente && (
            <span className="font-medium" title={esIA ? "Lo escribió el agente automático" : "Lo escribiste tú"}>
              {esIA ? "IA" : "Tú"}
            </span>
          )}
          <span>{formatTime(timestamp)}</span>
        </div>
      </div>
    </div>
  );
}
