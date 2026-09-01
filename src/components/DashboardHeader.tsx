"use client";

// Cabecera del Control Center v2: identidad + estado de conexión.
// La navegación vive en el Dock (izquierda en desktop, abajo en móvil).

import { useState } from "react";
import Logo from "./Logo";
import { ModalShell, PrimaryButton, GhostButton } from "./ui";

interface DashboardHeaderProps {
  phone: string | null;
}

export default function DashboardHeader({ phone }: DashboardHeaderProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDisconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      await fetch("/api/connection/disconnect", { method: "POST" });
      window.location.reload();
    } catch {
      setDisconnecting(false);
      setError("Error al desconectar. Inténtalo de nuevo.");
    }
  }

  return (
    <header className="border-b border-brand-border bg-brand-surface/80 backdrop-blur px-4 md:px-6 py-3 flex items-center justify-between">
      <Logo size={20} />

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="brand-pulse absolute inline-flex h-full w-full rounded-full bg-wa-green opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-wa-green" />
          </span>
          <div className="leading-tight">
            <div className="text-xs font-semibold text-brand-text">Conectado</div>
            {phone && <div className="text-[11px] text-brand-muted font-mono">+{phone}</div>}
          </div>
        </div>

        <button
          onClick={() => setConfirming(true)}
          disabled={disconnecting}
          className="text-xs px-3.5 py-2 rounded-lg border border-brand-border bg-brand-surface-2 hover:border-brand-gold/40 hover:text-brand-gold text-brand-muted transition-colors disabled:opacity-50"
        >
          {disconnecting ? "Desconectando…" : "Desconectar"}
        </button>
      </div>

      <ModalShell open={confirming} onClose={() => setConfirming(false)} title="Desconectar WhatsApp">
        <p className="text-sm text-brand-muted mb-4">
          Se cerrará la sesión de WhatsApp y tendrás que escanear el QR otra vez para reconectar.
        </p>
        {error ? <p className="text-xs text-red-400 mb-3">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <GhostButton onClick={() => setConfirming(false)}>Cancelar</GhostButton>
          <PrimaryButton danger busy={disconnecting} onClick={handleDisconnect}>
            Desconectar
          </PrimaryButton>
        </div>
      </ModalShell>
    </header>
  );
}
