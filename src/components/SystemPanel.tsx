"use client";

// Control Center: el estado de TODO el sistema en una pantalla, pensado para
// que Pedro entienda de un vistazo qué funciona y qué necesita atención.
// READ-ONLY: desde aquí no se reinicia, no se borra, no se envía nada.

import { useCallback, useEffect, useState } from "react";

type Status = "healthy" | "warning" | "critical" | "disabled" | "unknown";

interface Card {
  service: string;
  label: string;
  status: Status;
  message: string;
  detail?: string;
}

interface EventRow {
  id: number;
  integration: string;
  event_type: string;
  severity: "info" | "warning" | "critical";
  order_ref: string | null;
  message: string;
  created_at: number;
}

interface SchedulerRow {
  name: string;
  status: Status;
  expectedIntervalSec: number;
  lastHeartbeatAt: number | null;
  message: string;
  lastRun: {
    started_at: number;
    status: string;
    processed_count: number;
    error_count: number;
    last_error: string | null;
  } | null;
}

// El shape viene de /api/system (getSystemOverview). Se tipa lo que la UI
// pinta; nada de volcar JSON crudo en el panel.
interface Overview {
  generatedAt: number;
  overall: Status;
  emergencyStop: boolean;
  cards: Card[];
  whatsapp: {
    status: Status;
    connectionStatus: string;
    businessNumberMasked: string | null;
    lastOutboundAt: number | null;
    lastInboundAt: number | null;
    outboxPending: number;
    sendEnabled: boolean;
    testMode: boolean;
    lastError: string | null;
    message: string;
  };
  shopify: {
    status: Status;
    configured: boolean;
    authMode: string;
    webhookSecretPresent: boolean;
    writesEnabled: boolean;
    lastWebhookAt: number | null;
    lastApiSuccessAt: number | null;
    lastApiError: string | null;
    lastTagWriteAt: number | null;
    message: string;
  };
  dropea: {
    status: Status;
    credentialsPresent: boolean;
    apiEnabled: boolean;
    writeEnabled: boolean;
    createMode: string;
    legacyAppActive: boolean;
    market: string;
    storeId: string | null;
    webhookSecretPresent: boolean;
    lastApiSuccessAt: number | null;
    lastApiError: string | null;
    lastWebhookAt: number | null;
    counters: {
      webhookBadSignature: number;
      webhookDuplicates: number;
      ordersAdopted: number;
      trackingUpdates: number;
      rateLimitHits: number;
    };
    message: string;
  };
  dropi: {
    status: Status;
    webhookEnabled: boolean;
    webhookAuthKnown: boolean;
    statusMapConfigured: boolean;
    lastWebhookAt: number | null;
    unknownStatusesLast7d: number;
    message: string;
  };
  database: {
    status: Status;
    integrity: string;
    journalMode: string;
    dbSizeBytes: number | null;
    walSizeBytes: number | null;
    walWarning: string | null;
    schemaVersion: number;
    expectedSchemaVersion: number;
    rowCounts: Record<string, number>;
    lastWriteAt: number | null;
    message: string;
  };
  backups: {
    status: Status;
    lastBackupAt: number | null;
    lastBackupFile: string | null;
    lastBackupSizeBytes: number | null;
    count: number;
    integrity: string;
    message: string;
  };
  outbox: {
    status: Status;
    pending: number;
    retained: number;
    sentLast24h: number;
    oldestPendingMinutes: number | null;
    lastSentAt: number | null;
    message: string;
  };
  schedulers: SchedulerRow[];
  tracking: {
    status: Status;
    activeShipments: number;
    byState: Record<string, number>;
    deliveredToday: number;
    incidents: number;
    stale: number;
    blockedAddress: number;
    manualReview: number;
    staleHours: number;
    staleOrders: Array<{ orderNumber: string; state: string; hoursSinceCheck: number | null }>;
    message: string;
  };
  business: {
    status: Status;
    delivery: {
      today: DeliveryWindow;
      last7d: DeliveryWindow;
      last30d: DeliveryWindow;
      minSample: number;
    };
    alerts: {
      status: Status;
      alerts: Array<{
        id: string;
        category: "business" | "operations";
        status: Status;
        label: string;
        message: string;
        value: number | null;
        threshold: number | null;
      }>;
      snapshot: {
        needsCallTotal: number;
        needsCallStale: number;
        openIncidents: number;
        supplierFailures24h: number;
        trackingNotifyFailures24h: number;
        trackingStale: number;
      };
    };
    economics: {
      today: EconomicsWindow;
      last7d: EconomicsWindow;
      last30d: EconomicsWindow;
      skusWithoutCost: Array<{ sku: string; title: string }>;
      costsConfigured: number;
      adSpendDays: number;
    };
  };
  recentProblems: EventRow[];
}

