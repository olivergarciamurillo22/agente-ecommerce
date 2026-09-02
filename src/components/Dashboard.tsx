"use client";

// ============================================================
// Shell v4: seis áreas (Inicio · Pedidos · Seguimiento · Cazador · Growth ·
// Ajustes). Los destinos heredados (acciones/chats/envíos/agente →
// Seguimiento; anuncios/finanzas → Growth) se traducen aquí a área +
// pestaña, así ninguna pantalla antigua se queda sin sitio. El área activa
// vive en el hash de la URL.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import CommandPalette from "./CommandPalette";
import DashboardHeader from "./DashboardHeader";
import FollowUpView from "./FollowUpView";
import GrowthView from "./GrowthView";
import HomePanel from "./HomePanel";
import NavRail, { NAV_ITEMS, type DockView, type NavArea, type NavKey } from "./NavRail";
import OrdersPanel from "./OrdersPanel";
import ProductHunterEntry from "./hunter/ProductHunterEntry";
import SafetyBanner from "./SafetyBanner";
import SettingsView from "./SettingsView";
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

type FollowTab = "followup" | "actions" | "chats" | "shipments" | "agent";
type GrowthTab = "summary" | "funnel" | "products" | "ads" | "calculator" | "audit" | "repurchase" | "competition";
type HunterTab = "search" | "studio";

const HASH_TO_TARGET: Record<string, DockView> = {
  "#inicio": "home",
  "#pedidos": "orders",
  "#seguimiento": "followup",
  "#cazador": "hunter",
  "#landing-studio": "landing",
  "#growth": "growth",
  "#ajustes": "settings",
  // alias heredados (enlaces antiguos siguen funcionando)
  "#acciones": "actions",
  "#chats": "chats",
  "#agente": "agent",
  "#envios": "shipments",
  "#anuncios": "ads",
  "#finanzas": "finance",
};
const AREA_TO_HASH: Record<NavArea, string> = { home: "#inicio", orders: "#pedidos", followup: "#seguimiento", hunter: "#cazador", growth: "#growth", settings: "#ajustes" };

/** Traduce cualquier destino a área + pestaña. `landing` no es un área
 *  propia: es el Cazador abierto en su pestaña de Landing Studio, y por eso
 *  lleva su propio hash (deep-link que el módulo ya sabe leer). */
function resolveTarget(t: DockView): { area: NavArea; followTab?: FollowTab; growthTab?: GrowthTab; hunterTab?: HunterTab; hash?: string } {
  switch (t) {
    case "landing":
      return { area: "hunter", hunterTab: "studio", hash: "#landing-studio" };
    case "actions":
      return { area: "followup", followTab: "actions" };
    case "chats":
      return { area: "followup", followTab: "chats" };
    case "shipments":
      return { area: "followup", followTab: "shipments" };
    case "agent":
      return { area: "followup", followTab: "agent" };
    case "ads":
      return { area: "growth", growthTab: "ads" };
    case "finance":
      return { area: "growth", growthTab: "summary" };
    default:
      return { area: t };
  }
}

const SECTION_LABEL: Record<NavArea, string> = Object.fromEntries([...NAV_ITEMS.map((i) => [i.id, i.label]), ["settings", "Ajustes"]]) as Record<NavArea, string>;
const RANK: Record<string, number> = { healthy: 0, disabled: 0, unknown: 0, warning: 1, critical: 2 };

