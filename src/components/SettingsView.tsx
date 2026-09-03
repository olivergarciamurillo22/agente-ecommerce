"use client";

// ============================================================
// AJUSTES (§45): mini-navegación lateral en md+ (chips horizontales en
// móvil) con seis secciones:
//   General       → SettingsPanel (los ajustes del bot, sin tocar)
//   WhatsApp      → proveedor + semáforo de automatización + rampa (§9/§57)
//   Llamadas      → Lucía: estado, preflight, contadores y config (§28)
//   Integraciones → IntegrationsPanel
//   Costes        → CostsPanel
//   Sistema       → SystemPanel (el Control Center existente, sin tocar)
// ============================================================

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Card,
  Chip,
  ErrorState,
  formatInt,
  GhostButton,
  KpiTile,
  ModalShell,
  PrimaryButton,
  SectionTitle,
  Skeleton,
  StatusDot,
} from "./ui";
import IntegrationsPanel from "./IntegrationsPanel";
import SystemPanel from "./SystemPanel";
import SettingsPanel from "./SettingsPanel";
import CostsPanel from "./CostsPanel";

type SettingsSection = "general" | "whatsapp" | "calls" | "integrations" | "costs" | "system";

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "Agente IA" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "calls", label: "Llamadas" },
  { id: "integrations", label: "Integraciones" },
  { id: "costs", label: "Costes" },
  { id: "system", label: "Sistema" },
];

// --- Tipos compartidos de /api/integrations (automation §57) ---

type RolloutMode = "pilot" | "25" | "50" | "100";

