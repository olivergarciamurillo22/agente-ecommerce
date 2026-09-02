"use client";

// ============================================================
// Barra de entorno (36 px): el operador debe SABER que está en pruebas,
// pero eso no ocupa el centro visual. Una línea, un icono, "Ver estado".
// El detalle técnico (ventana horaria, envíos, escrituras Shopify,
// parada de emergencia) vive en un popover, no en cuatro badges.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { StatusDot, type UiStatus } from "./ui";

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

function Row({ label, value, status }: { label: string; value: string; status: UiStatus }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-brand-border last:border-0">
      <span className="text-[13px] text-brand-muted">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-text tabular-nums">
        <StatusDot status={status} />
        {value}
      </span>
    </div>
  );
}

export default function SafetyBanner() {
  const [s, setS] = useState<SafetyStatus | null>(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!s) return null;

  const isSafe = s.mode === "safe";
  const fullProduction = !isSafe && !s.testMode && s.realSendPossible;

  const tone = isSafe
    ? "bg-brand-surface-2 border-brand-border text-brand-muted"
    : fullProduction
      ? "bg-red-600/[0.06] border-red-600/20 text-red-700"
      : "bg-amber-600/[0.05] border-amber-600/15 text-brand-muted";

  const parts = isSafe
    ? ["Modo seguro", "Sin envíos ni escrituras en Shopify"]
    : fullProduction
      ? ["Producción", "Envíos reales activos para cualquier cliente"]
      : [
          "Entorno de prueba",
          s.realSendPossible ? "Envíos solo a teléfonos autorizados" : "Envíos desactivados",
          `${s.allowlistCount} ${s.allowlistCount === 1 ? "teléfono autorizado" : "teléfonos autorizados"}`,
        ];

  return (
    <div ref={wrap} className={`relative shrink-0 border-b h-9 px-4 md:px-8 flex items-center gap-3 text-[13px] ${tone}`} role="status">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${fullProduction ? "" : isSafe ? "" : "text-amber-600"}`} aria-hidden>
        {fullProduction ? <path d="M12 3l9 16H3z M12 10v4M12 17.5v.5" /> : <path d="M12 3 4 6v6c0 4.4 3.4 7.6 8 9 4.6-1.4 8-4.6 8-9V6z" />}
      </svg>
      <span className="min-w-0 truncate">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 ? <span className="mx-1.5 opacity-50">·</span> : null}
            <span className={i === 0 ? "font-medium text-brand-text" : ""}>{p}</span>
          </span>
        ))}
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="ml-auto shrink-0 font-medium text-brand-text underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 rounded-sm"
      >
        Ver estado
      </button>

      {open && (
        <div className="absolute right-4 md:right-8 top-full mt-2 z-40 w-[min(340px,calc(100vw-32px))] rounded-2xl border border-brand-border bg-brand-surface p-4 shadow-[var(--shadow-float)] text-brand-text anim-slide-up" role="dialog" aria-label="Estado del sistema">
          <div className="text-[13px] font-semibold mb-1">Estado del sistema</div>
          <div className="text-[12px] text-brand-muted mb-2">Interruptores de seguridad leídos del entorno. Se cambian en el NAS, no aquí.</div>
          <Row label="Ventana de envío" value={`${s.insideWindow ? "En horario" : "Fuera de horario"} · ${s.windowLabel}`} status={s.insideWindow ? "ok" : "warn"} />
          <Row label="Envíos de WhatsApp" value={s.realSendPossible ? "Activos" : "Desactivados"} status={s.realSendPossible ? "error" : "muted"} />
          <Row label="Escrituras en Shopify" value={s.realShopifyWritePossible ? "Activas" : "Desactivadas"} status={s.realShopifyWritePossible ? "error" : "muted"} />
          <Row label="Parada de emergencia" value={s.emergencyStop ? "Activada" : "Inactiva"} status={s.emergencyStop ? "error" : "ok"} />
          <Row label="Teléfonos autorizados" value={String(s.allowlistCount)} status={s.allowlistCount > 0 ? "ok" : "muted"} />
          <Row label="Antigüedad máx. de pedido" value={`${s.maxOrderAgeMinutes} min`} status="muted" />
        </div>
      )}
    </div>
  );
}
