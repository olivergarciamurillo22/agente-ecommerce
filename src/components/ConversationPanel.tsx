"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationItem } from "./Dashboard";
import MessageBubble from "./MessageBubble";
import ModeToggle from "./ModeToggle";
import Avatar from "./Avatar";
import { Emblem } from "./Logo";

interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "assistant" | "human";
  content: string;
  created_at: number;
}

interface ConversationPanelProps {
  conversation: ConversationItem | null;
  onRefresh: () => void;
}

export default function ConversationPanel({
  conversation,
  onRefresh,
}: ConversationPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Si el usuario está pegado al fondo, seguimos autoscrolleando con los mensajes
  // nuevos. Si ha subido a leer mensajes anteriores, NO le devolvemos al fondo.
  const stickBottomRef = useRef(true);

  useEffect(() => {
    if (!conversation) {
      setMessages([]);
      return;
    }

    let mounted = true;
    async function load() {
      try {
        const res = await fetch(`/api/messages/${conversation!.id}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: Message[] };
        if (mounted) setMessages(data.messages);
      } catch {
        // silenciar
      }
    }

    load();
    const interval = setInterval(load, 2000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [conversation]);

  // Al abrir/cambiar de conversación, arranca pegado al fondo.
  useEffect(() => {
    stickBottomRef.current = true;
  }, [conversation?.id]);

  // Autoscroll SOLO si el usuario ya estaba abajo (no si subió a leer atrás).
  useEffect(() => {
    if (stickBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function handleModeChange(newMode: "AI" | "HUMAN") {
    if (!conversation) return;
    await fetch(`/api/mode/${conversation.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: newMode }),
    });
    onRefresh();
  }

  async function handleSend() {
    if (!conversation || !input.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`/api/messages/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input.trim() }),
      });
      setInput("");
      onRefresh();
    } finally {
      setSending(false);
    }
  }

  async function handleSendImage(file: File) {
    if (!conversation || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      if (input.trim()) fd.append("caption", input.trim());
      const res = await fetch(`/api/messages/${conversation.id}/image`, { method: "POST", body: fd });
      if (res.ok) {
        setInput("");
        onRefresh();
      } else {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        alert(e.error ?? "No se pudo enviar la imagen");
      }
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    if (!conversation) return;
    const confirmed = confirm(
      `¿Borrar la conversación con ${conversation.name ?? `+${conversation.phone}`}? Esta acción no se puede deshacer.`
    );
    if (!confirmed) return;
    await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    onRefresh();
  }

  if (!conversation) {
    return (
      <section className="flex flex-col items-center justify-center text-center gap-4 bg-brand-bg/40">
        <Emblem size={64} />
        <div>
          <div className="font-display text-lg text-brand-text">Selecciona una conversación</div>
          <div className="text-sm text-brand-muted mt-1">
            Elige un chat de la izquierda para ver y gestionar la conversación.
          </div>
        </div>
      </section>
    );
  }

  const isHuman = conversation.mode === "HUMAN";
  const label = conversation.name ?? `+${conversation.phone}`;

  return (
    <section className="flex flex-col min-h-0 bg-brand-bg/40 overflow-hidden">
      <header className="border-b border-brand-border px-5 py-3 flex items-center justify-between bg-brand-surface/70 backdrop-blur shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar label={label} size={40} />
          <div className="min-w-0">
            <div className="font-semibold text-brand-text truncate">{label}</div>
            <div className="text-xs text-brand-muted font-mono">
              +{conversation.phone}
              <span className={isHuman ? "text-wa-green ml-2" : "text-brand-gold ml-2"}>
                {isHuman ? "· atiende un humano" : "· responde la IA"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ModeToggle mode={conversation.mode} onChange={handleModeChange} />
          <button
            onClick={handleDelete}
            className="text-xs px-3 py-2 rounded-lg border border-brand-border text-brand-muted hover:border-red-800/60 hover:text-red-600 transition-colors"
          >
            Borrar
          </button>
        </div>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="text-center text-sm text-brand-muted py-10">
            Sin mensajes todavía
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            role={m.role}
            content={m.content}
            timestamp={m.created_at}
          />
        ))}
      </div>

      <footer className="border-t border-brand-border p-3 bg-brand-surface/70 backdrop-blur shrink-0">
        {isHuman ? (
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Escribe tu respuesta..."
              rows={2}
              className="flex-1 bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-wa-green/60 text-brand-text placeholder:text-brand-muted"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleSendImage(f);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              title="Enviar una imagen (el texto del cuadro será el pie de foto)"
              className="px-3 rounded-lg border border-brand-border text-lg text-brand-muted hover:text-brand-gold hover:border-brand-border-strong disabled:opacity-40 transition"
            >
              📷
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="px-5 py-2 rounded-lg bg-wa-green hover:brightness-110 text-black font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {sending ? "..." : "Enviar"}
            </button>
          </div>
        ) : (
          <div className="text-center text-xs text-brand-muted py-2">
            La IA responde sola. Cambia a{" "}
            <span className="text-wa-green font-semibold">Modo Humano</span> para escribir tú.
          </div>
        )}
      </footer>
    </section>
  );
}
