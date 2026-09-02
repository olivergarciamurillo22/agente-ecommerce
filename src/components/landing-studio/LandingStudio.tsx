"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SavedCandidate } from "@/lib/product-hunter/types";
import {
  type ClaimStatus,
  type EvidenceKind,
  type LandingBlueprint,
  type LandingProject,
  type LandingSection,
  cloneBlueprint,
  createLandingBlueprint,
  studioId,
} from "@/lib/landing-studio/types";
import { calculateLandingViability } from "@/lib/landing-studio/viability";
import { canExportLanding, validateLandingBlueprint } from "@/lib/landing-studio/validation";
import { buildShopifyThemeBundle, bundleToZip, validateShopifyThemeBundle } from "@/lib/landing-studio/shopify-export";
import { Badge, Card, EmptyState, ErrorState, GhostButton, INPUT_CLASS, MetricCell, MetricGroup, PrimaryButton, ReadinessBadge, SectionTitle, SelectInput, SkeletonRows, TabBar, formatEuro } from "../ui";
import { hunterGet } from "../hunter/hunter-shared";

type StudioTab = "candidate" | "viability" | "brief" | "editor" | "preview" | "validation" | "versions" | "export";
const TABS: Array<{ id: StudioTab; label: string }> = [
  { id: "candidate", label: "Candidato" }, { id: "viability", label: "Viabilidad" }, { id: "brief", label: "Brief" }, { id: "editor", label: "Editor" },
  { id: "preview", label: "Preview" }, { id: "validation", label: "Validación" }, { id: "versions", label: "Versiones" }, { id: "export", label: "Exportar" },
];
const STORAGE_KEY = "casamable.landing-studio.projects.v1";

const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  verified: "Verificado", supplier: "Proveedor", pedro: "Pedro", hypothesis: "Hipótesis", pending: "Pendiente", blocked: "Bloqueado",
};
const SECTION_TYPE_LABEL: Record<LandingSection["type"], string> = {
  hero: "Hero", benefits: "Beneficios", proof: "Prueba", how_it_works: "Cómo funciona", offer: "Oferta", faq: "Preguntas", guarantee: "Garantía",
};
const KIND_LABEL: Record<EvidenceKind, string> = { real: "Dato real", estimate: "Estimación", scenario: "Escenario", missing: "Ausente" };

function loadProjects(): LandingProject[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? (value as LandingProject[]) : [];
  } catch { return []; }
}

