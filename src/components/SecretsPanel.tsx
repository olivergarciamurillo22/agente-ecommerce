"use client";

// ============================================================
// Ajustes → Integraciones → Claves de conexión (10-09-2026)
//
// Aquí el dueño de la instalación pone y renueva SUS claves sin depender de
// nadie. Decisiones de la pantalla, y por qué:
//
//   · El valor nunca se muestra: solo los cuatro últimos caracteres. Si el
//     cliente no reconoce la clave por ahí, la vuelve a pegar; enseñarla
//     entera solo añade una forma de que se filtre por encima del hombro.
//   · Antes de guardar se prueba contra el proveedor. Si falla, NO se guarda,
//     y se explica qué respondió. Para las que no se pueden probar solas
//     (secretos de firma) se dice claramente, en vez de fingir un «ok».
//   · Las críticas van marcadas: si el cliente las pega mal, tumba producción.
//     Para forzarlas tras un fallo hay que confirmar a propósito.
//   · Se ve de dónde sale la que está en uso: la del panel o la del servidor.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, SectionTitle, Badge, StatusDot, PrimaryButton, GhostButton, ErrorState, Skeleton, INPUT_CLASS, timeAgo, type UiStatus } from "./ui";

type Risk = "critico" | "alto" | "normal";
type VerifyStatus = "ok" | "fallo" | "no_verificable" | "sin_verificar";

interface SecretMeta {
  name: string; label: string; group: string; impact: string; where: string;
  risk: Risk; verifiable: boolean;
  stored: boolean; inEnv: boolean; source: "panel" | "env" | "ninguna";
  last4: string | null; updatedAt: number | null; updatedBy: string | null;
  verifyStatus: VerifyStatus; verifyMessage: string | null; verifiedAt: number | null;
}

interface Respuesta { ok: boolean; available: boolean; reason: string | null; secrets: SecretMeta[] }

const ESTADO_FUENTE: Record<SecretMeta["source"], { texto: string; ui: UiStatus }> = {
  panel: { texto: "puesta desde el panel", ui: "ok" },
  env: { texto: "la del servidor", ui: "muted" },
  ninguna: { texto: "sin configurar", ui: "warn" },
};

