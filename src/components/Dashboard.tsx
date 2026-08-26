"use client";

import { useEffect, useState } from "react";
import DashboardHeader from "./DashboardHeader";
import ConversationList from "./ConversationList";
import ConversationPanel from "./ConversationPanel";
import AmbientBackground from "./AmbientBackground";
import OrdersPanel from "./OrdersPanel";
import ActionCenter from "./ActionCenter";
import SafetyBanner from "./SafetyBanner";
import SettingsPanel from "./SettingsPanel";
import SystemPanel from "./SystemPanel";

interface DashboardProps {
  phone: string | null;
}

export interface ConversationItem {
  id: number;
  phone: string;
  name: string | null;
  mode: "AI" | "HUMAN";
  last_message_at: number | null;
  last_message_preview: string | null;
}

export default function Dashboard({ phone }: DashboardProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // La vista principal del MVP de Pedro son los PEDIDOS, no los chats.
  // La vista de arranque es la BANDEJA: lo primero que Pedro debe ver es qué
  // requiere su acción, no la lista completa de pedidos.
  const [view, setView] = useState<"actions" | "orders" | "chats" | "system" | "settings">("actions");

  async function refresh() {
    try {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations: ConversationItem[] };
      setConversations(data.conversations);
    } catch {
      // silenciar
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecciona una conversación SOLO si la actual no es válida (ninguna aún, o
  // se borró). No se ejecuta en cada refresco, así que no te saca de la que lees.
  useEffect(() => {
    if (conversations.length === 0) return;
    const sigueValida = selectedId !== null && conversations.some((c) => c.id === selectedId);
    if (!sigueValida) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <main className="h-screen overflow-hidden flex flex-col">
      <AmbientBackground />
      <DashboardHeader phone={phone} view={view} onViewChange={setView} />
      <SafetyBanner />
      {view === "actions" ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ActionCenter />
        </div>
      ) : view === "orders" ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <OrdersPanel />
        </div>
      ) : view === "chats" ? (
        <div className="flex-1 min-h-0 grid grid-cols-[320px_1fr] overflow-hidden">
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRefresh={refresh}
          />
          <ConversationPanel conversation={selected} onRefresh={refresh} />
        </div>
      ) : view === "system" ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <SystemPanel />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          <SettingsPanel />
        </div>
      )}
    </main>
  );
}