function Preview({ blueprint, viewport }: { blueprint: LandingBlueprint; viewport: "desktop" | "tablet" | "mobile" }) {
  const width = viewport === "desktop" ? "max-w-[1180px]" : viewport === "tablet" ? "max-w-[760px]" : "max-w-[390px]";
  const price = blueprint.price.current;
  return (
    <div className={`${width} mx-auto overflow-hidden border border-brand-border bg-white shadow-sm`} data-testid={`landing-preview-${viewport}`}>
      {blueprint.sections.filter((s) => s.visible).map((section) => {
        const asset = blueprint.assets.find((a) => section.assetIds.includes(a.id) && a.url);
        return (
          <section key={section.id} className={`px-5 py-10 sm:px-10 sm:py-14 ${section.type === "offer" ? "bg-brand-text text-white text-center" : "border-b border-brand-border last:border-0"}`}>
            <div className={section.type === "offer" ? "mx-auto max-w-2xl" : "max-w-3xl"}>
              <p className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${section.type === "offer" ? "text-white/60" : "text-brand-muted"}`}>{section.eyebrow}</p>
              <h2 className={`mt-2 font-display text-3xl sm:text-5xl font-semibold leading-[1.02] tracking-[-0.035em] ${section.type === "offer" ? "text-white" : "text-brand-text"}`}>{section.title}</h2>
              <p className={`mt-4 text-base leading-relaxed ${section.type === "offer" ? "text-white/75" : "text-brand-muted"}`}>{section.body}</p>
              {asset?.url ? <div className="mt-7 aspect-video overflow-hidden rounded-xl bg-brand-surface-2"><img src={asset.url} alt={asset.alt} className="h-full w-full object-cover" /></div> : null}
              {section.items.length > 0 ? <ul className={`mt-7 grid gap-px sm:grid-cols-3 ${section.type === "offer" ? "bg-white/20" : "bg-brand-border"}`}>{section.items.map((item, i) => <li key={i} className={`p-4 text-sm ${section.type === "offer" ? "bg-brand-text text-white/85" : "bg-white text-brand-text"}`}>{item}</li>)}</ul> : null}
              {section.type === "offer" ? <div className="mt-7"><div className="font-display text-3xl font-semibold">{price === null ? "Precio no disponible" : formatEuro(price)}</div><button type="button" className="mt-4 min-h-12 rounded-lg bg-white px-5 font-semibold text-brand-text">{blueprint.brief.primaryCta}</button></div> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function LandingStudio() {
  const [tab, setTab] = useState<StudioTab>("candidate");
  const [candidates, setCandidates] = useState<SavedCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projects, setProjects] = useState<LandingProject[]>(loadProjects);
  const [projectId, setProjectId] = useState<string>(() => loadProjects()[0]?.blueprint.id ?? "");
  const [selectedSectionId, setSelectedSectionId] = useState<string>("");
  const [viewport, setViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [notice, setNotice] = useState<string | null>(null);
  const project = projects.find((p) => p.blueprint.id === projectId) ?? null;
  const blueprint = project?.blueprint ?? null;
  const selectedSection = blueprint?.sections.find((s) => s.id === selectedSectionId) ?? blueprint?.sections[0] ?? null;

  const loadCandidates = useCallback(async () => {
    setLoadingCandidates(true);
    setLoadError(null);
    const result = await hunterGet<{ candidates: SavedCandidate[] }>("candidates");
    if (result.ok) setCandidates(result.candidates);
    else setLoadError(result.error);
    setLoadingCandidates(false);
  }, []);
  useEffect(() => { void loadCandidates(); }, [loadCandidates]);
  useEffect(() => { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects)); }, [projects]);
  useEffect(() => { if (blueprint && !blueprint.sections.some((s) => s.id === selectedSectionId)) setSelectedSectionId(blueprint.sections[0]?.id ?? ""); }, [blueprint, selectedSectionId]);

  const update = (fn: (draft: LandingBlueprint) => void) => {
    setProjects((prev) => prev.map((p) => {
      if (p.blueprint.id !== projectId) return p;
      const draft = cloneBlueprint(p.blueprint); fn(draft); draft.updatedAt = new Date().toISOString(); return { ...p, blueprint: draft };
    }));
  };
  const viability = useMemo(() => blueprint ? calculateLandingViability(blueprint.economics) : null, [blueprint]);
  const issues = useMemo(() => blueprint ? validateLandingBlueprint(blueprint) : [], [blueprint]);
  const blockers = issues.filter((issue) => issue.severity === "blocker");

  const createProject = (candidate: SavedCandidate) => {
    const next = createLandingBlueprint(candidate);
    setProjects((prev) => [...prev, { blueprint: next, versions: [] }]);
    setProjectId(next.id); setSelectedSectionId(next.sections[0].id); setTab("viability"); setNotice("Proyecto creado desde el candidato y su anuncio de origen.");
  };
  const saveVersion = (note = "Versión manual") => setProjects((prev) => prev.map((p) => {
    if (p.blueprint.id !== projectId) return p;
    const version = { id: studioId("version"), number: p.versions.length + 1, createdAt: new Date().toISOString(), note, blueprint: cloneBlueprint(p.blueprint) };
    return { ...p, versions: [...p.versions, version] };
  }));
  const restoreVersion = (versionId: string) => {
    const version = project?.versions.find((v) => v.id === versionId); if (!version) return;
    const restored = cloneBlueprint(version.blueprint); restored.id = projectId; restored.updatedAt = new Date().toISOString();
    setProjects((prev) => prev.map((p) => p.blueprint.id === projectId ? { ...p, blueprint: restored } : p)); setNotice(`Restaurada la versión ${version.number}.`);
  };
  const moveSection = (id: string, direction: -1 | 1) => update((draft) => {
    const index = draft.sections.findIndex((s) => s.id === id); const target = index + direction;
    if (index < 0 || target < 0 || target >= draft.sections.length) return;
    [draft.sections[index], draft.sections[target]] = [draft.sections[target], draft.sections[index]];
  });
  const duplicateSection = (section: LandingSection) => update((draft) => {
    const index = draft.sections.findIndex((s) => s.id === section.id); const copy = { ...(JSON.parse(JSON.stringify(section)) as LandingSection), id: studioId("section"), title: `${section.title} (copia)` };
    draft.sections.splice(index + 1, 0, copy); setSelectedSectionId(copy.id);
  });
  const exportBundle = () => {
    if (!blueprint || !canExportLanding(blueprint)) return;
    const bundle = buildShopifyThemeBundle(blueprint); const bundleIssues = validateShopifyThemeBundle(bundle);
    if (bundleIssues.length) { setNotice(`ZIP no válido: ${bundleIssues.join(" · ")}`); return; }
    const bytes = bundleToZip(bundle); const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }); const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = href; anchor.download = bundle.name; anchor.click(); URL.revokeObjectURL(href);
    update((draft) => draft.exports.push({ id: studioId("export"), createdAt: new Date().toISOString(), format: "shopify_theme_zip", fileName: bundle.name, published: false, validationIssueCount: issues.length }));
    setNotice("ZIP generado localmente. No se ha escrito ni publicado nada en Shopify.");
  };

  return (
    <div className="space-y-5" data-testid="landing-studio">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-[24px] font-semibold text-brand-text">Landing Studio</h2>
            <ReadinessBadge readiness="beta" title="Los proyectos se guardan en este navegador" />
          </div>
          <p className="mt-1 text-sm text-brand-muted">Del candidato a un bundle Shopify revisable, sin publicar.</p>
          {/* Transparencia, no alarma: Pedro debe saber que esto NO está
              sincronizado antes de invertir tiempo en un proyecto. */}
          <p className="mt-1 text-[12px] text-brand-tertiary">Guardado localmente en este navegador · no se sincroniza entre dispositivos</p>
        </div>
        {project ? <SelectInput label="Proyecto de landing" value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.blueprint.id, label: p.blueprint.product.name }))} /> : null}
      </div>
      <TabBar tabs={TABS} value={tab} onChange={setTab} label="Flujo de Landing Studio" counts={{ validation: blockers.length || undefined, versions: project?.versions.length || undefined }} />
      {notice ? <div className="rounded-lg border border-brand-border bg-brand-surface-subtle px-3 py-2 text-sm text-brand-text" role="status">{notice}</div> : null}

      {tab === "candidate" ? <div className="space-y-3">
        {loadingCandidates ? <Card className="p-4"><SkeletonRows rows={3} /></Card>
        : loadError ? <ErrorState message={`${loadError} El Studio no genera candidatos ficticios.`} onRetry={loadCandidates} />
        : candidates.length === 0 ? <Card><EmptyState title="No hay candidatos disponibles" hint="Guarda primero un producto en el Cazador. Si la fuente está desconectada, este estado permanece vacío." /></Card>
        : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{candidates.map((candidate) => <Card key={candidate.id} className="p-4"><div className="text-sm font-semibold text-brand-text">{candidate.productName ?? "Producto sin identificar"}</div><div className="mt-1 text-xs text-brand-muted">{candidate.advertiser ?? "Anunciante no disponible"} · {candidate.id}</div><div className="mt-4"><PrimaryButton onClick={() => createProject(candidate)}>Crear landing</PrimaryButton></div></Card>)}</div>}
      </div> : !blueprint ? <Card><EmptyState title="Selecciona un candidato" hint="El proyecto conserva producto, anuncio, proveedor, brief, assets, claims, precios, versiones, validaciones, exportaciones y experimentos." /></Card> : tab === "viability" && viability ? <div className="space-y-4">
        <MetricGroup cols={3}><MetricCell label="Ingreso neto esperado" value={formatEuro(viability.expectedNetRevenue)} support="precio × tasa de entrega" /><MetricCell label="Devoluciones esperadas" value={formatEuro(viability.expectedReturnCost)} support="coste × no entrega" /><MetricCell label="Contribución / pedido" value={formatEuro(viability.expectedContribution)} status={viability.viable === null ? "muted" : viability.viable ? "ok" : "error"} support={viability.viable === null ? "incompleto" : viability.viable ? "viable en este escenario" : "no viable en este escenario"} /></MetricGroup>
        <Card className="p-4"><SectionTitle>Supuestos y procedencia</SectionTitle><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(blueprint.economics).map(([key, field]) => <label key={key} className="text-xs text-brand-muted"><span className="flex items-center justify-between gap-2"><span>{key}</span><span>{KIND_LABEL[field.kind as EvidenceKind]}</span></span><input aria-label={key} className={`${INPUT_CLASS} mt-1 w-full`} type="number" min="0" step={key === "deliveryRate" ? "0.05" : "0.01"} value={field.value ?? ""} onChange={(e) => update((draft) => { const target = draft.economics[key as keyof typeof draft.economics]; target.value = e.target.value === "" ? null : Number(e.target.value); target.kind = e.target.value === "" ? "missing" : target.kind === "missing" ? "estimate" : target.kind; })} /></label>)}</div><p className="mt-4 text-xs text-brand-muted">{viability.formula}. Campos ausentes: {viability.missing.length ? viability.missing.join(", ") : "ninguno"}.</p></Card>
      </div> : tab === "brief" ? <div className="grid gap-4 lg:grid-cols-[1fr_320px]"><Card className="p-4"><SectionTitle>Brief de conversión</SectionTitle><div className="grid gap-3 sm:grid-cols-2">{(["audience", "problem", "promise", "primaryCta", "visualDirection"] as const).map((key) => <label key={key} className="text-xs text-brand-muted">{key}<textarea className="mt-1 min-h-24 w-full rounded-lg border border-brand-border bg-white p-3 text-sm text-brand-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/20" value={blueprint.brief[key]} onChange={(e) => update((draft) => { draft.brief[key] = e.target.value; if (key === "visualDirection") draft.visualDirection = e.target.value; })} /></label>)}</div></Card><Card className="p-4"><SectionTitle>Generación estructurada</SectionTitle><p className="text-sm text-brand-muted">El blueprint ya se ha generado desde el candidato. El editor modifica secciones y campos estructurados; nunca HTML libre.</p><PrimaryButton className="mt-4" onClick={() => { saveVersion("Blueprint antes de regenerar"); setTab("editor"); setNotice("Blueprint estructurado preparado para edición."); }}>Preparar editor</PrimaryButton></Card></div>
      : tab === "editor" && selectedSection ? <div className="grid min-h-[620px] gap-3 xl:grid-cols-[240px_minmax(0,1fr)_300px]">
        <Card className="overflow-hidden"><div className="border-b border-brand-border px-3 py-3 text-xs font-medium text-brand-muted">Estructura</div><div className="divide-y divide-brand-border">{blueprint.sections.map((section, index) => <div key={section.id} className={`p-3 ${selectedSection.id === section.id ? "bg-brand-surface-2" : ""}`}><button type="button" className="min-h-11 w-full text-left" onClick={() => setSelectedSectionId(section.id)}><span className="block text-sm font-medium text-brand-text">{section.title}</span><span className="text-xs text-brand-muted">{SECTION_TYPE_LABEL[section.type]} · {section.visible ? "Visible" : "Oculta"}</span></button><div className="mt-2 flex gap-1"><GhostButton className="md:h-8 px-2" disabled={index === 0} onClick={() => moveSection(section.id, -1)}>↑</GhostButton><GhostButton className="md:h-8 px-2" disabled={index === blueprint.sections.length - 1} onClick={() => moveSection(section.id, 1)}>↓</GhostButton><GhostButton className="md:h-8 px-2" onClick={() => duplicateSection(section)}>Duplicar</GhostButton></div></div>)}</div><div className="p-3"><GhostButton className="w-full" onClick={() => update((draft) => draft.sections.push({ id: studioId("section"), type: "benefits", eyebrow: "Nueva sección", title: "Título", body: "Contenido pendiente", items: [], claimIds: [], assetIds: [], visible: true }))}>Añadir sección</GhostButton></div></Card>
        <div className="min-w-0 overflow-auto rounded-xl bg-brand-surface-2 p-3"><Preview blueprint={blueprint} viewport="desktop" /></div>
        <Card className="p-4"><SectionTitle>Inspector</SectionTitle><div className="space-y-3">{(["eyebrow", "title", "body"] as const).map((key) => <label key={key} className="block text-xs text-brand-muted">{key}<textarea className="mt-1 min-h-20 w-full rounded-lg border border-brand-border p-2 text-sm text-brand-text" value={selectedSection[key]} onChange={(e) => update((draft) => { const section = draft.sections.find((s) => s.id === selectedSection.id); if (section) section[key] = e.target.value; })} /></label>)}<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={selectedSection.visible} onChange={(e) => update((draft) => { const section = draft.sections.find((s) => s.id === selectedSection.id); if (section) section.visible = e.target.checked; })} /> Visible</label><div className="flex flex-wrap gap-2"><GhostButton onClick={() => duplicateSection(selectedSection)}>Duplicar</GhostButton><GhostButton onClick={() => update((draft) => { if (draft.sections.length > 1) draft.sections = draft.sections.filter((s) => s.id !== selectedSection.id); })}>Eliminar</GhostButton></div></div></Card>
      </div> : tab === "preview" ? <div className="space-y-4"><div className="flex gap-2"><GhostButton onClick={() => setViewport("desktop")}>Escritorio</GhostButton><GhostButton onClick={() => setViewport("tablet")}>Tablet</GhostButton><GhostButton onClick={() => setViewport("mobile")}>Móvil</GhostButton></div><div className="overflow-auto rounded-xl bg-brand-surface-2 p-3"><Preview blueprint={blueprint} viewport={viewport} /></div></div>
      : tab === "validation" ? <div className="space-y-4"><div className="flex items-center gap-2"><Badge status={blockers.length ? "error" : "ok"}>{blockers.length ? `${blockers.length} bloqueos` : "Sin bloqueos"}</Badge><span className="text-sm text-brand-muted">{issues.length - blockers.length} avisos</span></div><Card className="divide-y divide-brand-border">{issues.length === 0 ? <EmptyState title="Validación superada" hint="Claims, precio, assets y estructura están listos para exportar." /> : issues.map((issue, index) => <div key={`${issue.code}-${index}`} className="flex gap-3 p-4"><Badge status={issue.severity === "blocker" ? "error" : "warn"}>{issue.severity === "blocker" ? "Bloqueo" : "Aviso"}</Badge><div><div className="text-sm text-brand-text">{issue.message}</div><div className="mt-1 font-mono text-[11px] text-brand-muted">{issue.code}</div></div></div>)}</Card><Card className="p-4"><SectionTitle>Claims y evidencia</SectionTitle>{blueprint.claims.map((claim) => <div key={claim.id} className="grid gap-2 border-b border-brand-border py-3 last:border-0 md:grid-cols-[1fr_150px_1fr]"><input className={INPUT_CLASS} value={claim.text} onChange={(e) => update((draft) => { const c = draft.claims.find((x) => x.id === claim.id); if (c) c.text = e.target.value; })} /><SelectInput label={`Estado de ${claim.text}`} value={claim.status} onChange={(value) => update((draft) => { const c = draft.claims.find((x) => x.id === claim.id); if (c) c.status = value as ClaimStatus; })} options={Object.entries(CLAIM_STATUS_LABEL).map(([value, label]) => ({ value, label }))} /><input className={INPUT_CLASS} placeholder="Fuente o evidencia" value={claim.evidence ?? ""} onChange={(e) => update((draft) => { const c = draft.claims.find((x) => x.id === claim.id); if (c) c.evidence = e.target.value || null; })} /></div>)}</Card></div>
      : tab === "versions" ? <div className="grid gap-4 lg:grid-cols-[1fr_320px]"><Card className="divide-y divide-brand-border">{project?.versions.length ? [...project.versions].reverse().map((version) => <div key={version.id} className="flex items-center gap-3 p-4"><div className="flex-1"><div className="text-sm font-medium text-brand-text">Versión {version.number} · {version.note}</div><div className="text-xs text-brand-muted">{new Date(version.createdAt).toLocaleString("es-ES")}</div></div><GhostButton onClick={() => restoreVersion(version.id)}>Restaurar</GhostButton></div>) : <EmptyState title="Sin versiones todavía" hint="Guarda una versión antes de cambios importantes." />}</Card><Card className="p-4"><SectionTitle>Nueva versión</SectionTitle><p className="text-sm text-brand-muted">Captura todo el blueprint, no HTML. Restaurar crea un estado editable sin borrar el historial.</p><PrimaryButton className="mt-4" onClick={() => saveVersion()}>Guardar versión</PrimaryButton></Card></div>
      : <div className="grid gap-4 lg:grid-cols-[1fr_360px]"><Card className="p-4"><SectionTitle>Bundle Shopify</SectionTitle><p className="text-sm text-brand-muted">Genera secciones Liquid con schema nativo, template JSON, CSS/JS compartidos, locales y manifest. El ZIP se descarga en tu equipo; no se conecta a Shopify.</p><ul className="mt-4 space-y-2 text-sm text-brand-text"><li>Scoping por <code>section.id</code> y BEM</li><li><code>image_picker</code>, <code>video</code>, <code>product</code>, <code>font_picker</code> y <code>color_scheme</code></li><li>Sin publicación ni escritura externa</li></ul><PrimaryButton className="mt-5" disabled={blockers.length > 0} onClick={exportBundle}>Descargar ZIP verificable</PrimaryButton>{blockers.length ? <p className="mt-2 text-xs text-red-600">Resuelve {blockers.length} bloqueos en Validación.</p> : null}</Card><Card className="p-4"><SectionTitle>Experimento A/B</SectionTitle><p className="text-sm text-brand-muted">Preparado, no activado. Métrica principal: pedido confirmado; evita confundir pedido creado con entrega.</p>{blueprint.experiments.map((experiment) => <div key={experiment.id} className="mt-3 rounded-lg border border-brand-border p-3"><div className="text-sm font-medium">{experiment.name}</div><div className="mt-1 text-xs text-brand-muted">A · Control<br />B · Variante<br />Estado: borrador</div></div>)}</Card></div>}
    </div>
  );
}