interface DeliveryBucket {
  key: string;
  shipped: number;
  delivered: number;
  returned: number;
  pending: number;
  incidents: number;
  deliveryRate: number | null;
}
interface DeliveryWindow extends DeliveryBucket {
  created: number;
  cancelled: number;
  avgHoursToDeliver: number | null;
  byProduct: DeliveryBucket[];
  bySupplier: DeliveryBucket[];
  byCarrier: DeliveryBucket[];
}
interface EconomicsWindow {
  shippedOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  grossRevenue: number;
  deliveredRevenue: number;
  productCost: number | null;
  shippingCost: number | null;
  codFees: number | null;
  adSpend: number | null;
  estimatedMargin: number | null;
  estimatedMarginPct: number | null;
  grossRoas: number | null;
  netRoas: number | null;
  complete: boolean;
  missing: string[];
  currency: string;
}
interface CostRow {
  sku: string;
  title: string | null;
  product_cost: number | null;
  shipping_cost: number | null;
  cod_fee: number | null;
}

// --- Presentación de estados ---

const STATUS_META: Record<Status, { label: string; pill: string; dot: string }> = {
  healthy: {
    label: "OK",
    pill: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    dot: "bg-emerald-400",
  },
  warning: {
    label: "AVISO",
    pill: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    dot: "bg-amber-400",
  },
  critical: {
    label: "CRÍTICO",
    pill: "bg-red-500/15 text-red-300 border-red-500/40",
    dot: "bg-red-400",
  },
  disabled: {
    label: "APAGADO",
    pill: "bg-zinc-500/15 text-zinc-400 border-zinc-500/40",
    dot: "bg-zinc-500",
  },
  unknown: {
    label: "SIN DATOS",
    pill: "bg-sky-500/10 text-sky-300/80 border-sky-500/30",
    dot: "bg-sky-500/70",
  },
};

