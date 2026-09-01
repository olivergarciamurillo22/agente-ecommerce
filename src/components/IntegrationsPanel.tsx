"use client";

// ============================================================
// INTEGRACIONES (Ajustes → Integraciones): una tarjeta por servicio con su
// estado real, su último éxito/error y, donde tiene sentido, una prueba de
// conexión READ-ONLY. Todo en el vocabulario visual de ui.tsx.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Card, ErrorState, formatInt, GhostButton, healthToUi, SectionTitle, Skeleton, StatusDot, STATUS_TEXT, timeAgo } from "./ui";

interface IntegrationCard {
  id: string;
  label: string;
  status: "healthy" | "warning" | "critical" | "disabled" | "unknown";
  message: string;
  configured: boolean;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  extra?: Record<string, unknown>;
  description: string;
}

interface IntegrationsData {
  ok: boolean;
  cards: IntegrationCard[];
}

interface BeepingShopOption {
  id: number;
  name: string;
}

const STATUS_LABEL: Record<IntegrationCard["status"], string> = {
  healthy: "CONECTADO",
  warning: "AVISO",
  critical: "ERROR",
  disabled: "SIN CONFIGURAR",
  unknown: "—",
};

function extraStr(extra: Record<string, unknown> | undefined, key: string): string | null {
  const v = extra?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function extraNum(extra: Record<string, unknown> | undefined, key: string): number | null {
  const v = extra?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Resultado de la prueba de conexión, ya convertido a una línea humana. */
interface TestResult {
  ok: boolean;
  detail: string;
}

export default function IntegrationsPanel() {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Estado de la prueba de conexión, por servicio.
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});

  // Detección de tienda de Beeping.
  const [discovering, setDiscovering] = useState(false);
  const [discoveryShops, setDiscoveryShops] = useState<BeepingShopOption[] | null>(null);
  const [selectedShopId, setSelectedShopId] = useState<number | null>(null);
  const [discoveryNote, setDiscoveryNote] = useState<TestResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as IntegrationsData;
      if (!j.ok || !Array.isArray(j.cards)) throw new Error("respuesta inválida");
      setData(j);
      setError(null);
    } catch {
      setError("No se pudo cargar el estado de las integraciones.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const runTest = useCallback(async (service: "beeping" | "meta_ads") => {
    setTesting((prev) => ({ ...prev, [service]: true }));
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      });
      const j = (await res.json()) as Record<string, unknown>;
      if (j.ok === true) {
        let detail: string;
        if (service === "beeping") {
          const n = typeof j.shopsCount === "number" ? j.shopsCount : 0;
          detail = `${formatInt(n)} tienda(s) visibles`;
        } else {
          const name = typeof j.accountName === "string" ? j.accountName : "cuenta sin nombre";
          const currency = typeof j.currency === "string" ? j.currency : "?";
          const tz = typeof j.timezone === "string" ? j.timezone : "?";
          const ads = j.adsRead === true ? "permiso ads_read OK" : "SIN permiso ads_read verificado";
          detail = `${name} (${currency}, ${tz}) · ${ads}`;
        }
        setTestResult((prev) => ({ ...prev, [service]: { ok: true, detail } }));
      } else {
        const msg = typeof j.error === "string" && j.error ? j.error : "la prueba falló sin detalle";
        setTestResult((prev) => ({ ...prev, [service]: { ok: false, detail: msg } }));
      }
    } catch {
      setTestResult((prev) => ({ ...prev, [service]: { ok: false, detail: "no se pudo contactar con el servidor" } }));
    } finally {
      setTesting((prev) => ({ ...prev, [service]: false }));
    }
  }, []);

  const discoverShops = useCallback(async () => {
    setDiscovering(true);
    setDiscoveryNote(null);
    setDiscoveryShops(null);
    try {
      const res = await fetch("/api/beeping", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discover_shops" }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        discovery?: { outcome?: string; error?: string; shops?: Array<{ id?: number; name?: string }> };
      };
      const outcome = j.discovery?.outcome ?? "error";
      if (outcome === "multiple") {
        const shops = (j.discovery?.shops ?? [])
          .filter((s): s is { id: number; name?: string } => typeof s.id === "number")
          .map((s) => ({ id: s.id, name: s.name ?? `tienda ${s.id}` }));
        setDiscoveryShops(shops);
        setSelectedShopId(shops[0]?.id ?? null);
        setDiscoveryNote({ ok: true, detail: `Hay ${shops.length} tiendas: elige cuál usar.` });
      } else if (outcome === "autodetected" || outcome === "cached") {
        setDiscoveryNote({ ok: true, detail: "Tienda detectada correctamente." });
        await refresh();
      } else if (outcome === "none") {
        setDiscoveryNote({ ok: false, detail: "La cuenta de Beeping no tiene ninguna tienda." });
      } else {
        setDiscoveryNote({ ok: false, detail: j.discovery?.error ?? "no se pudo detectar la tienda" });
      }
    } catch {
      setDiscoveryNote({ ok: false, detail: "no se pudo contactar con el servidor" });
    } finally {
      setDiscovering(false);
    }
  }, [refresh]);

  const selectShop = useCallback(async () => {
    if (selectedShopId === null) return;
    const shop = discoveryShops?.find((s) => s.id === selectedShopId);
    setDiscovering(true);
    try {
      const res = await fetch("/api/beeping", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select_shop", shopId: selectedShopId, shopName: shop?.name }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (j.ok) {
        setDiscoveryShops(null);
        setDiscoveryNote({ ok: true, detail: `Tienda fijada: ${shop?.name ?? selectedShopId}.` });
        await refresh();
      } else {
        setDiscoveryNote({ ok: false, detail: j.error ?? "no se pudo fijar la tienda" });
      }
    } catch {
      setDiscoveryNote({ ok: false, detail: "no se pudo contactar con el servidor" });
    } finally {
      setDiscovering(false);
    }
  }, [selectedShopId, discoveryShops, refresh]);

  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div>
      <SectionTitle>Integraciones</SectionTitle>
      {!data ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.cards.map((card) => {
            const ui = healthToUi(card.status);
            const isBeeping = card.id === "beeping";
            const isMetaAds = card.id === "meta_ads";
            const testable = isBeeping || isMetaAds;
            const result = testResult[card.id];
            const shopName = extraStr(card.extra, "shopName");
            const showDetect = isBeeping && card.configured && (!shopName || /varias tiendas|multiple/i.test(card.message));
            return (
              <Card key={card.id} className="px-4 py-3.5 flex flex-col gap-2">
                {/* Cabecera: punto + nombre + estado */}
                <div className="flex items-center gap-2">
                  <StatusDot status={ui} pulse={card.status === "critical"} />
                  <span className="text-sm font-semibold text-brand-text flex-1 truncate">{card.label}</span>
                  <span className={`text-[10px] font-bold tracking-wider ${STATUS_TEXT[ui]}`}>{STATUS_LABEL[card.status]}</span>
                </div>

                <div className="text-[11px] text-brand-muted leading-snug">{card.description}</div>

                {card.message ? (
                  <div className="text-xs text-brand-text leading-snug" title={card.message}>
                    {card.message}
                  </div>
                ) : null}

                {/* Metadatos */}
                <div className="space-y-0.5 text-[11px] text-brand-muted">
                  <div>Último éxito: {timeAgo(card.lastSuccessAt)}</div>
                  {card.lastError ? (
                    <div className="truncate" title={card.lastError}>
                      Último error: {card.lastError}
                    </div>
                  ) : null}
                </div>

                {/* Detalle propio de Beeping */}
                {isBeeping ? (
                  <div className="space-y-0.5 text-[11px] text-brand-muted border-t border-brand-border pt-2">
                    <div>Tienda: {shopName ?? "sin detectar"}</div>
                    <div>Pendientes de enviar: {formatInt(extraNum(card.extra, "awaitingRelease") ?? 0)}</div>
                    <div>
                      Modo actual:{" "}
                      <span className="text-brand-text font-semibold">
                        {card.extra?.autoRelease === true ? "ENVÍO AUTOMÁTICO" : "LIBERACIÓN MANUAL"}
                      </span>
                    </div>
                  </div>
                ) : null}

                {/* Toggle bloqueado de auto-release (no interactivo a propósito) */}
                {isBeeping ? (
                  <div className="rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 opacity-50 cursor-not-allowed select-none" aria-disabled>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-brand-text">Enviar automáticamente a Beeping al confirmar</span>
                      <span className="inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-brand-border px-0.5" aria-hidden>
                        <span className="h-3 w-3 rounded-full bg-brand-muted/60" />
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-brand-muted">Bloqueado hasta completar el piloto real.</div>
                  </div>
                ) : null}

                {/* Detección de tienda de Beeping */}
                {showDetect ? (
                  <div className="space-y-2">
                    <GhostButton onClick={discoverShops} disabled={discovering} className="w-full">
                      {discovering ? "Detectando…" : "Detectar tienda"}
                    </GhostButton>
                    {discoveryShops && discoveryShops.length > 0 ? (
                      <div className="space-y-2">
                        <select
                          value={selectedShopId ?? undefined}
                          onChange={(e) => setSelectedShopId(parseInt(e.target.value, 10))}
                          className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-xs text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
                        >
                          {discoveryShops.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <GhostButton onClick={selectShop} disabled={discovering || selectedShopId === null} className="w-full">
                          Usar esta tienda
                        </GhostButton>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {isBeeping && discoveryNote ? (
                  <div className={`text-[11px] leading-snug ${discoveryNote.ok ? "text-emerald-400" : "text-red-400"}`}>
                    {discoveryNote.detail}
                  </div>
                ) : null}

                {/* Detalle propio de Meta Ads */}
                {isMetaAds ? (
                  <div className="space-y-0.5 text-[11px] text-brand-muted border-t border-brand-border pt-2">
                    <div>Versión de la API: {extraStr(card.extra, "apiVersion") ?? "—"}</div>
                    <div>Días con snapshot: {formatInt(extraNum(card.extra, "snapshotDays") ?? 0)}</div>
                  </div>
                ) : null}

                {/* Prueba de conexión */}
                {testable ? (
                  <div className="mt-auto pt-1 space-y-1.5">
                    <GhostButton onClick={() => runTest(card.id as "beeping" | "meta_ads")} disabled={testing[card.id]} className="w-full">
                      {testing[card.id] ? "Probando…" : "Probar conexión"}
                    </GhostButton>
                    {result ? (
                      <div
                        className={`text-[11px] leading-snug ${result.ok ? "text-emerald-400" : "text-red-400"}`}
                        title={result.detail}
                      >
                        {result.ok ? `Conexión OK — ${result.detail}` : `Error: ${result.detail}`}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
