"use client";

// ============================================================
// Shell del Control Center v3: NAV RAIL con labels (§30-31), cabecera
// provider-aware (§47), command palette (⌘K, §37) y las 9 secciones.
// La sección activa vive en el hash (#pedidos, #finanzas…): refrescar o
// volver atrás no te saca de donde estabas.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import ActionCenter from "./ActionCenter";
import AdsPanel from "./AdsPanel";
import AgentPanel from "./AgentPanel";
import AmbientBackground from "./AmbientBackground";
import ChatsView from "./ChatsView";
import CommandPalette from "./CommandPalette";
import DashboardHeader from "./DashboardHeader";
import FinanceView from "./FinanceView";
import HomePanel from "./HomePanel";
import NavRail, { NAV_ITEMS, type DockView } from "./NavRail";
import OrdersPanel from "./OrdersPanel";
import SafetyBanner from "./SafetyBanner";
import SettingsView from "./SettingsView";
import ShipmentsPanel from "./ShipmentsPanel";
import { healthToUi, type UiStatus } from "./ui";

interface DashboardProps {
  phone: string | null;
  provider?: string;
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

const SECTION_LABEL: Record<DockView, string> = Object.fromEntries([
  ...NAV_ITEMS.map((i) => [i.id, i.label]),
  ["settings", "Ajustes"],
]) as Record<DockView, string>;

const RANK: Record<string, number> = { healthy: 0, disabled: 0, unknown: 0, warning: 1, critical: 2 };

export default function Dashboard({ phone, provider }: DashboardProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<DockView>(() => {
    if (typeof window !== "undefined" && HASH_TO_VIEW[window.location.hash]) return HASH_TO_VIEW[window.location.hash];
    return "home";
  });
  const [badges, setBadges] = useState<Partial<Record<DockView, number>>>({});
  const [systemStatus, setSystemStatus] = useState<UiStatus>("muted");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const changeView = useCallback((v: DockView) => {
    setView(v);
    if (typeof window !== "undefined") window.history.replaceState(null, "", VIEW_TO_HASH[v]);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const v = HASH_TO_VIEW[window.location.hash];
      if (v) setView(v);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ⌘K / Ctrl+K abre la paleta desde cualquier sección.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  // Chats a 2 s SOLO cuando se miran; pulso lento para el badge en el resto.
  useEffect(() => {
    refreshConversations();
    const interval = setInterval(refreshConversations, view === "chats" ? 2000 : 30_000);
    return () => clearInterval(interval);
  }, [view, refreshConversations]);

  // Badges del rail + salud global: un pulso ligero sobre /api/home.
  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/home", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as {
          attention?: Array<{ target: DockView; count: number }>;
          flow?: Array<{ status: string }>;
        };
        if (!vivo) return;
        if (j.attention) {
          const acc: Partial<Record<DockView, number>> = {};
          for (const a of j.attention) acc[a.target] = (acc[a.target] ?? 0) + a.count;
          setBadges(acc);
        }
        if (j.flow) {
          const peor = j.flow.reduce((w, f) => (RANK[f.status] > RANK[w] ? f.status : w), "healthy");
          setSystemStatus(healthToUi(peor));
        }
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
    <main className="h-screen overflow-hidden flex">
      <AmbientBackground />
      <NavRail
        view={view}
        onViewChange={changeView}
        badges={badges}
        systemStatus={systemStatus}
        systemLabel={systemStatus === "ok" ? "Sistema operativo" : systemStatus === "warn" ? "Con avisos" : systemStatus === "error" ? "Atención requerida" : "Sistema"}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <DashboardHeader
          phone={phone}
          provider={provider}
          sectionLabel={SECTION_LABEL[view]}
          onOpenSearch={() => setPaletteOpen(true)}
          systemStatus={systemStatus}
        />
        <SafetyBanner />
        <div className="flex-1 min-h-0 overflow-hidden">
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
            <FinanceView />
          ) : (
            <SettingsView />
          )}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={changeView} />
    </main>
  );
}