interface AutomationWhatsApp {
  ready: boolean;
  mode: RolloutMode;
  testMode: boolean;
  blockers: string[];
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

interface IntegrationsResponse {
  ok: boolean;
  automation?: { whatsapp?: AutomationWhatsApp; calls?: AutomationCalls };
  connection?: { provider?: string };
}

/** Banner §57: READY en verde, BLOCKED en ámbar con los bloqueantes SIEMPRE visibles. */
function AutomationBanner({ title, ready, blockers }: { title: string; ready: boolean; blockers: string[] }) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        ready ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={ready ? "ok" : "warn"} />
        <span className={`text-[11px] font-bold tracking-[0.14em] ${ready ? "text-emerald-600" : "text-amber-600"}`}>
          {title}: {ready ? "READY" : "BLOCKED"}
        </span>
      </div>
      {!ready && blockers.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {blockers.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-amber-600/90 leading-snug">
              <span className="mt-1.5 h-1 w-1 rounded-full bg-amber-500 shrink-0" aria-hidden />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Fila etiqueta → valor dentro de una superficie agrupada. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-sm text-brand-muted">{label}</span>
      <span className="text-sm text-brand-text text-right min-w-0">{children}</span>
    </div>
  );
}

// ============================================================
// WHATSAPP (§9 + §47 + §57)
// ============================================================

interface ConnectionStatus {
  status: string;
  provider?: string;
  phone: string | null;
}

const ROLLOUT_OPTIONS: Array<{ value: RolloutMode; label: string }> = [
  { value: "pilot", label: "PILOTO" },
  { value: "25", label: "25%" },
  { value: "50", label: "50%" },
  { value: "100", label: "100%" },
];

function rolloutAudience(mode: RolloutMode): string {
  if (mode === "pilot") return "Solo los teléfonos de la lista de pruebas.";
  return `La lista de pruebas y aproximadamente el ${mode}% de los clientes (asignación estable por teléfono).`;
}

function providerLabel(provider: string | null): string {
  if (provider === "cloud_api") return "API oficial de Meta";
  if (provider === "baileys") return "Baileys (WhatsApp Web)";
  return "—";
}

function connectionLabel(status: string): { text: string; ui: "ok" | "warn" | "error" | "muted" } {
  if (status === "connected") return { text: "Conectado", ui: "ok" };
  if (status === "connecting") return { text: "Conectando…", ui: "warn" };
  if (status === "qr") return { text: "Esperando escaneo del código QR", ui: "warn" };
  if (status === "disconnected") return { text: "Desconectado", ui: "error" };
  return { text: "Sin datos", ui: "muted" };
}

function WhatsAppSection() {
  const [automation, setAutomation] = useState<AutomationWhatsApp | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnectionStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rolloutTarget, setRolloutTarget] = useState<RolloutMode | null>(null);
  const [rolloutSaving, setRolloutSaving] = useState(false);
  const [rolloutError, setRolloutError] = useState<string | null>(null);

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [intRes, connRes] = await Promise.all([
        fetch("/api/integrations", { cache: "no-store" }),
        fetch("/api/connection/status", { cache: "no-store" }),
      ]);
      if (!intRes.ok) throw new Error(`HTTP ${intRes.status}`);
      const j = (await intRes.json()) as IntegrationsResponse;
      if (!j.ok || !j.automation?.whatsapp) throw new Error("respuesta inválida");
      setAutomation(j.automation.whatsapp);
      setProvider(j.connection?.provider ?? null);
      if (connRes.ok) {
        const c = (await connRes.json()) as ConnectionStatus;
        setConn(c);
        if (!j.connection?.provider && c.provider) setProvider(c.provider);
      }
      setError(null);
      setLoaded(true);
    } catch {
      setError("No se pudo cargar el estado de WhatsApp.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const applyRollout = useCallback(async () => {
    if (!rolloutTarget) return;
    setRolloutSaving(true);
    setRolloutError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "whatsapp_rollout_percent", value: rolloutTarget }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setRolloutError(j.error ?? `No se pudo guardar el cambio (HTTP ${res.status}).`);
      } else {
        setRolloutTarget(null);
        await refresh();
      }
    } catch {
      setRolloutError("Sin conexión con el panel; reintenta.");
    } finally {
      setRolloutSaving(false);
    }
  }, [rolloutTarget, refresh]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const res = await fetch("/api/connection/disconnect", { method: "POST", cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || !j.ok) {
        setDisconnectError(`No se pudo desconectar la sesión (HTTP ${res.status}).`);
      } else {
        setDisconnectOpen(false);
        await refresh();
      }
    } catch {
      setDisconnectError("Sin conexión con el panel; reintenta.");
    } finally {
      setDisconnecting(false);
    }
  }, [refresh]);

  if (error && !loaded) return <ErrorState message={error} onRetry={refresh} />;

  if (!loaded || !automation) {
    return (
      <div className="space-y-3">
        <SectionTitle>WhatsApp</SectionTitle>
        <Skeleton className="h-14" />
        <Skeleton className="h-40" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  const isBaileys = provider === "baileys";
  const connInfo = conn ? connectionLabel(conn.status) : null;
  const currentMode = automation.mode;

  return (
    <div className="space-y-5">
      <SectionTitle>WhatsApp</SectionTitle>

      <AutomationBanner title="AUTOMATIZACIÓN WHATSAPP" ready={automation.ready} blockers={automation.blockers} />

      {/* Conexión */}
      <Card className="divide-y divide-brand-border">
        <InfoRow label="Proveedor">{providerLabel(provider)}</InfoRow>
        {connInfo ? (
          <InfoRow label="Conexión">
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={connInfo.ui} />
              {connInfo.text}
              {conn?.phone ? <span className="text-brand-muted"> · +{conn.phone}</span> : null}
            </span>
          </InfoRow>
        ) : null}
        {automation.testMode ? (
          <InfoRow label="Modo de pruebas">
            <span className="text-amber-600">TEST_MODE activo: solo la lista de pruebas y la rampa reciben mensajes.</span>
          </InfoRow>
        ) : null}
      </Card>

      {/* Rampa (§9) */}
      <section>
        <div className="text-[13px] font-medium text-brand-muted mb-2">Rampa de envío automático</div>
        <Card className="px-4 py-4 space-y-3">
          <p className="text-xs text-brand-muted leading-snug">
            Controla a cuántos clientes reales llega la confirmación automática. La asignación es estable por teléfono: subir y bajar la rampa no cambia quién está dentro.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {ROLLOUT_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                active={currentMode === o.value}
                onClick={() => {
                  if (o.value !== currentMode) {
                    setRolloutError(null);
                    setRolloutTarget(o.value);
                  }
                }}
              >
                {o.label}
              </Chip>
            ))}
          </div>
          <p className="text-xs text-brand-text leading-snug">
            Ahora mismo: <span className="font-semibold">{rolloutAudience(currentMode)}</span>
          </p>
        </Card>
      </section>

      {/* Sesión de WhatsApp Web — SOLO Baileys (§47: con cloud_api no existe esta semántica) */}
      {isBaileys ? (
        <section>
          <div className="text-[13px] font-medium text-brand-muted mb-2">Sesión de WhatsApp Web</div>
          <Card className="px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="flex-1 text-xs text-brand-muted leading-snug">
              Cierra la sesión de Baileys en este servidor. Para volver a conectar habrá que escanear el código QR otra vez desde el móvil.
            </p>
            <PrimaryButton danger onClick={() => { setDisconnectError(null); setDisconnectOpen(true); }} className="shrink-0">
              Desconectar sesión
            </PrimaryButton>
          </Card>
        </section>
      ) : null}

      {/* Confirmación de cambio de rampa */}
      <ModalShell open={rolloutTarget !== null} onClose={() => (rolloutSaving ? null : setRolloutTarget(null))} title="Cambiar la rampa de WhatsApp">
        {rolloutTarget ? (
          <div className="space-y-3">
            <p className="text-sm text-brand-text leading-snug">
              Vas a pasar la rampa a{" "}
              <span className="font-semibold">{ROLLOUT_OPTIONS.find((o) => o.value === rolloutTarget)?.label}</span>.
            </p>
            <div className="rounded-xl border border-brand-border bg-brand-surface-2 px-3.5 py-3">
              <div className="text-[12px] font-medium text-brand-muted mb-1">Quién recibirá mensajes ahora mismo</div>
              <p className="text-sm text-brand-text leading-snug">{rolloutAudience(rolloutTarget)}</p>
            </div>
            {rolloutError ? <div className="text-xs text-red-600 leading-snug">{rolloutError}</div> : null}
            <div className="flex justify-end gap-2 pt-1">
              <GhostButton onClick={() => setRolloutTarget(null)} disabled={rolloutSaving}>
                Cancelar
              </GhostButton>
              <PrimaryButton onClick={applyRollout} busy={rolloutSaving}>
                Confirmar cambio
              </PrimaryButton>
            </div>
          </div>
        ) : null}
      </ModalShell>

      {/* Confirmación de desconexión (solo Baileys) */}
      <ModalShell open={disconnectOpen} onClose={() => (disconnecting ? null : setDisconnectOpen(false))} title="Desconectar la sesión de WhatsApp">
        <div className="space-y-3">
          <p className="text-sm text-brand-text leading-snug">
            Se cerrará la sesión de WhatsApp Web y el agente dejará de enviar y recibir mensajes hasta que vuelvas a escanear el código QR.
          </p>
          {disconnectError ? <div className="text-xs text-red-600 leading-snug">{disconnectError}</div> : null}
          <div className="flex justify-end gap-2 pt-1">
            <GhostButton onClick={() => setDisconnectOpen(false)} disabled={disconnecting}>
              Cancelar
            </GhostButton>
            <PrimaryButton danger onClick={disconnect} busy={disconnecting}>
              Desconectar
            </PrimaryButton>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

// ============================================================
// LLAMADAS (§28 + §57)
// ============================================================

interface CallConfigView {
  aiCallsEnabled: boolean;
  shadowMode: boolean;
  dailyCap: number;
  allowlist: string[];
  triggerMinutes: number;
  maxContacts: number;
  firstRetryMinutes: number;
  retellApiKey: "configured" | "missing";
  retellFromNumber: "configured" | "missing";
  retellAgentId: "configured" | "missing";
}

interface CallsSummary {
  planned: number;
  inFlight: number;
  completedToday: number;
  manualReview: number;
  shadowPending: number;
}

interface CallsData {
  config: CallConfigView;
  summary: CallsSummary;
}

function CallsSection() {
  const [calls, setCalls] = useState<CallsData | null>(null);
  const [automation, setAutomation] = useState<AutomationCalls | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Borradores de los campos editables (se envían al salir del campo).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Confirmación para los dos cambios delicados.
  const [confirmAction, setConfirmAction] = useState<"enable_calls" | "disable_shadow" | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [callsRes, intRes] = await Promise.all([
        fetch("/api/calls", { cache: "no-store" }),
        fetch("/api/integrations", { cache: "no-store" }),
      ]);
      if (!callsRes.ok) throw new Error(`HTTP ${callsRes.status}`);
      const j = (await callsRes.json()) as CallsData;
      if (!j.config || !j.summary) throw new Error("respuesta inválida");
      setCalls(j);
      if (intRes.ok) {
        const ji = (await intRes.json()) as IntegrationsResponse;
        if (ji.ok && ji.automation?.calls) setAutomation(ji.automation.calls);
      }
      setError(null);
    } catch {
      setError("No se pudo cargar el estado de las llamadas.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const saveConfig = useCallback(
    async (key: string, value: string): Promise<boolean> => {
      setSaveError(null);
      try {
        const res = await fetch("/api/calls", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !j.ok) {
          setSaveError(j.error ?? `No se pudo guardar "${key}" (HTTP ${res.status}).`);
          return false;
        }
        setSavedKey(key);
        setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500);
        await refresh();
        return true;
      } catch {
        setSaveError("Sin conexión con el panel; reintenta.");
        return false;
      }
    },
    [refresh]
  );

  const confirmDangerous = useCallback(async () => {
    if (!confirmAction) return;
    setConfirmBusy(true);
    const ok =
      confirmAction === "enable_calls"
        ? await saveConfig("ai_calls_enabled", "1")
        : await saveConfig("calls_shadow_mode", "0");
    setConfirmBusy(false);
    if (ok) setConfirmAction(null);
  }, [confirmAction, saveConfig]);

  if (error && !calls) return <ErrorState message={error} onRetry={refresh} />;

  if (!calls) {
    return (
      <div className="space-y-3">
        <SectionTitle>Llamadas</SectionTitle>
        <Skeleton className="h-14" />
        <Skeleton className="h-36" />
        <Skeleton className="h-52" />
      </div>
    );
  }

  const cfg = calls.config;
  const retellConfigured = cfg.retellApiKey === "configured" && cfg.retellFromNumber === "configured" && cfg.retellAgentId === "configured";
  // "AUTOMÁTICO" no existe todavía: el scheduler solo dispara en manual.
  const estado = cfg.aiCallsEnabled ? "MANUAL" : "APAGADO";

  const draftOr = (key: string, current: string): string => drafts[key] ?? current;
  const numberField = (key: string, label: string, current: number, hint: string) => (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-brand-text">
          {label}
          {savedKey === key ? <span className="ml-2 text-[11px] text-emerald-600">guardado ✓</span> : null}
        </div>
        <div className="text-[11px] text-brand-muted leading-snug">{hint}</div>
      </div>
      <input
        type="number"
        min={1}
        value={draftOr(key, String(current))}
        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={() => {
          const v = (drafts[key] ?? "").trim();
          if (v !== "" && v !== String(current)) {
            void saveConfig(key, v).then((ok) => {
              if (ok) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
            });
          }
        }}
        className="w-full sm:w-24 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text text-right focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30"
      />
    </div>
  );

  const toggle = (
    key: "ai_calls_enabled" | "calls_shadow_mode",
    label: string,
    hint: string,
    on: boolean,
    onLabel: string,
    offLabel: string,
    dangerousTurnOn: boolean,
    dangerousTurnOff: boolean
  ) => (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-brand-text">
          {label}
          {savedKey === key ? <span className="ml-2 text-[11px] text-emerald-600">guardado ✓</span> : null}
        </div>
        <div className="text-[11px] text-brand-muted leading-snug">{hint}</div>
      </div>
      <div className="inline-flex rounded-xl border border-brand-border p-0.5 bg-brand-bg shrink-0">
        <button
          type="button"
          onClick={() => {
            if (on) return;
            if (dangerousTurnOn) setConfirmAction(key === "ai_calls_enabled" ? "enable_calls" : "disable_shadow");
            else void saveConfig(key, "1");
          }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
            on ? "bg-brand-gold text-white" : "text-brand-muted hover:text-brand-text"
          }`}
        >
          {onLabel}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!on) return;
            if (dangerousTurnOff) setConfirmAction(key === "ai_calls_enabled" ? "enable_calls" : "disable_shadow");
            else void saveConfig(key, "0");
          }}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
            !on ? "bg-brand-surface-2 text-brand-text" : "text-brand-muted hover:text-brand-text"
          }`}
        >
          {offLabel}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <SectionTitle>Llamadas</SectionTitle>

      <AutomationBanner
        title="AUTOMATIZACIÓN LLAMADAS"
        ready={automation?.ready ?? false}
        blockers={automation?.blockers ?? ["No se pudo comprobar el preflight de llamadas."]}
      />

      {/* Identidad y preflight de Lucía */}
      <Card className="divide-y divide-brand-border">
        <InfoRow label="Agente">
          <span className="font-semibold">Lucía</span>
        </InfoRow>
        <InfoRow label="Estado">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={cfg.aiCallsEnabled ? "ok" : "muted"} />
            {estado}
            {cfg.aiCallsEnabled && cfg.shadowMode ? <span className="text-brand-muted"> · en sombra (no marca de verdad)</span> : null}
          </span>
        </InfoRow>
        <InfoRow label="Retell">
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status={retellConfigured ? "ok" : "muted"} />
            {retellConfigured ? "Conectado" : "Sin configurar"}
          </span>
        </InfoRow>
        <InfoRow label="Prompt">
          {automation ? (
            automation.promptValidated ? (
              <span className="text-emerald-600">Validado ✓</span>
            ) : (
              <span className="text-amber-600">No validado</span>
            )
          ) : (
            "—"
          )}
        </InfoRow>
        <InfoRow label="Versión del agente">
          <span>
            {automation?.configuredAgentVersion ?? <span className="text-amber-600 font-semibold">SIN FIJAR</span>}
            {automation && automation.configuredAgentVersion && !automation.agentVersionPinned ? (
              <span className="text-amber-600"> · no es un número: no sale ninguna llamada</span>
            ) : null}
            {automation?.lastCallAgentVersion ? (
              <span className="text-brand-muted"> · última llamada: {automation.lastCallAgentVersion}</span>
            ) : null}
          </span>
        </InfoRow>
        {automation?.blockedReason || automation?.killSwitchActive ? (
          <InfoRow label="Bloqueo">
            <span className="text-red-700">
              {automation.killSwitchActive ? "EMERGENCY_STOP activo: no sale ninguna llamada. " : null}
              {automation.blockedReason ? `Bloqueadas por el sistema: ${automation.blockedReason} (desbloquear con retell:doctor --unblock tras revisar)` : null}
            </span>
          </InfoRow>
        ) : null}
      </Card>

      {/* Contadores del día */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile label="Llamadas hoy" value={`${formatInt(calls.summary.completedToday)}/${formatInt(cfg.dailyCap)}`} support="completadas / tope diario" />
        <KpiTile
          label="Planificadas"
          value={formatInt(calls.summary.planned)}
          support={calls.summary.shadowPending > 0 ? `${formatInt(calls.summary.shadowPending)} en sombra` : undefined}
        />
        <KpiTile label="En curso" value={formatInt(calls.summary.inFlight)} />
        <KpiTile
          label="Revisión manual"
          value={formatInt(calls.summary.manualReview)}
          status={calls.summary.manualReview > 0 ? "warn" : undefined}
        />
      </div>

      {/* Configuración editable */}
      <section>
        <div className="text-[13px] font-medium text-brand-muted mb-2">Configuración</div>
        <Card className="divide-y divide-brand-border">
          {toggle(
            "ai_calls_enabled",
            "Llamadas activadas",
            "El interruptor general. Apagado, no sale ninguna llamada pase lo que pase.",
            cfg.aiCallsEnabled,
            "Encendidas",
            "Apagadas",
            true,
            false
          )}
          {toggle(
            "calls_shadow_mode",
            "Modo sombra",
            "Activado, el sistema planifica y registra las llamadas pero no marca de verdad.",
            cfg.shadowMode,
            "Activado",
            "Desactivado",
            false,
            true
          )}
          {numberField("calls_daily_cap", "Tope diario de llamadas", cfg.dailyCap, "Máximo de llamadas reales por día.")}
          {numberField("call_trigger_minutes", "Minutos hasta entrar en cola", cfg.triggerMinutes, "Sin respuesta al WhatsApp durante estos minutos → cola de llamadas.")}
          {numberField("call_max_contacts", "Contactos máximos por pedido", cfg.maxContacts, "Intento inicial + reintentos que puede consumir un pedido.")}
          {numberField("call_first_retry_minutes", "Primer reintento (minutos)", cfg.firstRetryMinutes, "Espera mínima antes del primer reintento, dentro de la franja legal.")}
          <div className="px-4 py-3 space-y-1.5">
            <div className="text-sm text-brand-text">
              Lista de teléfonos autorizados
              {savedKey === "calls_allowlist" ? <span className="ml-2 text-[11px] text-emerald-600">guardado ✓</span> : null}
            </div>
            <div className="text-[11px] text-brand-muted leading-snug">
              Separados por comas, formato internacional sin «+» (ej. 34600111222). En modo piloto, la lista vacía bloquea a todos.
            </div>
            <input
              type="text"
              value={draftOr("calls_allowlist", cfg.allowlist.join(", "))}
              onChange={(e) => setDrafts((d) => ({ ...d, calls_allowlist: e.target.value }))}
              onBlur={() => {
                const v = drafts["calls_allowlist"];
                if (v !== undefined && v.trim() !== cfg.allowlist.join(", ")) {
                  void saveConfig("calls_allowlist", v).then((ok) => {
                    if (ok) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== "calls_allowlist")));
                  });
                }
              }}
              placeholder="34600111222, 34600333444"
              className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 placeholder:text-brand-muted"
            />
          </div>
        </Card>
        {saveError ? <div className="mt-2 text-xs text-red-600 leading-snug">{saveError}</div> : null}
      </section>

      {/* Cómo probar (sin marcador libre, a propósito) */}
      <Card className="px-4 py-4">
        <div className="text-sm font-semibold text-brand-text mb-1">Probar con un número autorizado</div>
        <p className="text-xs text-brand-muted leading-snug">
          No hay marcador libre: Lucía solo llama sobre pedidos reales. Para probarla, añade tu teléfono a la lista de autorizados, abre en Pedidos uno cuyo teléfono esté en esa lista y usa «Llamar ahora». Así la prueba pasa por las mismas protecciones que una llamada real (franja horaria, tope diario y lista).
        </p>
      </Card>

      {/* Confirmación de los dos cambios delicados */}
      <ModalShell
        open={confirmAction !== null}
        onClose={() => (confirmBusy ? null : setConfirmAction(null))}
        title={confirmAction === "enable_calls" ? "Encender las llamadas" : "Desactivar el modo sombra"}
      >
        <div className="space-y-3">
          <p className="text-sm text-brand-text leading-snug">
            {confirmAction === "enable_calls"
              ? cfg.shadowMode
                ? "Con el modo sombra activado, el sistema empezará a planificar y registrar llamadas, pero todavía no marcará de verdad."
                : "El modo sombra está desactivado: al encender, las llamadas planificadas serán llamadas reales a los teléfonos permitidos."
              : "Sin modo sombra, las llamadas planificadas marcarán de verdad a los teléfonos permitidos por la lista y el tope diario."}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <GhostButton onClick={() => setConfirmAction(null)} disabled={confirmBusy}>
              Cancelar
            </GhostButton>
            <PrimaryButton onClick={confirmDangerous} busy={confirmBusy}>
              Confirmar
            </PrimaryButton>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

