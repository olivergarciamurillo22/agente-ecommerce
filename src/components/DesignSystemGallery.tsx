"use client";

// Galería de componentes y estados (solo desarrollo, ver app/design-system).
// Sirve para revisar jerarquía, densidad y contraste sin datos reales.

import { useState, type ReactNode } from "react";
import {
  Badge,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  GhostButton,
  KpiTile,
  MetricCell,
  MetricGroup,
  PageHeader,
  PrimaryButton,
  SearchInput,
  SectionTitle,
  SelectInput,
  Skeleton,
  StatusDot,
  TabBar,
  TextButton,
} from "./ui";

const TOKENS: Array<[string, string]> = [
  ["background", "#f5f5f7"],
  ["surface", "#ffffff"],
  ["surface-subtle", "#fafafa"],
  ["border", "#e3e3e7"],
  ["border-strong", "#d3d3d8"],
  ["text-primary", "#18181b"],
  ["text-secondary", "#65656d"],
  ["text-tertiary", "#92929b"],
  ["selection", "#1d1d1f"],
  ["brand", "#d5aa14"],
  ["success", "#248a3d"],
  ["warning", "#b66a00"],
  ["danger", "#d92d20"],
  ["info", "#1769e0"],
];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <SectionTitle>{title}</SectionTitle>
      <Card className="p-5 space-y-4">{children}</Card>
    </section>
  );
}

export default function DesignSystemGallery() {
  const [tab, setTab] = useState<"a" | "b" | "c">("a");
  const [chip, setChip] = useState("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState("urgency");
  return (
    <main className="min-h-screen bg-brand-bg px-8 py-8">
      <div className="max-w-5xl mx-auto space-y-8">
        <PageHeader title="Sistema de diseño" description="Galería interna de componentes y estados. Solo existe en desarrollo." actions={<Badge status="warn">Solo desarrollo</Badge>} />

        <Block title="Tokens">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {TOKENS.map(([n, v]) => (
              <div key={n} className="space-y-1.5">
                <div className="h-10 rounded-lg border border-brand-border" style={{ background: v }} />
                <div className="text-[12px] font-medium text-brand-text">{n}</div>
                <div className="text-[12px] text-brand-tertiary tabular-nums">{v}</div>
              </div>
            ))}
          </div>
        </Block>

        <Block title="Tipografía">
          <div className="font-display text-[30px] font-semibold tracking-[-0.02em] leading-tight">Título de página · 30 / 600</div>
          <div className="font-display text-[26px] font-semibold tabular-nums leading-none">1.284,50 € · métrica</div>
          <div className="text-[18px] font-semibold">Encabezado de sección · 18 / 600</div>
          <div className="text-[14px] font-medium">Navegación · 14 / 500</div>
          <div className="text-[14px]">Texto operativo · 14 / 400</div>
          <div className="text-[13px] text-brand-muted">Información secundaria · 13</div>
          <div className="text-[12px] font-medium text-brand-muted">Label · 12 / 500</div>
        </Block>

        <Block title="Acciones">
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton>Acción principal</PrimaryButton>
            <PrimaryButton busy>Guardando</PrimaryButton>
            <PrimaryButton disabled>Deshabilitada</PrimaryButton>
            <PrimaryButton danger>Cancelar en Beeping</PrimaryButton>
            <GhostButton>Secundaria</GhostButton>
            <TextButton>Ver Growth →</TextButton>
          </div>
        </Block>

        <Block title="Pestañas vs filtros">
          <TabBar tabs={[{ id: "a", label: "Vista general" }, { id: "b", label: "Acciones" }, { id: "c", label: "Conversaciones" }]} value={tab} onChange={setTab} label="Demo" counts={{ b: 3 }} />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={setQ} placeholder="Pedido, cliente o teléfono" label="Buscar" className="w-[260px]" />
            <SelectInput value={sel} onChange={setSel} label="Orden" options={[{ value: "urgency", label: "Por urgencia" }, { value: "oldest", label: "Más antiguos" }]} />
          </div>
          <div className="flex gap-1">
            {[["all", "Todos", 4], ["waiting", "Sin respuesta", 1], ["call", "Llamar", 0], ["corr", "Correcciones", 1]].map(([k, l, n]) => (
              <Chip key={String(k)} active={chip === k} onClick={() => setChip(String(k))} count={Number(n)}>{String(l)}</Chip>
            ))}
          </div>
        </Block>

        <Block title="Estados">
          <div className="flex flex-wrap gap-2">
            <Badge status="ok">Confirmado</Badge>
            <Badge status="info">Esperando cliente</Badge>
            <Badge status="warn">Corrección</Badge>
            <Badge status="error">Incidencia</Badge>
            <Badge status="muted">Cancelado</Badge>
          </div>
          <div className="flex items-center gap-4 text-[13px] text-brand-muted">
            <span className="inline-flex items-center gap-1.5"><StatusDot status="ok" /> operativo</span>
            <span className="inline-flex items-center gap-1.5"><StatusDot status="warn" /> con avisos</span>
            <span className="inline-flex items-center gap-1.5"><StatusDot status="error" pulse /> atención</span>
          </div>
        </Block>

        <Block title="Métricas">
          <MetricGroup cols={4}>
            <MetricCell label="Necesitan atención" value={2} status="warn" support="errores, correcciones y llamadas" />
            <MetricCell label="Sin respuesta" value={1} support="esperando al cliente" />
            <MetricCell label="Correcciones abiertas" value={1} support="direcciones por revisar" />
            <MetricCell label="Necesitan llamada" value={0} support="sin respuesta al WhatsApp" />
          </MetricGroup>
          <div className="grid grid-cols-3 gap-3">
            <KpiTile label="Dinero en riesgo" value="34,99 €" status="warn" support="1 pedido sin confirmar" />
            <KpiTile label="Pedidos" value={12} support="hoy" />
            <KpiTile label="Margen 30 días" value="—" support="sin datos suficientes" />
          </div>
        </Block>

        <Block title="Vacío, error y carga">
          <EmptyState title="No hay conversaciones abiertas." hint="Cuando un pedido espere respuesta, llamada o corrección, aparecerá aquí." />
          <ErrorState message="No se pudo cargar el seguimiento." onRetry={() => undefined} />
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        </Block>
      </div>
    </main>
  );
}
