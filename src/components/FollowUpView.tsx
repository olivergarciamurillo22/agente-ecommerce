"use client";

// Seguimiento (§8): una sección con pestañas — la vista por pedido
// (Seguimiento), la bandeja de acciones, los chats, los envíos y el
// copiloto. Cada hijo gestiona su propio scroll.
import { useState } from "react";
import ActionCenter from "./ActionCenter";
import AgentPanel from "./AgentPanel";
import ChatsView from "./ChatsView";
import FollowUpPanel from "./FollowUpPanel";
import ShipmentsPanel from "./ShipmentsPanel";
import { Chip } from "./ui";
import type { ConversationItem } from "./Dashboard";
import type { DockView } from "./NavRail";

type Tab = "followup" | "actions" | "chats" | "shipments" | "agent";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "followup", label: "Seguimiento" },
  { id: "actions", label: "Acciones" },
  { id: "chats", label: "Chats" },
  { id: "shipments", label: "Envíos" },
  { id: "agent", label: "Agente" },
];

export default function FollowUpView(props: {
  initialTab?: Tab;
  badges?: Partial<Record<Tab, number>>;
  conversations: ConversationItem[];
  selected: ConversationItem | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRefresh: () => void;
  onNavigate: (v: DockView) => void;
}) {
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "followup");
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 md:px-8 pt-4">
        <div className="max-w-6xl mx-auto flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" role="tablist" aria-label="Secciones de seguimiento">
          {TABS.map((t) => (
            <Chip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} count={props.badges?.[t.id]}>
              {t.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "followup" ? (
          <FollowUpPanel onNavigate={props.onNavigate} />
        ) : tab === "actions" ? (
          <ActionCenter />
        ) : tab === "chats" ? (
          <ChatsView
            conversations={props.conversations}
            selected={props.selected}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            onRefresh={props.onRefresh}
          />
        ) : tab === "shipments" ? (
          <ShipmentsPanel />
        ) : (
          <AgentPanel onNavigate={props.onNavigate} />
        )}
      </div>
    </div>
  );
}