// ============================================================
// Contenedor con la mini-navegación
// ============================================================

/** Envoltorio de scroll con el mismo ritmo que el resto de vistas. */
function ScrollPane({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto px-4 md:px-8 py-5 pb-8">
      <div className={wide ? "max-w-[1280px]" : "max-w-[880px]"}>{children}</div>
    </div>
  );
}

export default function SettingsView() {
  const [section, setSection] = useState<SettingsSection>("whatsapp");

  return (
    <div className="h-full flex flex-col md:flex-row">
      {/* Móvil: chips horizontales */}
      <div className="md:hidden shrink-0 flex items-center gap-2 px-4 pt-4 pb-3 overflow-x-auto no-scrollbar">
        {SECTIONS.map((s) => (
          <Chip key={s.id} active={section === s.id} onClick={() => setSection(s.id)}>
            {s.label}
          </Chip>
        ))}
      </div>

      {/* md+: mini-navegación vertical */}
      <nav className="hidden md:flex flex-col gap-0.5 w-52 shrink-0 border-r border-brand-border px-3 py-5" aria-label="Secciones de ajustes">
        <div className="px-3 pb-2 text-[12px] font-medium text-brand-tertiary">Ajustes</div>
        {SECTIONS.map((s) => {
          const active = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`text-left rounded-lg px-3 py-2 text-sm transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30 ${
                active
                  ? "bg-brand-surface-2 text-brand-text font-medium"
                  : "text-brand-muted hover:text-brand-text hover:bg-brand-surface-2"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 overflow-hidden">
        {section === "general" ? (
          <SettingsPanel />
        ) : section === "whatsapp" ? (
          <ScrollPane>
            <WhatsAppSection />
          </ScrollPane>
        ) : section === "calls" ? (
          <ScrollPane>
            <CallsSection />
          </ScrollPane>
        ) : section === "integrations" ? (
          <ScrollPane wide>
            <IntegrationsPanel />
          </ScrollPane>
        ) : section === "costs" ? (
          <CostsPanel />
        ) : (
          <SystemPanel />
        )}
      </div>
    </div>
  );
}
