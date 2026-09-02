"use client";

// Seguimiento (§8): una sección con pestañas — la vista general por
// pedido, la bandeja de acciones, las conversaciones, los envíos y la
// automatización (copiloto). Cada hijo gestiona su propio scroll.
import { useState } from "react";
import ActionCenter from "./ActionCenter";
import AgentPanel from "./AgentPanel";
import ChatsView from "./ChatsView";
import FollowUpPanel from "./FollowUpPanel";
import ShipmentsPanel from "./ShipmentsPanel";
import { TabBar } from "./ui";
import type { ConversationItem } from "./Dashboard";
import type { DockView } from "./NavRail";

type Tab = "followup" | "actions" | "chats" | "shipments" | "agent";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "followup", label: "Vista general" },
  { id: "actions", label: "Acciones" },
  { id: "chats", label: "Conversaciones" },
  { id: "shipments", label: "Envíos" },
  { id: "agent", label: "Automatización" },
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
      <div className="shrink-0 px-4 md:px-8 bg-brand-surface border-b border-brand-border">
        <div className="-mb-px">
          <TabBar tabs={TABS} value={tab} onChange={setTab} label="Secciones de seguimiento" counts={props.badges} />
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
