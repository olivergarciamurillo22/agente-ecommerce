"use client";

// ============================================================
// Shell del Control Center v2: dock de 9 secciones (§18), Home como
// control room (§19), y el resto de paneles. La sección activa se refleja
// en el hash de la URL (#pedidos, #finanzas…) para que refrescar o volver
// atrás no te saque de donde estabas.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import ActionCenter from "./ActionCenter";
import AdsPanel from "./AdsPanel";
import AgentPanel from "./AgentPanel";
import AmbientBackground from "./AmbientBackground";
import ChatsView from "./ChatsView";
import Dock, { type DockView } from "./Dock";
import DashboardHeader from "./DashboardHeader";
import FinancePanel from "./FinancePanel";
import HomePanel from "./HomePanel";
import OrdersPanel from "./OrdersPanel";
import SafetyBanner from "./SafetyBanner";
import SettingsView from "./SettingsView";
import ShipmentsPanel from "./ShipmentsPanel";

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

const HASH_TO_VIEW: Record<string, DockView> = {
  "#inicio": "home",
  "#acciones": "actions",
  "#pedidos": "orders",
  "#chats": "chats",
  "#agente": "agent",
  "#envios": "shipments",
  "#anuncios": "ads",
  "#finanzas": "finance",
  "#ajustes": "settings",
};
const VIEW_TO_HASH = Object.fromEntries(Object.entries(HASH_TO_VIEW).map(([h, v]) => [v, h])) as Record<DockView, string>;

export default function Dashboard({ phone }: DashboardProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Nada más entrar, Pedro ve el negocio: la Home es el control room.
  const [view, setView] = useState<DockView>(() => {
    if (typeof window !== "undefined" && HASH_TO_VIEW[window.location.hash]) return HASH_TO_VIEW[window.location.hash];
    return "home";
  });
  const [badges, setBadges] = useState<Partial<Record<DockView, number>>>({});

  const changeView = useCallback((v: DockView) => {
    setView(v);
    if (typeof window !== "undefined") window.history.replaceState(null, "", VIEW_TO_HASH[v]);
  }, []);

  // Volver atrás / cambiar el hash a mano también navega.
  useEffect(() => {
    const onHash = () => {
      const v = HASH_TO_VIEW[window.location.hash];
      if (v) setView(v);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations: ConversationItem[] };
      setConversations(data.conversations);
    } catch {
      // silenciar: reintenta en el siguiente ciclo
    }
  }, []);

  // Los chats solo se refrescan cada 2 s CUANDO se están mirando; en el
  // resto de vistas basta un pulso lento para el badge.
  useEffect(() => {
    refreshConversations();
    const interval = setInterval(refreshConversations, view === "chats" ? 2000 : 30_000);
    return () => clearInterval(interval);
  }, [view, refreshConversations]);

  // Badges del dock: un pulso ligero sobre /api/home.
  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/home", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          attention?: Array<{ target: DockView; count: number }>;
        };
        if (!vivo || !j.attention) return;
        const acc: Partial<Record<DockView, number>> = {};
        for (const a of j.attention) acc[a.target] = (acc[a.target] ?? 0) + a.count;
        setBadges(acc);
      } catch {
        /* siguiente ciclo */
      }
    };
    tick();
    const t = setInterval(tick, 20_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (conversations.length === 0) return;
    const sigueValida = selectedId !== null && conversations.some((c) => c.id === selectedId);
    if (!sigueValida) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <main className="h-screen overflow-hidden flex flex-col">
      <AmbientBackground />
      <DashboardHeader phone={phone} />
      <SafetyBanner />
      {/* Contenido: hueco a la izquierda para el dock en desktop, y abajo en móvil. */}
      <div className="flex-1 min-h-0 overflow-hidden md:pl-[72px]">
        {view === "home" ? (
          <HomePanel onNavigate={changeView} />
        ) : view === "actions" ? (
          <ActionCenter />
        ) : view === "orders" ? (
          <OrdersPanel />
        ) : view === "chats" ? (
          <ChatsView
            conversations={conversations}
            selected={selected}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRefresh={refreshConversations}
          />
        ) : view === "agent" ? (
          <AgentPanel onNavigate={changeView} />
        ) : view === "shipments" ? (
          <ShipmentsPanel />
        ) : view === "ads" ? (
          <AdsPanel />
        ) : view === "finance" ? (
          <FinancePanel />
        ) : (
          <SettingsView />
        )}
      </div>
      <Dock view={view} onViewChange={changeView} badges={badges} />
    </main>
  );
}
