"use client";

// Banner de seguridad SIEMPRE visible: en qué modo está el sistema y si los
// envíos reales / escrituras Shopify están activos. Nadie debería tener que
// abrir .env.local para saberlo.

import { useEffect, useState } from "react";

interface SafetyStatus {
  mode: "safe" | "production";
  testMode: boolean;
  whatsappSendEnabled: boolean;
  shopifyWriteEnabled: boolean;
  emergencyStop: boolean;
  allowlistCount: number;
  maxOrderAgeMinutes: number;
  realSendPossible: boolean;
  realShopifyWritePossible: boolean;
  windowLabel: string;
  insideWindow: boolean;
}

function Chip({ label, on, danger }: { label: string; on: boolean; danger?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide ${
        on
          ? danger
            ? "bg-red-500/20 border-red-500/50 text-red-200"
            : "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
          : "bg-zinc-500/10 border-zinc-500/30 text-zinc-400"
      }`}
    >
      {label}: {on ? "ON" : "OFF"}
    </span>
  );
}

export default function SafetyBanner() {
  const [s, setS] = useState<SafetyStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch("/api/safety", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as SafetyStatus;
        if (mounted) setS(data);
      } catch {
        // siguiente ciclo
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  if (!s) return null;

  const isSafe = s.mode === "safe";
  const fullProduction = !isSafe && !s.testMode && s.realSendPossible;

  const bannerCls = isSafe
    ? "bg-sky-500/10 border-sky-500/40 text-sky-200"
    : fullProduction
      ? "bg-red-500/15 border-red-500/50 text-red-200"
      : "bg-violet-500/10 border-violet-500/40 text-violet-200";

  const title = isSafe ? "SAFE MODE" : s.testMode ? "TEST MODE" : "PRODUCTION";
  const subtitle = isSafe
    ? "No se enviarán mensajes ni se modificará Shopify"
    : s.testMode
      ? `Solo teléfonos autorizados (${s.allowlistCount} en la allowlist)`
      : "⚠️ Envíos reales activos para CUALQUIER cliente";

  return (
    <div className={`border-b px-6 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 ${bannerCls}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-display font-bold text-sm tracking-wide">{title}</span>
        <span className="text-xs opacity-90">{subtitle}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 ml-auto">
        <span
          title={`Ventana de envío: ${s.windowLabel}`}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide ${
            s.insideWindow
              ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
              : "bg-amber-500/15 border-amber-500/40 text-amber-300"
          }`}
        >
          🕘 {s.insideWindow ? "EN HORARIO" : "FUERA DE HORARIO"} · {s.windowLabel}
        </span>
        <Chip label="WhatsApp sending" on={s.realSendPossible} danger />
        <Chip label="Shopify writes" on={s.realShopifyWritePossible} danger />
        <Chip label="Emergency stop" on={s.emergencyStop} />
      </div>
    </div>
  );
}
