"use client";

// ============================================================
// El hilo de conversación, con el aspecto y la mecánica de WhatsApp real:
// cabecera con la persona, fondo de papel pintado, burbujas con colita y
// barra de escribir abajo del todo.
//
// Dos decisiones de FRICCIÓN (03-09), pensadas para que esto lo use
// cualquiera sin manual:
//
//  1. La barra de escribir se ve SIEMPRE. Antes, en modo IA, no había
//     ningún sitio donde escribir: había que encontrar un interruptor
//     "Modo Humano" perdido en la cabecera. Ahora la propia barra dice
//     quién responde y ofrece "Escribir yo" en un toque; al pulsarlo pasa
//     a modo humano y deja el cursor puesto. La regla de negocio no
//     cambia (o responde la IA, o respondes tú), solo deja de esconderse.
//
//  2. "Borrar conversación" sale del plano principal y vive en el menú ⋮
//     con su confirmación. Es irreversible y estaba a un dedo de distancia
//     del botón de enviar.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationItem } from "./Dashboard";
import MessageBubble, { DateSeparator } from "./MessageBubble";
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
  /** Móvil: vuelve a la lista. Si falta, no se pinta la flecha. */
  onBack?: () => void;
  /** Móvil: abre la ficha del pedido. Si falta, no se pinta el botón. */
  onOpenContext?: () => void;
}

const mismoDia = (a: number, b: number) =>
  new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();

