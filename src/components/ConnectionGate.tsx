"use client";

import { useEffect, useState } from "react";
import QRScreen from "./QRScreen";
import Dashboard from "./Dashboard";

type Status = "disconnected" | "qr" | "connecting" | "connected" | "unknown";

interface StatusPayload {
  status: Status;
  provider?: string;
  qrPng?: string;
  phone?: string | null;
}

export default function ConnectionGate() {
  const [status, setStatus] = useState<Status>("unknown");
  const [provider, setProvider] = useState<string>("");
  const [qrPng, setQrPng] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/connection/status", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as StatusPayload;
        if (!mounted) return;
        setStatus(data.status);
        setProvider(data.provider ?? "");
        setQrPng(data.qrPng ?? null);
        setPhone(data.phone ?? null);
      } catch {
        if (mounted) setStatus("unknown");
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Cloud API (§47): no existe sesión QR — el panel entra directo. La
  // pantalla de QR es EXCLUSIVA de Baileys.
  if (status === "connected" || provider === "cloud_api") {
    return <Dashboard phone={phone} provider={provider} />;
  }

  return <QRScreen status={status} qrPng={qrPng} />;
}
