"use client";

import type { ConversationItem } from "./Dashboard";
import Avatar from "./Avatar";

interface ConversationListProps {
  conversations: ConversationItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRefresh: () => void;
}

function formatRelative(timestamp: number | null): string {
  if (!timestamp) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return "ahora";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} días`;
}

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: ConversationListProps) {
  return (
    <aside className="border-r border-brand-border bg-brand-bg/60 overflow-y-auto min-h-0">
      <div className="px-4 py-3 border-b border-brand-border sticky top-0 bg-brand-bg/95 backdrop-blur z-10 flex items-center justify-between">
        <h2 className="text-[12px] font-medium text-brand-muted">
          Conversaciones
        </h2>
        <span className="text-[11px] font-semibold text-brand-gold bg-brand-surface-2 border border-brand-border-strong rounded-full px-2 py-0.5">
          {conversations.length}
        </span>
      </div>

      {conversations.length === 0 && (
        <div className="p-6 text-center text-sm text-brand-muted">
          Aún no hay conversaciones. Escríbele al número conectado desde otro WhatsApp para verlas aquí.
        </div>
      )}

      <ul>
        {conversations.map((c) => {
          const isSelected = c.id === selectedId;
          const label = c.name ?? `+${c.phone}`;
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                className={`w-full text-left px-4 py-3 border-b border-brand-border/40 transition-colors flex gap-3 items-start relative ${
                  isSelected ? "bg-brand-surface-2" : "hover:bg-brand-surface"
                }`}
              >
                {isSelected && (
                  <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-brand-gold rounded-r" />
                )}
                <Avatar label={label} size={42} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <div className="font-semibold text-sm text-brand-text truncate">{label}</div>
                    <span className="text-[10px] text-brand-muted shrink-0">
                      {formatRelative(c.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold shrink-0 ${
                        c.mode === "AI"
                          ? "bg-brand-surface-2 text-brand-text"
                          : "bg-wa-green/15 text-wa-green"
                      }`}
                    >
                      {c.mode === "AI" ? "IA" : "TÚ"}
                    </span>
                    {c.last_message_preview && (
                      <div className="text-xs text-brand-muted truncate">
                        {c.last_message_preview}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
