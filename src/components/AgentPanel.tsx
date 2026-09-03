"use client";

// ============================================================
// AGENTE (§24 + §43) — el copiloto operativo, NO un chatbot vacío.
//
// Arriba: la tarjeta de identidad de Lucía (estado, Retell, prompt,
// versión, llamadas de hoy) en lenguaje de operador, sin internals.
// Después: lo que necesita atención (QUÉ PASA / QUÉ FALTA / RECOMENDACIÓN,
// de /api/agent) y las últimas llamadas completadas (/api/calls).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import type { DockView } from "./NavRail";
import {
  Card,
  EmptyState,
  ErrorState,
  formatInt,
  GhostButton,
  KpiTile,
  SectionTitle,
  Skeleton,
  StatusDot,
  timeAgo,
} from "./ui";

interface AgentItem {
  orderId: number;
  orderNumber: string;
  customer: string;
  urgency: number;
  whatsHappening: string;
  whatsMissing: string;
  recommendation: string;
  type: string;
  sinceAt: number;
}

interface AgentData {
  ok: boolean;
  summary: { total: number; urgent: number; awaitingRelease: number };
  items: AgentItem[];
}

interface CallsData {
  config: {
    aiCallsEnabled: boolean;
    shadowMode: boolean;
    dailyCap: number;
    retellApiKey: "configured" | "missing";
    retellFromNumber: "configured" | "missing";
    retellAgentId: "configured" | "missing";
  };
  summary: { completedToday: number };
  recentCompleted: Array<{
    id: number;
    order: string;
    contact: string | null;
    result: string | null;
    endedAt: number | null;
  }>;
}

interface AutomationCalls {
  ready: boolean;
  promptValidated: boolean;
  agentVersionPinned: boolean;
  configuredAgentVersion: string | null;
  lastCallAgentVersion: string | null;
  blockedReason?: string | null;
  killSwitchActive?: boolean;
  blockers: string[];
}

/** Resultados de llamada (enum de calls/results.ts) en palabras. */
const RESULT_LABEL: Record<string, string> = {
  confirmado: "Confirmado",
  confirmado_con_correccion: "Confirmado con corrección",
  cancelado: "Cancelado",
  no_reconoce_pedido: "No reconoce el pedido",
  numero_equivocado: "Número equivocado",
  no_volver_a_llamar: "No volver a llamar",
  incidencia_precio: "Incidencia de precio",
  no_disponible: "No disponible",
  rellamar: "Pidió rellamar",
  no_contesta: "No contesta",
  buzon_de_voz: "Buzón de voz",
  fallo_tecnico: "Fallo técnico",
};

function resultLabel(result: string | null): string {
  if (!result) return "Sin resultado";
  return RESULT_LABEL[result] ?? result.replace(/_/g, " ");
}

/** Teléfono enmascarado en el cliente: solo los últimos 4 dígitos. */
function maskPhone(phone: string | null): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length > 4 ? `···${d.slice(-4)}` : "···";
}

/** Acento de urgencia en el borde izquierdo de cada tarjeta. */
function accentClass(urgency: number): string {
  if (urgency <= 2) return "border-l-2 border-l-red-500/70";
  if (urgency <= 4) return "border-l-2 border-l-amber-500/70";
  return "border-l-2 border-l-brand-border";
}

function MicroSection({ label, children }: { label: string; children: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-brand-muted mb-1">{label}</div>
      <div className="text-sm text-brand-text leading-snug">{children}</div>
    </div>
  );
}

function IdentityFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-brand-muted">{label}</div>
      <div className="mt-0.5 text-sm text-brand-text whitespace-nowrap">{children}</div>
    </div>
  );
}

