"use client";

// ============================================================
// Shell v4: seis áreas (Inicio · Pedidos · Seguimiento · Cazador · Growth ·
// Ajustes). Los destinos heredados (acciones/chats/envíos/agente →
// Seguimiento; anuncios/finanzas → Growth) se traducen aquí a área +
// pestaña, así ninguna pantalla antigua se queda sin sitio. El área activa
// vive en el hash de la URL.
// ============================================================

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { navigateHash } from "./useBackable";
import { usePolling } from "./usePolling";
import DashboardHeader from "./DashboardHeader";
import HomePanel from "./HomePanel";
import NavRail, { NAV_ITEMS, type DockView, type NavArea, type NavKey } from "./NavRail";
import SafetyBanner from "./SafetyBanner";
import { healthToUi, SkeletonRows, type UiStatus } from "./ui";

// ============================================================
// CADA PANTALLA SE DESCARGA CUANDO SE ABRE, NO ANTES.
//
// Antes el Dashboard importaba las seis de forma estática, así que abrir el
// panel para mirar Inicio descargaba también Pedidos, Seguimiento, Growth
// (que a su vez arrastra Ads, Finanzas y la Calculadora) y Ajustes: más de
// 600 KB de componentes para ver una pantalla. Eso es lo que hacía que
// "cargara lentísimo", sobre todo en móvil y con la conexión del NAS.
//
// HomePanel se queda estático a propósito: es lo primero que se ve siempre, y
// cargarlo en diferido solo añadiría un parpadeo.
// ============================================================
const OrdersPanel = lazy(() => import("./OrdersPanel"));
const FollowUpView = lazy(() => import("./FollowUpView"));
const GrowthView = lazy(() => import("./GrowthView"));
const SettingsView = lazy(() => import("./SettingsView"));
const ProductHunterEntry = lazy(() => import("./hunter/ProductHunterEntry"));
// La paleta solo aparece con ⌘K: no tiene sentido descargarla de entrada.
const CommandPalette = lazy(() => import("./CommandPalette"));

/** Esqueleto mientras llega la pantalla. Mantiene la altura para que no salte. */
function PanelFallback() {
  return (
    <div className="h-full overflow-hidden px-4 md:px-8 py-6">
      <div className="max-w-[1500px]">
        <SkeletonRows rows={6} />
      </div>
    </div>
  );
}

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
type HunterTab = "radar" | "studio";
type SettingsTab = "general" | "whatsapp" | "calls" | "integrations" | "costs" | "system";