export default function ConversationPanel({
  conversation,
  onRefresh,
  onBack,
  onOpenContext,
}: ConversationPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
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
        const res = await fetch(`/api/messages/${conversation!.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: Message[] };
        if (mounted) setMessages(data.messages);
      } catch {
        // silenciar: reintenta en el siguiente ciclo
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
    setError(null);
    setMenuOpen(false);
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

  const setMode = useCallback(
    async (newMode: "AI" | "HUMAN") => {
      if (!conversation) return;
      await fetch(`/api/mode/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: newMode }),
      });
      onRefresh();
    },
    [conversation, onRefresh]
  );

  /** "Escribir yo": pasa a humano y deja el cursor puesto, en un solo toque. */
  const tomarElControl = useCallback(async () => {
    await setMode("HUMAN");
    requestAnimationFrame(() => textRef.current?.focus());
  }, [setMode]);

  async function handleSend() {
    if (!conversation || !input.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/messages/${conversation.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input.trim() }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setError(e.error ?? `No se pudo enviar (error ${res.status})`);
        return;
      }
      setInput("");
      if (textRef.current) textRef.current.style.height = "auto";
      stickBottomRef.current = true;
      onRefresh();
    } catch {
      setError("Sin conexión con el panel. Inténtalo otra vez.");
    } finally {
      setSending(false);
    }
  }

  async function handleSendImage(file: File) {
    if (!conversation || sending) return;
    setSending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      if (input.trim()) fd.append("caption", input.trim());
      const res = await fetch(`/api/messages/${conversation.id}/image`, { method: "POST", body: fd });
      if (res.ok) {
        setInput("");
        stickBottomRef.current = true;
        onRefresh();
      } else {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setError(e.error ?? "No se pudo enviar la imagen");
      }
    } catch {
      setError("Sin conexión con el panel. Inténtalo otra vez.");
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    if (!conversation) return;
    const ok = confirm(
      `¿Borrar la conversación con ${conversation.name ?? `+${conversation.phone}`}?\n\nSe borran todos los mensajes y no se puede deshacer.`
    );
    if (!ok) return;
    await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    setMenuOpen(false);
    onBack?.();
    onRefresh();
  }

  // Enter envía solo con teclado de verdad; en pantalla táctil Enter hace
  // salto de línea y se envía con el botón (como el WhatsApp del móvil).
  const enterEnvia = useMemo(
    () => (typeof window === "undefined" ? true : window.matchMedia("(pointer: fine)").matches),
    []
  );

  if (!conversation) {
    return (
      <section className="flex flex-col items-center justify-center text-center gap-4 bg-brand-bg/40 h-full">
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
    <section className="flex flex-col min-h-0 h-full overflow-hidden">
      {/* ── Cabecera: una sola barra, como en WhatsApp ── */}
      <header className="shrink-0 flex items-center gap-2 border-b border-brand-border bg-chat-header px-2 py-2 md:px-4 md:py-2.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Volver a las conversaciones"
            className="md:hidden shrink-0 grid h-10 w-10 place-items-center rounded-full text-brand-text hover:bg-black/5 active:bg-black/10"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
        )}
        <Avatar label={label} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-brand-text">{label}</div>
          {/* Quién responde es lo que hay que saber de un vistazo; el teléfono
              solo cabe sin cortarse a partir de pantallas medianas. */}
          <div className="truncate text-[12px]">
            <span className={isHuman ? "font-medium text-wa-green" : "text-brand-muted"}>
              {isHuman ? "respondes tú" : "responde la IA"}
            </span>
            <span className="hidden text-brand-muted sm:inline"> · +{conversation.phone}</span>
          </div>
        </div>
        {onOpenContext && (
          <button
            type="button"
            onClick={onOpenContext}
            className="lg:hidden shrink-0 rounded-full border border-brand-border bg-white px-3 h-9 text-[13px] font-medium text-brand-text hover:bg-brand-surface-2"
          >
            Pedido
          </button>
        )}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Más opciones"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="grid h-10 w-10 place-items-center rounded-full text-brand-muted hover:bg-black/5 active:bg-black/10"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden>
              <circle cx="12" cy="5" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="12" cy="19" r="1.8" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
              <div role="menu" className="absolute right-0 top-11 z-20 w-60 overflow-hidden rounded-xl border border-brand-border bg-white shadow-float">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void setMode(isHuman ? "AI" : "HUMAN");
                  }}
                  className="block w-full px-4 py-3 text-left text-[14px] text-brand-text hover:bg-brand-surface-2"
                >
                  {isHuman ? "Que vuelva a responder la IA" : "Responder yo a este cliente"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleDelete}
                  className="block w-full border-t border-brand-border px-4 py-3 text-left text-[14px] text-red-600 hover:bg-red-50"
                >
                  Borrar conversación
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* ── Hilo ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="chat-wallpaper flex flex-col flex-1 min-h-0 overflow-y-auto px-2 py-3 md:px-6"
      >
        {/* `mt-auto`: con pocos mensajes el hilo queda pegado abajo, contra la
            barra de escribir, como en WhatsApp — y no flotando arriba. */}
        <div className="mt-auto">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-sm rounded-lg bg-white/85 px-4 py-3 text-center text-[13px] text-brand-muted shadow-sm">
              Todavía no hay mensajes en esta conversación.
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={m.id}>
                {(i === 0 || !mismoDia(messages[i - 1].created_at, m.created_at)) && (
                  <DateSeparator timestamp={m.created_at} />
                )}
                <MessageBubble role={m.role} content={m.content} timestamp={m.created_at} />
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Barra de escribir: SIEMPRE visible ── */}
      <footer className="shrink-0 border-t border-brand-border bg-chat-header px-2 py-2 md:px-4">
        {error && (
          <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700" role="alert">
            {error}
          </div>
        )}
        {isHuman ? (
          <div className="flex items-end gap-2">
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
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              aria-label="Enviar una foto"
              title="Enviar una foto (el texto será el pie de foto)"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-brand-muted hover:bg-black/5 active:bg-black/10 disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="6" width="18" height="14" rx="2.5" />
                <circle cx="12" cy="13" r="3.2" />
                <path d="M8.5 6l1.2-2h4.6l1.2 2" />
              </svg>
            </button>
            <textarea
              ref={textRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && enterEnvia) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="Escribe un mensaje"
              rows={1}
              className="min-h-[44px] max-h-[120px] flex-1 resize-none rounded-2xl border border-brand-border bg-white px-4 py-3 text-[15px] leading-tight text-brand-text placeholder:text-brand-muted focus:border-brand-border-strong focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !input.trim()}
              aria-label="Enviar mensaje"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-chat-send text-white transition-opacity hover:brightness-105 disabled:opacity-40"
            >
              {sending ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2} className="animate-spin" aria-hidden>
                  <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
                  <path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.1 15.5 12 3.39 13.9z" />
                </svg>
              )}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3 py-1">
            <div className="min-w-0 flex-1 text-[13px] leading-snug text-brand-muted">
              Ahora responde la <span className="font-semibold text-brand-text">IA</span> a este cliente.
            </div>
            <button
              type="button"
              onClick={tomarElControl}
              className="shrink-0 rounded-full bg-chat-send px-5 h-11 text-[14px] font-semibold text-white hover:brightness-105"
            >
              Escribir yo
            </button>
          </div>
        )}
      </footer>
    </section>
  );
}