export default function AgentPanel({ onNavigate }: { onNavigate: (v: DockView) => void }) {
  const [data, setData] = useState<AgentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calls, setCalls] = useState<CallsData | null>(null);
  const [automation, setAutomation] = useState<AutomationCalls | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agent", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as AgentData;
      if (!j.ok) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudo cargar el copiloto. Reintentando…");
    }
  }, []);

  const refreshCalls = useCallback(async () => {
    try {
      const [callsRes, intRes] = await Promise.all([
        fetch("/api/calls", { cache: "no-store" }),
        fetch("/api/integrations", { cache: "no-store" }),
      ]);
      if (callsRes.ok) {
        const j = (await callsRes.json()) as CallsData;
        if (j.config && j.summary) setCalls(j);
      }
      if (intRes.ok) {
        const ji = (await intRes.json()) as { ok?: boolean; automation?: { calls?: AutomationCalls } };
        if (ji.ok && ji.automation?.calls) setAutomation(ji.automation.calls);
      }
    } catch {
      // silenciar: la identidad se rellena en el siguiente ciclo
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshCalls();
    const t = setInterval(refresh, 20_000);
    const t2 = setInterval(refreshCalls, 30_000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [refresh, refreshCalls]);

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  const retellConfigured =
    calls !== null &&
    calls.config.retellApiKey === "configured" &&
    calls.config.retellFromNumber === "configured" &&
    calls.config.retellAgentId === "configured";

  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-8">
      <div className="max-w-[1280px] space-y-6">
        {/* ── Identidad de Lucía (§43) ── */}
        <section>
          <SectionTitle>Agente</SectionTitle>
          {!calls ? (
            <Skeleton className="h-[88px]" />
          ) : (
            <Card className="px-4 py-4">
              <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
                <div className="flex items-center gap-3">
                  <span
                    className="shrink-0 h-11 w-11 rounded-full flex items-center justify-center font-semibold text-brand-gold border border-brand-border-strong bg-brand-surface-2"
                    aria-hidden
                  >
                    L
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-brand-text">Lucía</div>
                    <div className="text-[11px] text-brand-muted">Agente de llamadas de confirmación</div>
                  </div>
                </div>
                <IdentityFact label="Estado">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={calls.config.aiCallsEnabled ? "ok" : "muted"} />
                    {calls.config.aiCallsEnabled ? "MANUAL" : "APAGADO"}
                    {calls.config.aiCallsEnabled && calls.config.shadowMode ? (
                      <span className="text-[11px] text-brand-muted">(sombra)</span>
                    ) : null}
                  </span>
                </IdentityFact>
                <IdentityFact label="Retell">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={retellConfigured ? "ok" : "muted"} />
                    {retellConfigured ? "Conectado" : "Sin configurar"}
                  </span>
                </IdentityFact>
                <IdentityFact label="Prompt">
                  {automation ? (
                    automation.promptValidated ? (
                      <span className="text-emerald-600">Validado ✓</span>
                    ) : (
                      <span className="text-amber-600">No validado ✗</span>
                    )
                  ) : (
                    "—"
                  )}
                </IdentityFact>
                <IdentityFact label="Versión">
                  {automation?.configuredAgentVersion ?? <span className="text-amber-600">SIN FIJAR</span>}
                </IdentityFact>
                {automation?.blockedReason || automation?.killSwitchActive ? (
                  <IdentityFact label="Bloqueo">
                    <span className="text-red-700">
                      {automation.killSwitchActive ? "EMERGENCY_STOP activo" : null}
                      {automation.killSwitchActive && automation.blockedReason ? " · " : null}
                      {automation.blockedReason ? `bloqueadas: ${automation.blockedReason}` : null}
                    </span>
                  </IdentityFact>
                ) : null}
                <IdentityFact label="Llamadas hoy">
                  {formatInt(calls.summary.completedToday)}/{formatInt(calls.config.dailyCap)}
                </IdentityFact>
              </div>
            </Card>
          )}
        </section>

        {/* ── Necesita atención ── */}
        <section>
          <SectionTitle
            right={data && data.summary.total === 0 ? <span className="text-[11px] text-brand-muted">todo al día</span> : null}
          >
            Necesita atención{data ? `: ${formatInt(data.summary.total)}` : ""}
          </SectionTitle>
          <p className="text-sm text-brand-muted -mt-1 mb-4">
            Tu copiloto operativo: qué está pasando, qué falta y qué haría yo.
          </p>

          {/* Resumen */}
          {!data ? (
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[76px]" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <KpiTile label="Pendientes" value={formatInt(data.summary.total)} />
              <KpiTile
                label="Urgentes"
                value={formatInt(data.summary.urgent)}
                status={data.summary.urgent > 0 ? "error" : "ok"}
              />
              <KpiTile
                label="Para Beeping"
                value={formatInt(data.summary.awaitingRelease)}
                status={data.summary.awaitingRelease > 0 ? "warn" : undefined}
              />
            </div>
          )}
        </section>

        {/* Lista de trabajo */}
        <section className="space-y-3">
          {!data ? (
            <>
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </>
          ) : data.items.length === 0 ? (
            <Card>
              <EmptyState title="Nada requiere intervención. El agente sigue vigilando." />
            </Card>
          ) : (
            data.items.map((item) => (
              <Card key={`${item.type}:${item.orderId}`} className={`px-4 py-3.5 ${accentClass(item.urgency)}`}>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <span className="text-sm font-semibold text-brand-text">#{item.orderNumber}</span>
                    <span className="text-sm text-brand-muted"> · {item.customer}</span>
                    <span className="ml-2 text-[11px] text-brand-muted whitespace-nowrap">{timeAgo(item.sinceAt)}</span>
                  </div>
                  <GhostButton
                    className="px-3 py-1.5 text-xs shrink-0"
                    onClick={() => onNavigate(item.type === "BEEPING_RELEASE" ? "orders" : "actions")}
                  >
                    Abrir
                  </GhostButton>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <MicroSection label="Qué pasa">{item.whatsHappening}</MicroSection>
                  <MicroSection label="Qué falta">{item.whatsMissing}</MicroSection>
                  <MicroSection label="Recomendación">{item.recommendation}</MicroSection>
                </div>
              </Card>
            ))
          )}
        </section>

        {/* ── Últimas llamadas ── */}
        <section>
          <SectionTitle>Últimas llamadas</SectionTitle>
          {!calls ? (
            <Skeleton className="h-24" />
          ) : calls.recentCompleted.length === 0 ? (
            <Card>
              <EmptyState
                title="Aún no hay llamadas completadas."
                hint="Cuando Lucía termine una llamada, su resultado aparecerá aquí."
              />
            </Card>
          ) : (
            <Card className="divide-y divide-brand-border">
              {calls.recentCompleted.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="text-sm font-semibold text-brand-text shrink-0">#{c.order}</span>
                  <span className="text-xs text-brand-muted shrink-0">{maskPhone(c.contact)}</span>
                  <span className="flex-1 text-sm text-brand-text text-right truncate">{resultLabel(c.result)}</span>
                  <span className="text-[11px] text-brand-muted whitespace-nowrap shrink-0">{timeAgo(c.endedAt)}</span>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
