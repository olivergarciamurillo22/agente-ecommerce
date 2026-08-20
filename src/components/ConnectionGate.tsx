"use client";

import { useEffect, useState } from "react";
import QRScreen from "./QRScreen";
import Dashboard from "./Dashboard";

type Status = "disconnected" | "qr" | "connecting" | "connected" | "unknown";

interface StatusPayload {
  status: Status;
  qrPng?: string;
  phone?: string | null;
}

export default function ConnectionGate() {
  const [status, setStatus] = useState<Status>("unknown");
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

  if (status === "connected") {
    return <Dashboard phone={phone} />;
  }

  return <QRScreen status={status} qrPng={qrPng} />;
}
