"use client";

// ============================================================
// AJUSTES: contenedor fino con tres sub-pestañas.
//   Integraciones → IntegrationsPanel (por defecto)
//   Sistema       → SystemPanel (el Control Center existente, sin tocar)
//   Preferencias  → SettingsPanel (los ajustes del bot, sin tocar)
// ============================================================

import { useState } from "react";
import { Chip } from "./ui";
import IntegrationsPanel from "./IntegrationsPanel";
import SystemPanel from "./SystemPanel";
import SettingsPanel from "./SettingsPanel";

type SettingsTab = "integrations" | "system" | "preferences";

export default function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>("integrations");

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 md:px-8 pt-4 pb-3 overflow-x-auto">
        <Chip active={tab === "integrations"} onClick={() => setTab("integrations")}>
          Integraciones
        </Chip>
        <Chip active={tab === "system"} onClick={() => setTab("system")}>
          Sistema
        </Chip>
        <Chip active={tab === "preferences"} onClick={() => setTab("preferences")}>
          Preferencias
        </Chip>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "integrations" ? (
          <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-24 md:pb-8">
            <div className="max-w-6xl mx-auto">
              <IntegrationsPanel />
            </div>
          </div>
        ) : tab === "system" ? (
          <SystemPanel />
        ) : (
          <SettingsPanel />
        )}
      </div>
    </div>
  );
}