export default function SecretsPanel() {
  const [data, setData] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<{ name: string; tipo: "ok" | "error"; texto: string; puedeForzar?: boolean; textoForzar?: string } | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await fetch("/api/secrets", { cache: "no-store" });
      if (res.status === 403) { setError("Solo el propietario de la cuenta puede ver y cambiar las claves."); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as Respuesta);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "no se pudo cargar");
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const grupos = useMemo(() => {
    const m = new Map<string, SecretMeta[]>();
    for (const s of data?.secrets ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [data]);

  async function guardar(name: string, force = false) {
    setGuardando(true);
    setAviso(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, value: valor, ...(force ? { force: true } : {}) }),
      });
      const j = await res.json() as { ok: boolean; message?: string; error?: string; canForce?: boolean; forceWarning?: string };
      if (j.ok) {
        setAviso({ name, tipo: "ok", texto: j.message ?? "guardada" });
        setValor("");
        setAbierta(null);
        await cargar();
      } else {
        setAviso({ name, tipo: "error", texto: j.error ?? "no se pudo guardar", puedeForzar: j.canForce, textoForzar: j.forceWarning });
      }
    } catch (e) {
      setAviso({ name, tipo: "error", texto: e instanceof Error ? e.message : "no se pudo guardar" });
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(name: string) {
    setGuardando(true);
    try {
      const res = await fetch("/api/secrets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, clear: true }) });
      const j = await res.json() as { ok: boolean; message?: string; error?: string };
      setAviso({ name, tipo: j.ok ? "ok" : "error", texto: j.message ?? j.error ?? "" });
      await cargar();
    } finally {
      setGuardando(false);
    }
  }

  if (error) return <ErrorState message={error} onRetry={cargar} />;

  return (
    <div>
      <SectionTitle>Claves de conexión</SectionTitle>

      {!data ? (
        <Card className="p-4"><Skeleton className="h-40 w-full" /></Card>
      ) : !data.available ? (
        <Card className="p-4">
          <p className="text-sm text-brand-text font-medium">Las claves no se pueden gestionar desde aquí todavía.</p>
          <p className="mt-1 text-[12px] text-brand-muted">{data.reason}</p>
          <p className="mt-2 text-[12px] text-brand-muted">
            Es una única variable que se pone una vez al instalar. Hasta entonces, las claves siguen saliendo del servidor y funcionan igual.
          </p>
        </Card>
      ) : (
        <div className="space-y-5">
          <p className="text-[12px] text-brand-muted">
            Aquí pones tus propias claves. Se guardan cifradas y no se muestran nunca enteras.
            Antes de guardar, cada una se prueba contra su proveedor: si no responde, no se guarda.
          </p>

          {grupos.map(([grupo, claves]) => (
            <Card key={grupo} className="divide-y divide-brand-border overflow-hidden">
              <div className="px-4 py-2.5 bg-brand-surface-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-muted">{grupo}</span>
              </div>

              {claves.map((s) => {
                const fuente = ESTADO_FUENTE[s.source];
                const abierto = abierta === s.name;
                const msg = aviso?.name === s.name ? aviso : null;
                return (
                  <div key={s.name} className="px-4 py-3.5">
                    <div className="flex items-start gap-3">
                      <span className="mt-1.5 shrink-0"><StatusDot status={fuente.ui} /></span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-brand-text">{s.label}</span>
                          {s.risk === "critico" && <Badge status="error">Crítica</Badge>}
                          {s.source === "panel" && s.last4 && (
                            <span className="text-[11px] text-brand-muted font-mono">···{s.last4}</span>
                          )}
                        </div>

                        <p className="mt-0.5 text-[11px] text-brand-muted leading-snug">
                          {fuente.texto}
                          {s.updatedAt && s.source === "panel" ? ` · ${timeAgo(s.updatedAt)}${s.updatedBy ? ` por ${s.updatedBy}` : ""}` : ""}
                        </p>

                        {s.source === "panel" && s.verifyStatus === "no_verificable" && s.verifyMessage && (
                          <p className="mt-1 text-[11px] text-brand-muted leading-snug">Sin comprobación automática: {s.verifyMessage}</p>
                        )}
                        {s.source === "ninguna" && (
                          <p className="mt-1 text-[11px] text-brand-muted leading-snug">{s.impact}</p>
                        )}

                        {abierto && (
                          <div className="mt-3 space-y-2">
                            <p className="text-[11px] text-brand-muted leading-snug"><strong className="text-brand-text">Dónde sacarla:</strong> {s.where}</p>
                            {s.risk === "critico" && (
                              <p className="text-[11px] text-brand-warn leading-snug">Ojo, esta es crítica: {s.impact}</p>
                            )}
                            <input
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              className={`${INPUT_CLASS} w-full`}
                              placeholder="Pega aquí la clave"
                              value={valor}
                              onChange={(e) => setValor(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter" && valor.trim() && !guardando) void guardar(s.name); }}
                            />
                            <div className="flex flex-wrap gap-2">
                              <PrimaryButton onClick={() => void guardar(s.name)} disabled={!valor.trim()} busy={guardando}>
                                {s.verifiable ? "Comprobar y guardar" : "Guardar"}
                              </PrimaryButton>
                              <GhostButton onClick={() => { setAbierta(null); setValor(""); setAviso(null); }}>Cancelar</GhostButton>
                              {s.stored && (
                                <GhostButton onClick={() => void borrar(s.name)} disabled={guardando}>
                                  Borrar la del panel
                                </GhostButton>
                              )}
                            </div>
                          </div>
                        )}

                        {msg && (
                          <div className={`mt-2 text-[11px] leading-snug ${msg.tipo === "ok" ? "text-brand-ok" : "text-brand-error"}`}>
                            <p>{msg.texto}</p>
                            {msg.puedeForzar && (
                              <div className="mt-1.5">
                                <p className="text-brand-muted">{msg.textoForzar}</p>
                                <TextoForzar onForzar={() => void guardar(s.name, true)} disabled={guardando} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {!abierto && (
                        <GhostButton onClick={() => { setAbierta(s.name); setValor(""); setAviso(null); }}>
                          {s.source === "ninguna" ? "Poner clave" : "Cambiar"}
                        </GhostButton>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** Forzar tras un fallo exige un clic aparte: que no se haga sin querer. */
function TextoForzar({ onForzar, disabled }: { onForzar: () => void; disabled: boolean }) {
  const [confirmando, setConfirmando] = useState(false);
  if (!confirmando) {
    return <button type="button" className="mt-1 underline text-brand-muted hover:text-brand-text" onClick={() => setConfirmando(true)}>Guardarla igualmente</button>;
  }
  return (
    <div className="mt-1 flex gap-2">
      <button type="button" className="underline text-brand-error" disabled={disabled} onClick={onForzar}>Sí, guardar sin comprobar</button>
      <button type="button" className="underline text-brand-muted" onClick={() => setConfirmando(false)}>No</button>
    </div>
  );
}
