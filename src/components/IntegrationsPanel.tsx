"use client";

// ============================================================
// INTEGRACIONES (Ajustes → Integraciones, §46-§51): una FILA por servicio
// dentro de una única superficie agrupada con divisores finos. Estado en
// palabras y mensaje humano delante; lo técnico (último error, campos
// extra, prueba de conexión) vive detrás de "Detalles técnicos".
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { Card, ErrorState, formatInt, GhostButton, healthToUi, SectionTitle, Skeleton, StatusDot, STATUS_TEXT, timeAgo, type UiStatus } from "./ui";

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

/** Estado en palabras (§46): nada de códigos ni jerga. */
const STATUS_WORD: Record<IntegrationCard["status"], string> = {
  healthy: "Operativo",
  warning: "Con avisos",
  critical: "Error",
  disabled: "Sin configurar",
  unknown: "Sin datos",
};

function extraStr(extra: Record<string, unknown> | undefined, key: string): string | null {
  const v = extra?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function extraNum(extra: Record<string, unknown> | undefined, key: string): number | null {
  const v = extra?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function extraBool(extra: Record<string, unknown> | undefined, key: string): boolean | null {
  const v = extra?.[key];
  return typeof v === "boolean" ? v : null;
}
const siNo = (v: boolean | null): string => (v === null ? "—" : v ? "sí" : "no");

// --- Glifos monocromos por servicio (trazo 1.6, mismo lenguaje visual) ---

function Glyph({ id }: { id: string }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (id) {
    case "shopify": // bolsa de compra
      return (
        <svg {...common}>
          <path d="M6 8h12l-1.2 12.2a1 1 0 0 1-1 .8H8.2a1 1 0 0 1-1-.8L6 8z" />
          <path d="M9 10V6a3 3 0 0 1 6 0v4" />
        </svg>
      );
    case "whatsapp": // burbuja de chat
      return (
        <svg {...common}>
          <path d="M21 11.6a8.4 8.4 0 0 1-8.6 8.2c-1.4 0-2.8-.3-4-1L3.5 20l1.2-4.6a8.1 8.1 0 0 1-1.1-4A8.4 8.4 0 0 1 12.4 3.4 8.4 8.4 0 0 1 21 11.6z" />
        </svg>
      );
    case "calls": // teléfono
      return (
        <svg {...common}>
          <path d="M21.5 16.9v2.6a1.8 1.8 0 0 1-2 1.8 18 18 0 0 1-7.8-2.8 17.7 17.7 0 0 1-5.5-5.5A18 18 0 0 1 3.4 5a1.8 1.8 0 0 1 1.8-2h2.6a1.8 1.8 0 0 1 1.8 1.5c.1.9.3 1.7.6 2.5a1.8 1.8 0 0 1-.4 1.9L8.7 10a14.4 14.4 0 0 0 5.5 5.5l1.1-1.1a1.8 1.8 0 0 1 1.9-.4c.8.3 1.6.5 2.5.6a1.8 1.8 0 0 1 1.8 1.9z" />
        </svg>
      );
    case "beeping":
    case "dropea":
    case "dropi": // caja / paquete
      return (
        <svg {...common}>
          <path d="M21 8.2 12 3.5 3 8.2v7.6l9 4.7 9-4.7V8.2z" />
          <path d="M3 8.2l9 4.7 9-4.7" />
          <path d="M12 12.9v7.6" />
        </svg>
      );
    case "meta_ads": // megáfono
      return (
        <svg {...common}>
          <path d="M11.5 5.5 6.5 9H4.3a1.3 1.3 0 0 0-1.3 1.3v3.4A1.3 1.3 0 0 0 4.3 15h2.2l5 3.5V5.5z" />
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18.2 6.8a7.5 7.5 0 0 1 0 10.4" />
        </svg>
      );
    case "database": // cilindro
      return (
        <svg {...common}>
          <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
          <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
          <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
        </svg>
      );
    case "backups": // escudo
      return (
        <svg {...common}>
          <path d="M12 21.5s7.5-3.6 7.5-9.4V5.6L12 2.9 4.5 5.6v6.5c0 5.8 7.5 9.4 7.5 9.4z" />
          <path d="M9 11.8l2.1 2.1 3.9-4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
        </svg>
      );
  }
}

/** Filas humanas de "Detalles técnicos", curadas por servicio (nunca JSON crudo). */
function detailRows(card: IntegrationCard): Array<{ label: string; value: string }> {
  const e = card.extra;
  switch (card.id) {
    case "shopify":
      return [
        { label: "Autenticación", value: extraStr(e, "authMode") ?? "—" },
        { label: "Secreto de webhook presente", value: siNo(extraBool(e, "webhookSecretPresent")) },
        { label: "Último webhook", value: timeAgo(extraNum(e, "lastWebhookAt")) },
      ];
    case "whatsapp": {
      const p = extraStr(e, "provider");
      return [
        { label: "Proveedor", value: p === "cloud_api" ? "API oficial de Meta" : p === "baileys" ? "Baileys (WhatsApp Web)" : "—" },
        { label: "Mensajes en cola de salida", value: formatInt(extraNum(e, "outboxPending") ?? 0) },
        { label: "Envío habilitado", value: siNo(extraBool(e, "sendEnabled")) },
      ];
    }
    case "calls":
      return [
        { label: "Modo sombra (registra sin llamar)", value: siNo(extraBool(e, "shadowMode")) },
        { label: "Lista de autorizados activa", value: siNo(extraBool(e, "allowlistActive")) },
        { label: "Fallos seguidos", value: formatInt(extraNum(e, "consecutiveFailures") ?? 0) },
      ];
    case "beeping":
      return [
        { label: "Tienda", value: extraStr(e, "shopName") ?? "sin detectar" },
        { label: "Pedidos pendientes de enviar", value: formatInt(extraNum(e, "awaitingRelease") ?? 0) },
        { label: "Liberaciones ambiguas", value: formatInt(extraNum(e, "ambiguousReleases") ?? 0) },
        { label: "Escritura habilitada", value: siNo(extraBool(e, "writeEnabled")) },
        { label: "Última sincronización", value: timeAgo(extraNum(e, "lastSyncCheckpointAt")) },
      ];
    case "dropea":
      return [
        { label: "Último webhook", value: timeAgo(extraNum(e, "lastWebhookAt")) },
        { label: "Creación de pedidos", value: extraStr(e, "createMode") ?? "—" },
        { label: "Mercado", value: extraStr(e, "market") ?? "—" },
      ];
    case "dropi":
      return [
        { label: "Mapa de estados configurado", value: siNo(extraBool(e, "statusMapConfigured")) },
        { label: "Estados desconocidos (7 días)", value: formatInt(extraNum(e, "unknownStatusesLast7d") ?? 0) },
      ];
    case "meta_ads":
      return [
        { label: "Versión de la API", value: extraStr(e, "apiVersion") ?? "—" },
        { label: "Días con snapshot de gasto", value: formatInt(extraNum(e, "snapshotDays") ?? 0) },
        { label: "Días con gasto (30 días)", value: formatInt(extraNum(e, "spendDays30d") ?? 0) },
      ];
    case "database": {
      const v = extraNum(e, "schemaVersion");
      const exp = extraNum(e, "expectedSchemaVersion");
      const size = extraNum(e, "dbSizeBytes");
      return [
        { label: "Versión de esquema", value: v === null ? "—" : `${v}${exp !== null ? ` (esperada: ${exp})` : ""}` },
        { label: "Tamaño", value: size === null ? "—" : `${(size / 1024 / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB` },
      ];
    }
    case "backups": {
      const age = extraNum(e, "ageHours");
      return [
        { label: "Copias guardadas", value: formatInt(extraNum(e, "count") ?? 0) },
        { label: "Antigüedad de la última", value: age === null ? "—" : `${age.toLocaleString("es-ES", { maximumFractionDigits: 1 })} h` },
        { label: "Último archivo", value: extraStr(e, "lastBackupFile") ?? "—" },
      ];
    }
    default:
      return [];
  }
}

/** Resultado de la prueba de conexión, ya convertido a una línea humana. */
interface TestResult {
  ok: boolean;
  detail: string;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-brand-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export default function IntegrationsPanel() {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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
        <Card className="divide-y divide-brand-border">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="px-4 py-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </Card>
      ) : (
        <Card className="divide-y divide-brand-border overflow-hidden">
          {data.cards.map((card) => {
            const ui: UiStatus = healthToUi(card.status);
            const open = openId === card.id;
            const isBeeping = card.id === "beeping";
            const isMetaAds = card.id === "meta_ads";
            const testable = isBeeping || isMetaAds;
            const result = testResult[card.id];
            const shopName = extraStr(card.extra, "shopName");
            const showDetect = isBeeping && card.configured && (!shopName || /varias tiendas|multiple/i.test(card.message));
            const rows = detailRows(card);
            return (
              <div key={card.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : card.id)}
                  aria-expanded={open}
                  className="w-full flex items-center gap-3.5 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-brand-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
                >
                  <span className="shrink-0 text-brand-muted">
                    <Glyph id={card.id} />
                  </span>

                  {/* Nombre + descripción */}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-brand-text truncate">{card.label}</span>
                      {/* En móvil el estado va junto al nombre */}
                      <span className={`md:hidden inline-flex items-center gap-1.5 text-[11px] ${STATUS_TEXT[ui]}`}>
                        <StatusDot status={ui} pulse={card.status === "critical"} />
                        {STATUS_WORD[card.status]}
                      </span>
                    </span>
                    <span className="block text-[11px] text-brand-muted truncate leading-snug">{card.description}</span>
                  </span>

                  {/* Estado en palabras + mensaje humano (md+) */}
                  <span className="hidden md:block min-w-0 flex-1">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${STATUS_TEXT[ui]}`}>
                      <StatusDot status={ui} pulse={card.status === "critical"} />
                      {STATUS_WORD[card.status]}
                    </span>
                    <span className="block text-[11px] text-brand-muted truncate leading-snug" title={card.message}>
                      {card.message || "—"}
                    </span>
                  </span>

                  <span className="hidden sm:block shrink-0 text-[11px] text-brand-muted whitespace-nowrap">
                    {timeAgo(card.lastSuccessAt)}
                  </span>
                  <Chevron open={open} />
                </button>

                {open ? (
                  <div className="px-4 pb-4 pt-0.5 md:pl-[47px]">
                    {/* En móvil el mensaje humano no cabe en la fila: aquí sí. */}
                    {card.message ? <div className="md:hidden mb-2 text-xs text-brand-text leading-snug">{card.message}</div> : null}

                    <div className="rounded-xl border border-brand-border bg-brand-surface-2/50 px-3.5 py-3 space-y-3">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-brand-muted font-semibold">Detalles técnicos</div>

                      <div className="space-y-1 text-[11px]">
                        <div className="flex justify-between gap-3">
                          <span className="text-brand-muted">Último éxito</span>
                          <span className="text-brand-text text-right">{timeAgo(card.lastSuccessAt)}</span>
                        </div>
                        {card.lastErrorAt !== null || card.lastError ? (
                          <div className="flex justify-between gap-3">
                            <span className="text-brand-muted shrink-0">Último error</span>
                            <span className="text-red-400/90 text-right break-words min-w-0" title={card.lastError ?? undefined}>
                              {card.lastError ?? "—"}
                              {card.lastErrorAt !== null ? ` (${timeAgo(card.lastErrorAt)})` : ""}
                            </span>
                          </div>
                        ) : null}
                        {rows.map((r) => (
                          <div key={r.label} className="flex justify-between gap-3">
                            <span className="text-brand-muted shrink-0">{r.label}</span>
                            <span className="text-brand-text text-right break-words min-w-0">{r.value}</span>
                          </div>
                        ))}
                      </div>

                      {/* Modo de Beeping + toggle bloqueado de auto-release (no interactivo a propósito) */}
                      {isBeeping ? (
                        <div className="rounded-xl border border-brand-border bg-brand-surface px-3 py-2 opacity-50 cursor-not-allowed select-none" aria-disabled>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-brand-text">Enviar automáticamente a Beeping al confirmar</span>
                            <span className="inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-brand-border px-0.5" aria-hidden>
                              <span className="h-3 w-3 rounded-full bg-brand-muted/60" />
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] text-brand-muted">
                            Modo actual: {card.extra?.autoRelease === true ? "envío automático" : "liberación manual"} · bloqueado hasta completar el piloto real.
                          </div>
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
                                className="w-full rounded-xl border border-brand-border bg-brand-surface px-3 py-2 text-xs text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60"
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

                      {/* Prueba de conexión */}
                      {testable ? (
                        <div className="space-y-1.5">
                          <GhostButton
                            onClick={() => runTest(card.id as "beeping" | "meta_ads")}
                            disabled={testing[card.id]}
                            className="w-full sm:w-auto"
                          >
                            {testing[card.id] ? "Probando…" : "Probar conexión"}
                          </GhostButton>
                          {result ? (
                            <div className={`text-[11px] leading-snug ${result.ok ? "text-emerald-400" : "text-red-400"}`} title={result.detail}>
                              {result.ok ? `Conexión OK — ${result.detail}` : `Error: ${result.detail}`}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