const HASH_TO_TARGET: Record<string, DockView> = {
  "#inicio": "home",
  "#pedidos": "orders",
  "#seguimiento": "followup",
  "#cazador": "hunter",
  "#landing-studio": "landing",
  "#growth": "growth",
  "#ajustes": "settings",
  "#sistema": "system",
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
function resolveTarget(t: DockView): { area: NavArea; followTab?: FollowTab; growthTab?: GrowthTab; hunterTab?: HunterTab; settingsTab?: SettingsTab; hash?: string } {
  switch (t) {
    case "landing":
      return { area: "hunter", hunterTab: "studio", hash: "#landing-studio" };
    // La salud del sistema vivía enterrada como pestaña dentro de Ajustes, sin
    // forma de llegar en un clic. Ahora tiene destino propio.
    case "system":
      return { area: "settings", settingsTab: "system", hash: "#sistema" };
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
      if (t) return resolveTarget(t).hunterTab ?? "radar";
    }
    // El Cazador abre en el Radar: es lo que encuentra productos.
    return "radar";
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => {
    if (typeof window !== "undefined") {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) return resolveTarget(t).settingsTab ?? "whatsapp";
    }
    return "whatsapp";
  });
  const [badges, setBadges] = useState<Partial<Record<NavArea, number>>>({});
  const [systemStatus, setSystemStatus] = useState<UiStatus>("muted");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Cambia de clave para forzar el remount de Seguimiento/Growth con la pestaña pedida.
  const [navKey, setNavKey] = useState(0);

  // `fromHistory` distingue "el usuario ha pulsado algo" de "el navegador ha
  // cambiado la URL". En el primer caso hay que AÑADIR una entrada para poder
  // volver; en el segundo, tocar el historial provocaría un bucle.
  const changeView = useCallback((t: DockView, hashOverride?: string, fromHistory = false) => {
    const r = resolveTarget(t);
    setArea(r.area);
    if (r.followTab) setFollowTab(r.followTab);
    if (r.growthTab) setGrowthTab(r.growthTab);
    // El Cazador tiene dos destinos (Radar y Landing Studio) y hasta ahora
    // solo se propagaba por el hash. Al volver de Landing Studio al Cazador
    // la pestaña se quedaba pegada en Studio.
    if (r.hunterTab) setHunterTab(r.hunterTab);
    if (r.settingsTab) setSettingsTab(r.settingsTab);
    // El remonte SOLO cuando cambia la pestaña pedida, nunca por entrar en el
    // área. Bumpear la clave en cada evento de hash remontaba el Cazador
    // entero: cerrar la ficha de un producto disparaba un popstate y te
    // devolvía a la pantalla inicial, perdiendo los resultados de una
    // búsqueda que había tardado minutos.
    if (r.followTab || r.growthTab || r.settingsTab || r.hunterTab) setNavKey((k) => k + 1);
    // Antes esto era SIEMPRE replaceState, y por eso "atrás" no devolvía a la
    // sección anterior: te sacaba de la aplicación. En el móvil, donde atrás
    // es un gesto del sistema, eso hacía que el panel se sintiera roto.
    // `r.hash` existía y no se leía: los destinos con enlace propio
    // (#landing-studio, #sistema) dependían de que el llamador lo pasara a
    // mano, así que al llegar por otro camino la URL se quedaba en la del
    // área y recargar te dejaba en otra pestaña.
    if (!fromHistory) navigateHash(hashOverride ?? r.hash ?? AREA_TO_HASH[r.area], "push");
  }, []);

  useEffect(() => {
    const onHash = () => {
      const t = HASH_TO_TARGET[window.location.hash];
      if (t) changeView(t, window.location.hash, true);
    };
    // `popstate` cubre el botón atrás del navegador y el gesto del móvil.
    window.addEventListener("popstate", onHash);
    // La renderización inicial ocurre también en servidor; reconciliar el hash
    // al montar evita que una URL profunda (#pedidos, #landing-studio…) vuelva
    // visualmente a Inicio hasta el siguiente hashchange.
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
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
  }, [refreshConversations]);
  // Mirando los chats hace falta ritmo (2 s) porque se está esperando la
  // respuesta de un cliente; fuera de ahí, medio minuto sobra. Lo que sí
  // cambia es que ahora se PARA con la pestaña en segundo plano.
  const viendoChats = area === "followup" && followTab === "chats";
  usePolling(refreshConversations, { intervalMs: viendoChats ? 2000 : 30_000 });

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
      {/* El hueco de la barra móvil se reserva AQUÍ, una sola vez: la barra es
          `fixed` y antes tapaba el final de cada pantalla (el cuadro de
          escribir del chat quedaba debajo y no se podía responder desde el
          móvil). Ninguna pantalla necesita ya saber que la barra existe. */}
      <div className="flex-1 min-w-0 flex flex-col pb-[var(--mobile-nav-h)] md:pb-0">
        <DashboardHeader
          phone={phone}
          provider={provider}
          sectionLabel={navKeyActive === "landing" ? "Landing Studio" : SECTION_LABEL[area]}
          onOpenSearch={() => setPaletteOpen(true)}
          systemStatus={systemStatus}
        />
        <SafetyBanner />
        <div className="flex-1 min-h-0 overflow-hidden">
          <Suspense fallback={<PanelFallback />}>
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
            <SettingsView key={`s${navKey}`} initialSection={settingsTab} />
          )}
          </Suspense>
        </div>
      </div>
      {/* Solo se monta (y se descarga) cuando se abre de verdad. */}
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette open onClose={() => setPaletteOpen(false)} onNavigate={changeView} />
        </Suspense>
      )}
    </main>
  );
}
