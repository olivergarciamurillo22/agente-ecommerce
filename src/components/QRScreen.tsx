"use client";

import { useEffect, useState } from "react";
import Logo from "./Logo";

interface QRScreenProps {
  status: "disconnected" | "qr" | "connecting" | "unknown";
  qrPng: string | null;
}

export default function QRScreen({ status, qrPng }: QRScreenProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="mb-8 flex flex-col items-center gap-3">
        <Logo size={34} />
        <div className="text-center text-[11px] uppercase tracking-[0.28em] text-brand-muted">
          Agente de WhatsApp
        </div>
      </div>

      <div className="max-w-md w-full bg-brand-surface border border-brand-border rounded-3xl p-8 shadow-2xl">
        <header className="text-center mb-6">
          <h1 className="font-display text-2xl font-bold mb-2 text-brand-text">
            Conecta tu WhatsApp
          </h1>
          <p className="text-sm text-brand-muted">
            Escanea el código con el móvil de tu negocio para activar el agente
          </p>
        </header>

        {qrPng && (
          <div className="bg-white p-4 rounded-2xl flex items-center justify-center mb-6 ring-2 ring-brand-gold/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrPng} alt="Código QR para conectar WhatsApp" className="w-full h-auto max-w-xs" />
          </div>
        )}

        {!qrPng && (
          <div className="bg-brand-bg border border-brand-border rounded-2xl aspect-square flex items-center justify-center mb-6">
            <div className="text-center">
              <div className="w-9 h-9 border-2 border-brand-border border-t-brand-gold rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-brand-muted">
                {status === "connecting" && "Conectando..."}
                {status === "disconnected" && "Esperando al bot..."}
                {status === "unknown" && "Cargando..."}
                {status === "qr" && "Generando QR..."}
              </p>
            </div>
          </div>
        )}

        <div className="text-xs text-brand-muted space-y-2">
          <p className="font-semibold text-brand-text uppercase tracking-wider text-[11px]">
            Cómo escanear
          </p>
          <ol className="list-decimal list-inside space-y-1 marker:text-brand-gold">
            <li>Abre WhatsApp en el móvil de tu negocio</li>
            <li>Ajustes → Dispositivos vinculados</li>
            <li>
              Toca <span className="text-brand-text font-medium">Vincular un dispositivo</span>
            </li>
            <li>Escanea el QR de esta pantalla</li>
          </ol>
        </div>

        {elapsed > 60 && (
          <div className="mt-6 p-3 bg-brand-surface-2 border border-brand-border-strong rounded-lg text-sm text-brand-gold">
            ¿Llevas más de 1 minuto? El QR puede haber caducado. Recarga la página.
          </div>
        )}
      </div>

      <p className="mt-6 text-[11px] text-brand-muted">
        Panel privado del agente
      </p>
    </main>
  );
}
