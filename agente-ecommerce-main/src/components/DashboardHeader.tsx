"use client";

import { useState } from "react";
import Logo from "./Logo";

type View = "orders" | "products" | "chats" | "system" | "settings";
interface DashboardHeaderProps {
  phone: string | null;
  view: View;
  onViewChange: (v: View) => void;
}

export default function DashboardHeader({ phone, view, onViewChange }: DashboardHeaderProps) {
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    const confirmed = confirm(
      "¿Seguro que quieres desconectar? Tendrás que escanear el QR otra vez."
    );
    if (!confirmed) return;

    setDisconnecting(true);
    try {
      await fetch("/api/connection/disconnect", { method: "POST" });
      window.location.reload();
    } catch {
      setDisconnecting(false);
      alert("Error al desconectar. Inténtalo de nuevo.");
    }
  }

  return (
    <header className="border-b border-brand-border bg-brand-surface/80 backdrop-blur px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3.5">
        <Logo size={20} />
        <div className="h-9 w-px bg-brand-border" />
        <nav className="inline-flex rounded-lg border border-brand-border p-0.5 bg-brand-bg">
          {(["orders", "products", "chats", "system", "settings"] as const).map((v) => (
            <button
              key={v}
              onClick={() => onViewChange(v)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                view === v ? "bg-brand-gold text-black" : "text-brand-muted hover:text-brand-text"
              }`}
            >
              {v === "orders" ? "Pedidos" : v === "products" ? "Productos" : v === "chats" ? "Chats" : v === "system" ? "Sistema" : "Ajustes"}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="brand-pulse absolute inline-flex h-full w-full rounded-full bg-wa-green opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-wa-green" />
          </span>
          <div className="leading-tight">
            <div className="text-xs font-semibold text-brand-text">Conectado</div>
            {phone && (
              <div className="text-[11px] text-brand-muted font-mono">+{phone}</div>
            )}
          </div>
        </div>

        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className="text-xs px-3.5 py-2 rounded-lg border border-brand-border bg-brand-surface-2 hover:border-brand-gold/40 hover:text-brand-gold text-brand-muted transition-colors disabled:opacity-50"
        >
          {disconnecting ? "Desconectando..." : "Desconectar"}
        </button>
      </div>
    </header>
  );
}