export default function Dashboard({ phone, provider }: DashboardProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [area, setArea] = useState<NavArea>(() => {
    if (typeof window !== "undefined") {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) return resolveTarget(t).area;
    }
    return "home";
  });
  const [followTab, setFollowTab] = useState<FollowTab>(() => {
    if (typeof window !== "undefined") {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) return resolveTarget(t).followTab ?? "followup";
    }
    return "followup";
  });
  const [growthTab, setGrowthTab] = useState<GrowthTab>(() => {
    if (typeof window !== "undefined") {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) return resolveTarget(t).growthTab ?? "summary";
    }
    return "summary";
  });
  const [hunterTab, setHunterTab] = useState<HunterTab>(() => {
    if (typeof window !== "undefined") {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) return resolveTarget(t).hunterTab ?? "search";
    }
    return "search";
  });
  const [badges, setBadges] = useState<Partial<Record<NavArea, number>>>({});
  const [systemStatus, setSystemStatus] = useState<UiStatus>("muted");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Cambia de clave para forzar el remount de Seguimiento/Growth con la pestaña pedida.
  const [navKey, setNavKey] = useState(0);

  const changeView = useCallback((t: DockView, hashOverride?: string) => {
    const r = resolveTarget(t);
    setArea(r.area);
    if (r.followTab) setFollowTab(r.followTab);
    if (r.growthTab) setGrowthTab(r.growthTab);
    if (r.followTab || r.growthTab) setNavKey((k) => k + 1);
    if (typeof window !== "undefined") window.history.replaceState(null, "", hashOverride ?? AREA_TO_HASH[r.area]);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) changeView(t, window.location.hash);
    };
    // La renderización inicial ocurre también en servidor; reconciliar el hash
    // al montar evita que una URL profunda (#pedidos, #landing-studio…) vuelva
    // visualmente a Inicio hasta el siguiente hashchange.
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [changeView]);

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
      /* siguiente ciclo */
    }
  }, []);

  useEffect(() => {
    refreshConversations();
    const viendoChats = area === "followup" && followTab === "chats";
    const interval = setInterval(refreshConversations, viendoChats ? 2000 : 30_000);
    return () => clearInterval(interval);
  }, [area, followTab, refreshConversations]);

  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/home", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { attention?: Array<{ target: DockView; count: number }>; flow?: Array<{ status: string }> };
        if (!vivo) return;
        if (j.attention) {
          const acc: Partial<Record<NavArea, number>> = {};
          for (const a of j.attention) {
            const ar = resolveTarget(a.target).area;
            acc[ar] = (acc[ar] ?? 0) + a.count;
          }
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
  // Resaltado de la navegación: Landing Studio es su propia entrada aunque
  // por dentro sea el Cazador en otra pestaña.
  const navKeyActive: NavKey = area === "hunter" && hunterTab === "studio" ? "landing" : area;

  return (
    <main className="h-screen overflow-hidden flex">
      <NavRail
        view={navKeyActive}
        onViewChange={changeView}
        badges={badges}
        systemStatus={systemStatus}
        systemLabel={systemStatus === "ok" ? "Sistema operativo" : systemStatus === "warn" ? "Con avisos" : systemStatus === "error" ? "Atención requerida" : "Sistema"}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <DashboardHeader
          phone={phone}
          provider={provider}
          sectionLabel={navKeyActive === "landing" ? "Landing Studio" : SECTION_LABEL[area]}
          onOpenSearch={() => setPaletteOpen(true)}
          systemStatus={systemStatus}
        />
        <SafetyBanner />
        <div className="flex-1 min-h-0 overflow-hidden">
          {area === "home" ? (
            <HomePanel onNavigate={changeView} />
          ) : area === "orders" ? (
            <OrdersPanel />
          ) : area === "followup" ? (
            <FollowUpView
              key={`f${navKey}`}
              initialTab={followTab}
              badges={{ actions: badges.followup }}
              conversations={conversations}
              selected={selected}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRefresh={refreshConversations}
              onNavigate={changeView}
            />
          ) : area === "hunter" ? (
            <ProductHunterEntry key={`h${navKey}`} initialTab={hunterTab} />
          ) : area === "growth" ? (
            <GrowthView key={`g${navKey}`} initialTab={growthTab} onNavigate={changeView} />
          ) : (
            <SettingsView />
          )}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={changeView} />
    </main>
  );
}