function StatusPill({ status }: { status: Status }) {
  const m = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wide whitespace-nowrap ${m.pill}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function fecha(t: number | null | undefined): string {
  if (!t) return "nunca";
  return new Date(t * 1000).toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hace(t: number | null | undefined): string {
  if (!t) return "nunca";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 90) return `hace ${s} s`;
  if (s < 5400) return `hace ${Math.round(s / 60)} min`;
  if (s < 129600) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
}

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "?";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// --- Bloques reutilizables ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-brand-border bg-brand-surface p-4">
      <div className="text-[11px] uppercase tracking-wider text-brand-muted mb-3">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm border-b border-brand-border/40 last:border-0">
      <span className="text-brand-muted">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${v} %`;
}
function money(v: number | null | undefined, cur = "EUR"): string {
  if (v == null) return "—";
  return `${v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === "EUR" ? "€" : cur}`;
}
function rateColor(v: number | null, warn = 70, crit = 65): string {
  if (v == null) return "text-brand-muted";
  if (v < crit) return "text-red-300";
  if (v < warn) return "text-amber-300";
  return "text-emerald-300";
}

function BucketTable({ title, rows }: { title: string; rows: DeliveryBucket[] }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <div className="text-sm text-brand-muted">Sin envíos en la ventana.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-brand-muted">
            <tr>
              <th className="text-left font-normal py-1">Clave</th>
              <th className="text-right font-normal">Env.</th>
              <th className="text-right font-normal">Entr.</th>
              <th className="text-right font-normal">Dev.</th>
              <th className="text-right font-normal">Pend.</th>
              <th className="text-right font-normal">Tasa</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-brand-border/30">
                <td className="py-1 pr-2 truncate max-w-[220px]" title={r.key}>{r.key}</td>
                <td className="text-right">{r.shipped}</td>
                <td className="text-right">{r.delivered}</td>
                <td className="text-right">{r.returned}</td>
                <td className="text-right">{r.pending}</td>
                <td className={`text-right ${rateColor(r.deliveryRate)}`}>{pct(r.deliveryRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function EconomicsCard({ title, w }: { title: string; w: EconomicsWindow }) {
  return (
    <Section title={title}>
      <div className="mb-2">
        <StatusPill status={w.complete ? "healthy" : "unknown"} />
        <span className="ml-2 text-xs text-brand-muted">
          {w.complete ? "datos completos" : w.shippedOrders === 0 ? "sin envíos en la ventana" : "incompleto"}
        </span>
      </div>
      <Row k="Enviados / entregados / devueltos" v={`${w.shippedOrders} / ${w.deliveredOrders} / ${w.returnedOrders}`} />
      <Row k="Facturación bruta (enviados)" v={money(w.grossRevenue, w.currency)} />
      <Row k="Ingresos entregados (reales)" v={money(w.deliveredRevenue, w.currency)} />
      <Row k="Coste de producto" v={money(w.productCost, w.currency)} />
      <Row k="Coste de envío" v={money(w.shippingCost, w.currency)} />
      <Row k="Comisiones COD" v={money(w.codFees, w.currency)} />
      <Row k="Gasto en ads (manual)" v={money(w.adSpend, w.currency)} />
      <Row k="Margen estimado" v={w.estimatedMargin == null ? "—" : `${money(w.estimatedMargin, w.currency)} (${pct(w.estimatedMarginPct)})`} />
      <Row k="ROAS bruto / neto" v={`${w.grossRoas ?? "—"} / ${w.netRoas ?? "—"}`} />
      {w.missing.length > 0 && (
        <div className="mt-2 text-[11px] text-amber-300/90">
          Falta: {w.missing.slice(0, 5).join(" · ")}
          {w.missing.length > 5 ? ` · y ${w.missing.length - 5} más` : ""}
        </div>
      )}
    </Section>
  );
}

function CostsEditor({ onSaved, suggested }: { onSaved: () => void; suggested: Array<{ sku: string; title: string }> }) {
  const [rows, setRows] = useState<CostRow[]>([]);
  const [form, setForm] = useState({ sku: "", title: "", product_cost: "", shipping_cost: "", cod_fee: "" });
  const [adDay, setAdDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [adAmount, setAdAmount] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/system/costs", { cache: "no-store" });
      if (res.ok) setRows(((await res.json()) as { costs: CostRow[] }).costs);
    } catch {
      /* siguiente intento */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const saveCost = async () => {
    setMsg(null);
    const res = await fetch("/api/system/costs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ sku: "", title: "", product_cost: "", shipping_cost: "", cod_fee: "" });
      await load();
      onSaved();
      setMsg("Coste guardado.");
    } else setMsg("No se pudo guardar el coste.");
  };
  const saveAd = async () => {
    setMsg(null);
    const res = await fetch("/api/system/ad-spend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: adDay, amount: adAmount }),
    });
    if (res.ok) {
      setAdAmount("");
      onSaved();
      setMsg("Gasto en ads guardado.");
    } else setMsg("No se pudo guardar el gasto.");
  };
  const input = "bg-brand-bg border border-brand-border rounded-lg px-2 py-1 text-xs w-full";

  return (
    <Section title="Costes (entrada manual)">
      <div className="text-[11px] text-brand-muted mb-2">
        Coste por unidad y SKU. Sin estos datos la economía sale “incompleta”; nunca se estima.
      </div>
      {suggested.length > 0 && (
        <div className="text-[11px] text-amber-300/90 mb-2">
          SKUs vistos sin coste:{" "}
          {suggested.map((s) => (
            <button
              key={s.sku}
              className="underline mr-2"
              onClick={() => setForm({ ...form, sku: s.sku, title: s.title })}
            >
              {s.sku}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-2">
        <input className={input} placeholder="SKU" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        <input className={input} placeholder="Nombre" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input className={input} placeholder="Producto €" value={form.product_cost} onChange={(e) => setForm({ ...form, product_cost: e.target.value })} />
        <input className={input} placeholder="Envío €" value={form.shipping_cost} onChange={(e) => setForm({ ...form, shipping_cost: e.target.value })} />
        <input className={input} placeholder="COD €" value={form.cod_fee} onChange={(e) => setForm({ ...form, cod_fee: e.target.value })} />
      </div>
      <button onClick={saveCost} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-brand-gold text-black">
        Guardar coste
      </button>
      <div className="mt-3 space-y-1">
        {rows.map((r) => (
          <Row
            key={r.sku}
            k={`${r.sku}${r.title ? ` · ${r.title}` : ""}`}
            v={`prod ${r.product_cost ?? "—"} · envío ${r.shipping_cost ?? "—"} · COD ${r.cod_fee ?? "—"}`}
          />
        ))}
      </div>
      <div className="mt-4 text-[11px] uppercase tracking-wider text-brand-muted mb-1">Gasto en ads por día</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <input className={input} type="date" value={adDay} onChange={(e) => setAdDay(e.target.value)} />
        <input className={input} placeholder="Importe €" value={adAmount} onChange={(e) => setAdAmount(e.target.value)} />
        <button onClick={saveAd} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-brand-gold text-black">
          Guardar gasto
        </button>
      </div>
      {msg && <div className="mt-2 text-[11px] text-brand-muted">{msg}</div>}
    </Section>
  );
}

const TABS = [
  ["overview", "Resumen"],
  ["integrations", "Integraciones"],
  ["database", "Base de datos"],
  ["backups", "Backups"],
  ["schedulers", "Tareas"],
  ["outbox", "Cola de envíos"],
  ["tracking", "Envíos"],
  ["business", "Negocio"],
  ["events", "Eventos"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function SystemPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [severityFilter, setSeverityFilter] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/system", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    try {
      const qs = severityFilter ? `?severity=${severityFilter}` : "";
      const res = await fetch(`/api/system/events${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { events: EventRow[] };
      setEvents(json.events);
    } catch {
      /* siguiente intento */
    }
  }, [severityFilter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (tab === "events") refreshEvents();
  }, [tab, refreshEvents]);

  if (error && !data) {
    return (
      <div className="h-full flex items-center justify-center text-brand-muted text-sm">
        No se pudo cargar el estado del sistema ({error}). Reintentando…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-brand-muted text-sm">
        Cargando estado del sistema…
      </div>
    );
  }

  const overallMeta = STATUS_META[data.overall] ?? STATUS_META.unknown;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      {/* Cabecera: estado global */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className={`w-3 h-3 rounded-full ${overallMeta.dot} ${data.overall !== "healthy" ? "brand-pulse" : ""}`} />
          <h2 className="font-display text-xl font-bold">
            Sistema:{" "}
            <span
              className={
                data.overall === "healthy"
                  ? "text-emerald-300"
                  : data.overall === "critical"
                    ? "text-red-300"
                    : "text-amber-300"
              }
            >
              {overallMeta.label}
            </span>
          </h2>
          {data.emergencyStop && (
            <span className="px-2 py-0.5 rounded-md border border-red-500/50 bg-red-500/20 text-red-200 text-[10px] font-bold tracking-wide">
              EMERGENCY STOP ACTIVO
            </span>
          )}
        </div>
        <span className="text-[11px] text-brand-muted">
          actualizado {hace(data.generatedAt)} · solo lectura
        </span>
      </div>

      {/* Pestañas */}
      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              tab === id
                ? "bg-brand-gold text-black border-brand-gold"
                : "border-brand-border text-brand-muted hover:text-brand-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            {data.cards.map((c) => (
              <button
                key={c.service}
                onClick={() => c.detail && setTab(c.detail as Tab)}
                className="text-left rounded-2xl border border-brand-border bg-brand-surface px-4 py-3 hover:border-brand-gold/40 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-sm">{c.label}</span>
                  <StatusPill status={c.status} />
                </div>
                <div className="text-xs text-brand-muted leading-snug">{c.message}</div>
              </button>
            ))}
          </div>
          <Section title="Últimos problemas">
            {data.recentProblems.length === 0 ? (
              <div className="text-sm text-brand-muted">Ninguno registrado. 🎉</div>
            ) : (
              <div className="space-y-1.5">
                {data.recentProblems.map((e) => (
                  <div key={e.id} className="flex items-start gap-2 text-sm">
                    <StatusPill status={e.severity === "critical" ? "critical" : "warning"} />
                    <span className="text-brand-muted text-xs mt-0.5 whitespace-nowrap">
                      {fecha(e.created_at)}
                    </span>
                    <span className="text-xs mt-0.5">
                      <span className="uppercase text-brand-muted mr-1">[{e.integration}]</span>
                      {e.message}
                      {e.order_ref ? ` · pedido ${e.order_ref}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {tab === "integrations" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Section title="WhatsApp">
            <div className="mb-2">
              <StatusPill status={data.whatsapp.status} />
              <span className="ml-2 text-sm">{data.whatsapp.message}</span>
            </div>
            <Row k="Número del negocio" v={data.whatsapp.businessNumberMasked ?? "—"} />
            <Row k="Último mensaje enviado" v={hace(data.whatsapp.lastOutboundAt)} />
            <Row k="Último mensaje recibido" v={hace(data.whatsapp.lastInboundAt)} />
            <Row k="En cola" v={data.whatsapp.outboxPending} />
            <Row k="Envíos reales" v={data.whatsapp.sendEnabled ? "ACTIVADOS" : "desactivados (safe mode)"} />
            <Row k="Modo prueba (allowlist)" v={data.whatsapp.testMode ? "sí" : "no"} />
            {data.whatsapp.lastError && <Row k="Último error" v={data.whatsapp.lastError} />}
          </Section>

          <Section title="Shopify">
            <div className="mb-2">
              <StatusPill status={data.shopify.status} />
              <span className="ml-2 text-sm">{data.shopify.message}</span>
            </div>
            <Row k="Último pedido recibido (webhook)" v={hace(data.shopify.lastWebhookAt)} />
            <Row k="Autenticación" v={data.shopify.authMode} />
            <Row k="Escrituras (tag WA_CONFIRMED)" v={data.shopify.writesEnabled ? "permitidas" : "bloqueadas por gates"} />
            <Row k="Último tag escrito" v={hace(data.shopify.lastTagWriteAt)} />
            <Row k="Última llamada API OK" v={hace(data.shopify.lastApiSuccessAt)} />
            {data.shopify.lastApiError && <Row k="Último error API" v={data.shopify.lastApiError} />}
          </Section>

          <Section title="Dropea">
            <div className="mb-2">
              <StatusPill status={data.dropea.status} />
              <span className="ml-2 text-sm">{data.dropea.message}</span>
            </div>
            <Row k="API key" v={data.dropea.credentialsPresent ? "presente" : "falta"} />
            <Row k="Lectura" v={data.dropea.apiEnabled ? "habilitada" : "apagada"} />
            <Row
              k="¿Quién crea los pedidos?"
              v={
                data.dropea.createMode === "external_app"
                  ? "su app oficial (nosotros NO)"
                  : "nuestra API"
              }
            />
            <Row k="Escritura nuestra" v={data.dropea.writeEnabled ? "HABILITADA" : "bloqueada"} />
            <Row k="Mercado" v={data.dropea.market.toUpperCase()} />
            <Row k="store_id" v={data.dropea.storeId ?? "pendiente de dropea:doctor"} />
            <Row k="Secreto de webhooks" v={data.dropea.webhookSecretPresent ? "presente" : "falta"} />
            <Row k="Última llamada API OK" v={hace(data.dropea.lastApiSuccessAt)} />
            <Row k="Último webhook" v={hace(data.dropea.lastWebhookAt)} />
            <Row
              k="7 días: firmas inválidas / duplicados"
              v={`${data.dropea.counters.webhookBadSignature} / ${data.dropea.counters.webhookDuplicates}`}
            />
            <Row
              k="7 días: adoptados / tracking / 429"
              v={`${data.dropea.counters.ordersAdopted} / ${data.dropea.counters.trackingUpdates} / ${data.dropea.counters.rateLimitHits}`}
            />
            {data.dropea.lastApiError && <Row k="Último error" v={data.dropea.lastApiError} />}
          </Section>

          <Section title="Dropi PRO">
            <div className="mb-2">
              <StatusPill status={data.dropi.status} />
              <span className="ml-2 text-sm">{data.dropi.message}</span>
            </div>
            <Row k="Receptor de avisos" v={data.dropi.webhookEnabled ? "encendido" : "apagado (fail-closed)"} />
            <Row k="Autenticación confirmada" v={data.dropi.webhookAuthKnown ? "sí" : "NO — pendiente de Pedro"} />
            <Row k="Mapa de estados" v={data.dropi.statusMapConfigured ? "configurado" : "pendiente (estados → desconocido)"} />
            <Row k="Último aviso recibido" v={hace(data.dropi.lastWebhookAt)} />
            <Row k="Estados sin mapear (7 días)" v={data.dropi.unknownStatusesLast7d} />
          </Section>
        </div>
      )}

      {tab === "database" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Section title="SQLite">
            <div className="mb-2">
              <StatusPill status={data.database.status} />
              <span className="ml-2 text-sm">{data.database.message}</span>
            </div>
            <Row k="Integridad (quick_check)" v={data.database.integrity} />
            <Row k="Modo journal" v={data.database.journalMode.toUpperCase()} />
            <Row k="Tamaño DB / WAL" v={`${bytes(data.database.dbSizeBytes)} / ${bytes(data.database.walSizeBytes)}`} />
            <Row k="Versión de esquema" v={`${data.database.schemaVersion} (esperada ${data.database.expectedSchemaVersion})`} />
            <Row k="Última escritura" v={hace(data.database.lastWriteAt)} />
            {data.database.walWarning && (
              <div className="mt-2 text-xs text-amber-300/90 border border-amber-500/30 bg-amber-500/10 rounded-lg px-3 py-2">
                {data.database.walWarning}
              </div>
            )}
          </Section>
          <Section title="Filas por tabla">
            {Object.entries(data.database.rowCounts).map(([t, n]) => (
              <Row key={t} k={t} v={n} />
            ))}
            <div className="mt-3 text-[11px] text-brand-muted">
              Comprobación completa por terminal: <code>npm run db:health -- --full</code>
            </div>
          </Section>
        </div>
      )}

      {tab === "backups" && (
        <Section title="Copias de seguridad">
          <div className="mb-2">
            <StatusPill status={data.backups.status} />
            <span className="ml-2 text-sm">{data.backups.message}</span>
          </div>
          <Row k="Última copia" v={data.backups.lastBackupFile ?? "—"} />
          <Row k="Cuándo" v={`${fecha(data.backups.lastBackupAt)} (${hace(data.backups.lastBackupAt)})`} />
          <Row k="Tamaño" v={bytes(data.backups.lastBackupSizeBytes)} />
          <Row k="Integridad de la copia" v={data.backups.integrity} />
          <Row k="Copias conservadas" v={data.backups.count} />
          <div className="mt-3 text-[11px] text-brand-muted">
            Desde aquí no se restaura nada: restaurar es una decisión manual (ver
            docs/UGREEN-DXP2800-DEPLOY.md).
          </div>
        </Section>
      )}

      {tab === "schedulers" && (
        <Section title="Tareas programadas (relojes del sistema)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-brand-muted border-b border-brand-border">
                  <th className="px-2 py-2">Tarea</th>
                  <th className="px-2 py-2">Estado</th>
                  <th className="px-2 py-2">Cada</th>
                  <th className="px-2 py-2">Último latido</th>
                  <th className="px-2 py-2">Última ejecución con trabajo</th>
                </tr>
              </thead>
              <tbody>
                {data.schedulers.map((s) => (
                  <tr key={s.name} className="border-b border-brand-border/40 last:border-0">
                    <td className="px-2 py-2 font-semibold">{s.name}</td>
                    <td className="px-2 py-2">
                      <StatusPill status={s.status} />
                    </td>
                    <td className="px-2 py-2 text-brand-muted">
                      {s.expectedIntervalSec >= 60
                        ? `${Math.round(s.expectedIntervalSec / 60)} min`
                        : `${s.expectedIntervalSec} s`}
                    </td>
                    <td className="px-2 py-2">{hace(s.lastHeartbeatAt)}</td>
                    <td className="px-2 py-2 text-xs text-brand-muted">
                      {s.lastRun
                        ? `${fecha(s.lastRun.started_at)} · ${s.lastRun.processed_count} procesado(s)` +
                          (s.lastRun.error_count ? ` · ${s.lastRun.error_count} error(es)` : "")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-[11px] text-brand-muted">
            Los relojes viven en el proceso del bot: si el bot está parado, es normal verlos sin latido.
          </div>
        </Section>
      )}

      {tab === "outbox" && (
        <Section title="Cola de envíos de WhatsApp">
          <div className="mb-2">
            <StatusPill status={data.outbox.status} />
            <span className="ml-2 text-sm">{data.outbox.message}</span>
          </div>
          <Row k="Pendientes" v={data.outbox.pending} />
          <Row
            k="Retenidos (no saldrán solos)"
            v={
              data.outbox.retained > 0 ? (
                <span className="text-amber-300">{data.outbox.retained} — revisar con outbox:inspect</span>
              ) : (
                0
              )
            }
          />
          <Row k="Pendiente más antiguo" v={data.outbox.oldestPendingMinutes !== null ? `${data.outbox.oldestPendingMinutes} min` : "—"} />
          <Row k="Enviados últimas 24 h" v={data.outbox.sentLast24h} />
          <Row k="Último envío" v={hace(data.outbox.lastSentAt)} />
        </Section>
      )}

      {tab === "tracking" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Section title="Envíos en curso">
            <div className="mb-2">
              <StatusPill status={data.tracking.status} />
              <span className="ml-2 text-sm">{data.tracking.message}</span>
            </div>
            <Row k="Activos" v={data.tracking.activeShipments} />
            {Object.entries(data.tracking.byState).map(([s, n]) => (
              <Row key={s} k={`· ${s}`} v={n} />
            ))}
            <Row k="Entregados hoy" v={data.tracking.deliveredToday} />
            <Row k="Incidencias" v={data.tracking.incidents} />
            <Row
              k="Bloqueados por dirección (city “-”)"
              v={
                data.tracking.blockedAddress > 0 ? (
                  <span className="text-amber-300">{data.tracking.blockedAddress}</span>
                ) : (
                  0
                )
              }
            />
            <Row k="En revisión humana" v={data.tracking.manualReview} />
          </Section>
          <Section title={`Sin noticias en más de ${data.tracking.staleHours} h`}>
            {data.tracking.staleOrders.length === 0 ? (
              <div className="text-sm text-brand-muted">Todos los envíos activos tienen seguimiento al día.</div>
            ) : (
              data.tracking.staleOrders.map((o) => (
                <Row
                  key={o.orderNumber}
                  k={`Pedido ${o.orderNumber} (${o.state})`}
                  v={o.hoursSinceCheck !== null ? `hace ${o.hoursSinceCheck} h` : "sin datos"}
                />
              ))
            )}
          </Section>
        </div>
      )}

      {tab === "business" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Section title="Operativa">
              <div className="mb-2">
                <StatusPill status={data.business.alerts.status} />
              </div>
              <Row k="Pendientes de llamada" v={data.business.alerts.snapshot.needsCallTotal} />
              <Row
                k="· atrasados"
                v={<span className={data.business.alerts.snapshot.needsCallStale ? "text-amber-300" : ""}>{data.business.alerts.snapshot.needsCallStale}</span>}
              />
              <Row k="Incidencias abiertas" v={data.business.alerts.snapshot.openIncidents} />
              <Row k="Entregados hoy" v={data.business.delivery.today.delivered} />
              <Row k="Devueltos (7 d)" v={data.business.delivery.last7d.returned} />
              <Row k="Envíos sin noticias" v={data.business.alerts.snapshot.trackingStale} />
            </Section>
            <Section title="Rendimiento">
              <Row k="Entrega hoy" v={<span className={rateColor(data.business.delivery.today.deliveryRate)}>{pct(data.business.delivery.today.deliveryRate)}</span>} />
              <Row k="Entrega 7 días" v={<span className={rateColor(data.business.delivery.last7d.deliveryRate)}>{pct(data.business.delivery.last7d.deliveryRate)}</span>} />
              <Row k="Entrega 30 días" v={<span className={rateColor(data.business.delivery.last30d.deliveryRate)}>{pct(data.business.delivery.last30d.deliveryRate)}</span>} />
              <Row k="Enviados / resueltos (7 d)" v={`${data.business.delivery.last7d.shipped} / ${data.business.delivery.last7d.delivered + data.business.delivery.last7d.returned}`} />
              <Row k="Horas medias hasta entrega (30 d)" v={data.business.delivery.last30d.avgHoursToDeliver ?? "—"} />
              <div className="text-[11px] text-brand-muted mt-2">
                Tasa = entregados / (entregados + devueltos). Los envíos en curso no cuentan. Muestra mínima: {data.business.delivery.minSample}.
              </div>
            </Section>
            <Section title="Economía (30 días)">
              <Row k="Facturación bruta" v={money(data.business.economics.last30d.grossRevenue, data.business.economics.last30d.currency)} />
              <Row k="Ingresos entregados" v={money(data.business.economics.last30d.deliveredRevenue, data.business.economics.last30d.currency)} />
              <Row k="Margen estimado" v={money(data.business.economics.last30d.estimatedMargin, data.business.economics.last30d.currency)} />
              <Row k="ROAS bruto / neto" v={`${data.business.economics.last30d.grossRoas ?? "—"} / ${data.business.economics.last30d.netRoas ?? "—"}`} />
              <div className="mt-2">
                <StatusPill status={data.business.economics.last30d.complete ? "healthy" : "unknown"} />
                <span className="ml-2 text-[11px] text-brand-muted">
                  {data.business.economics.last30d.complete ? "datos completos" : "incompleto: faltan costes o ads"}
                </span>
              </div>
            </Section>
          </div>

          <Section title="Alertas de negocio y operativa">
            {data.business.alerts.alerts.map((a) => (
              <div key={a.id} className="flex items-start gap-2 text-xs py-1.5 border-b border-brand-border/30 last:border-0">
                <StatusPill status={a.status} />
                <span className="uppercase text-brand-muted w-20">{a.category === "business" ? "negocio" : "operativa"}</span>
                <span className="flex-1">
                  <span className="font-semibold">{a.label}</span> — {a.message}
                </span>
              </div>
            ))}
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <BucketTable title="Por producto (30 d)" rows={data.business.delivery.last30d.byProduct} />
            <BucketTable title="Por proveedor (30 d)" rows={data.business.delivery.last30d.bySupplier} />
            <BucketTable title="Por transportista (30 d)" rows={data.business.delivery.last30d.byCarrier} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <EconomicsCard title="Economía · hoy" w={data.business.economics.today} />
            <EconomicsCard title="Economía · 7 días" w={data.business.economics.last7d} />
            <EconomicsCard title="Economía · 30 días" w={data.business.economics.last30d} />
          </div>

          <CostsEditor onSaved={refresh} suggested={data.business.economics.skusWithoutCost} />
        </div>
      )}

      {tab === "events" && (
        <Section title="Eventos técnicos (sanitizados)">
          <div className="flex gap-2 mb-3">
            {["", "warning", "critical"].map((s) => (
              <button
                key={s || "all"}
                onClick={() => setSeverityFilter(s)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${
                  severityFilter === s
                    ? "bg-brand-gold text-black border-brand-gold"
                    : "border-brand-border text-brand-muted hover:text-brand-text"
                }`}
              >
                {s === "" ? "Todos" : s === "warning" ? "Avisos" : "Críticos"}
              </button>
            ))}
            <button
              onClick={refreshEvents}
              className="ml-auto px-2.5 py-1 rounded-lg text-[11px] font-semibold border border-brand-border text-brand-muted hover:text-brand-text"
            >
              Refrescar
            </button>
          </div>
          {events.length === 0 ? (
            <div className="text-sm text-brand-muted">Sin eventos con ese filtro.</div>
          ) : (
            <div className="space-y-1">
              {events.map((e) => (
                <div key={e.id} className="flex items-start gap-2 text-xs py-1 border-b border-brand-border/30 last:border-0">
                  <span className="text-brand-muted whitespace-nowrap w-24">{fecha(e.created_at)}</span>
                  <StatusPill status={e.severity === "info" ? "healthy" : e.severity === "warning" ? "warning" : "critical"} />
                  <span className="uppercase text-brand-muted w-16">{e.integration}</span>
                  <span className="flex-1">
                    {e.message}
                    {e.order_ref ? <span className="text-brand-muted"> · pedido {e.order_ref}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
