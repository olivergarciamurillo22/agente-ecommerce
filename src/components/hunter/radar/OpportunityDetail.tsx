"use client";

// ============================================================
// WINNER RADAR — FICHA DE UN PRODUCTO.
//
// ══ POR QUÉ ES UNA PANTALLA Y NO UN PANEL LATERAL ══
// La primera versión era un cajón que tapaba media pantalla y se cerraba con
// una X pequeña arriba a la derecha. Estaba mal por dos motivos:
//
//   · No se veía cómo salir. Una X sin borde ni etiqueta, sobre contenido
//     claro, en la esquina, no es un botón: es un adorno que resulta que
//     funciona.
//   · El contenido no cabe. Siete pestañas con tablas de competidores y
//     rejillas de anuncios necesitan ancho; en un cajón todo sale apretado y
//     además deja media pantalla inútil detrás, en gris.
//
// El panel ya resuelve esto en otros sitios: las secciones son PANTALLAS con
// su cabecera y su vuelta atrás, y los cajones se reservan para fichas
// cortas (un pedido, un formulario). Esto es una pantalla.
//
// «Volver a los resultados» es un botón con texto. Atrás y Escape siguen
// funcionando —`useOverlayBack`—, pero no son la única salida: nadie debería
// tener que adivinar un gesto.
//
// Siete pestañas, y todas responden a una pregunta distinta:
//   Resumen        ¿qué es y qué hago con esto?
//   Anuncios       ¿qué se está publicando de verdad?
//   Creatividades  ¿qué ángulos funcionan?
//   Competidores   ¿quién lo vende y desde cuándo?
//   Evolución      ¿va a más o a menos?
//   Economía       ¿me deja dinero?
//   Cómo se calcula ¿de dónde sale cada número?
//
// La última no es un extra de auditoría: es la que permite NO fiarse. Un
// score sin poder abrirlo es un oráculo, y aquí se decide con dinero real.
// ============================================================

import { useEffect, useState } from "react";
import { useOverlayBack } from "@/components/useBackable";
import type { ProductOpportunity } from "@/lib/hunter/types";
import { PRODUCT_FEATURE_LABEL } from "@/lib/hunter/types";
import type { CreativeAnalysis } from "@/lib/hunter/intelligence";
import { Card, EmptyState, GhostButton, PrimaryButton, SectionTitle, TabBar, TextButton } from "@/components/ui";
import { IconBack, IconChevronRight } from "@/components/icons";
import {
  Badge,
  ProductCover,
  ProvenanceTag,
  ScoreBar,
  ScoreBig,
  Stat,
  UNKNOWN,
  VerdictChip,
  miles,
  money,
  pct,
  plural,
  scoreLabel,
} from "./radar-shared";

type Pestana = "resumen" | "anuncios" | "creatividades" | "competidores" | "evolucion" | "economia" | "calculo";

const PESTANAS: Array<{ id: Pestana; label: string }> = [
  { id: "resumen", label: "Resumen" },
  { id: "anuncios", label: "Anuncios" },
  { id: "creatividades", label: "Creatividades" },
  { id: "competidores", label: "Competidores" },
  { id: "evolucion", label: "Evolución" },
  { id: "economia", label: "Economía" },
  { id: "calculo", label: "Cómo se calcula" },
];

export interface DetailPayload {
  opportunity: ProductOpportunity;
  why: string;
  verdict: { recommendation: string; because: string; blockers: string[] };
  ads: Array<{
    id: string; advertiserName: string | null; platform: string; format: string | null;
    adCopy: string | null; startedAt: number | null; active: boolean | null; activeDays: number | null;
    previewUrl: string | null; landingUrl: string | null; imageUrl: string | null;
  }>;
  adCount: number;
  competitors: Array<{ name: string; adCount: number; activeCount: number; oldestDays: number | null; countries: string[]; adLibraryUrl: string | null }>;
  creatives: CreativeAnalysis;
  history: Array<{ takenAt: number; signals: ProductOpportunity["signals"] }>;
  testPlan: { recommendedPrice: number | null; targetCPA: number | null; breakEvenCPA: number | null; recommendedDailyBudget: number | null; testDurationDays: number | null; creativeAngles: string[]; rationale: string[] } | null;
}

export default function OpportunityDetail({
  data,
  onClose,
  onAction,
}: {
  data: DetailPayload;
  onClose: () => void;
  onAction: (a: "test" | "watch" | "save" | "discard") => void;
}) {
  const [tab, setTab] = useState<Pestana>("resumen");
  const op = data.opportunity;
  useOverlayBack(true, onClose);

  // Al cambiar de producto se vuelve a Resumen: dejar abierta «Competidores»
  // del anterior confunde sobre qué se está mirando.
  useEffect(() => setTab("resumen"), [op.id]);

  return (
    <div className="flex h-full flex-col bg-brand-bg">
      {/* ══ Cabecera: la salida es lo primero que se ve ══ */}
      <div className="shrink-0 border-b border-brand-border bg-brand-surface">
        <div className="mx-auto w-full max-w-[1180px] px-4 md:px-8">
          <button
            type="button"
            onClick={onClose}
            className="-ml-2 mt-3 inline-flex items-center gap-1.5 rounded-lg px-2.5 h-9 text-[13px] font-medium text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text transition-colors"
          >
            <IconBack size={16} />
            Volver a los resultados
          </button>

          <div className="flex flex-col gap-4 pt-3 pb-4 sm:flex-row sm:items-start">
            <div className="w-[120px] shrink-0">
              <ProductCover name={op.canonicalName} imageUrl={op.heroImageUrl ?? op.images[0] ?? null} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <VerdictChip verdict={op.recommendation} size="lg" />
                {op.badges.map((b) => (
                  <Badge key={b} badge={b} />
                ))}
              </div>
              <h2 className="mt-2 text-[20px] md:text-[24px] font-semibold leading-snug tracking-tight">{op.canonicalName}</h2>
              <p className="mt-1 max-w-[70ch] text-[13.5px] leading-relaxed text-brand-muted">{data.verdict.because}</p>
            </div>
            <div className="shrink-0 sm:pt-1">
              <ScoreBig value={op.scores.opportunity} />
            </div>
          </div>

          <TabBar
            tabs={PESTANAS}
            value={tab}
            onChange={setTab}
            label="Secciones del producto"
            counts={{ anuncios: data.adCount > 0 ? data.adCount : undefined }}
          />
        </div>
      </div>

      {/* ══ Contenido ══ */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 md:px-8 py-6">
          {tab === "resumen" && <Resumen data={data} />}
          {tab === "anuncios" && <Anuncios data={data} />}
          {tab === "creatividades" && <Creatividades c={data.creatives} />}
          {tab === "competidores" && <Competidores data={data} />}
          {tab === "evolucion" && <Evolucion data={data} />}
          {tab === "economia" && <Economia data={data} />}
          {tab === "calculo" && <Calculo op={op} />}
        </div>
      </div>

      {/* ══ Acciones: fijas abajo, siempre alcanzables ══ */}
      <div className="shrink-0 border-t border-brand-border bg-brand-surface">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-2 px-4 md:px-8 py-3">
          <PrimaryButton onClick={() => onAction("test")}>Preparar test</PrimaryButton>
          <GhostButton onClick={() => onAction("watch")}>Vigilar</GhostButton>
          <GhostButton onClick={() => onAction("save")}>Guardar</GhostButton>
          <div className="flex-1" />
          {op.adLibraryUrl && (
            <a
              href={op.adLibraryUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-11 md:h-9 items-center gap-1 rounded-lg border border-brand-border bg-brand-surface px-3 text-[13px] font-medium text-brand-text hover:border-brand-border-strong hover:bg-brand-surface-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-text/30"
            >
              Ver en Meta
              <IconChevronRight size={14} />
            </a>
          )}
          <TextButton onClick={() => onAction("discard")} className="px-2 text-brand-tertiary">
            Descartar
          </TextButton>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------

function Seccion({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="mb-7">
      <SectionTitle>{title}</SectionTitle>
      {hint && <p className="-mt-2 mb-2 text-[12px] text-brand-tertiary">{hint}</p>}
      {children}
    </section>
  );
}

function Vacio({ titulo, children }: { titulo: string; children?: string }) {
  return (
    <Card>
      <EmptyState title={titulo} hint={children} />
    </Card>
  );
}

function Resumen({ data }: { data: DetailPayload }) {
  const op = data.opportunity;
  const s = op.signals;
  return (
    <>
      <Seccion title="Señales">
        <div className="grid max-w-[720px] grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Anunciantes" value={miles(s.advertiserCount)} />
          <Stat label="Anuncios activos" value={miles(s.activeAds)} hint={`de ${miles(s.totalAds)} vistos`} />
          <Stat label="Creatividades" value={miles(s.creativeCount)} />
          <Stat label="El más veterano" value={s.oldestActiveAdDays === null ? UNKNOWN : plural(s.oldestActiveAdDays, "día", "días")} />
        </div>
      </Seccion>

      <Seccion title="Puntuaciones">
        <Card className="max-w-[560px] px-4 py-3">
          <ScoreBar label="Mercado" value={op.scores.market.score} word={scoreLabel(op.scores.market)} />
          <ScoreBar label="Tendencia" value={op.scores.momentum.score} word={scoreLabel(op.scores.momentum)} tone="good" />
          <ScoreBar label="Saturación" value={op.scores.saturation.score} word={scoreLabel(op.scores.saturation, "saturation")} tone="warn" />
          <ScoreBar label="Señal creativa" value={op.scores.creative_investment.score} word={scoreLabel(op.scores.creative_investment)} />
          <ScoreBar label="Producto" value={op.scores.product.score} word={scoreLabel(op.scores.product)} />
          <ScoreBar label="Encaje Casamable" value={op.scores.casamable.score} word={scoreLabel(op.scores.casamable)} />
        </Card>
      </Seccion>

      {op.summary && (
        <>
          <Seccion title="Lo que hemos observado" hint="Contado sobre los anuncios. No es interpretación.">
            <ul className="space-y-1 text-[13.5px] leading-relaxed">
              {op.summary.observed.map((l, i) => (
                <li key={i}>· {l}</li>
              ))}
            </ul>
          </Seccion>
          {op.summary.inferred.length > 0 && (
            <Seccion title="Cómo lo leemos" hint="Interpretación, no medición.">
              <ul className="space-y-1 text-[13.5px] leading-relaxed text-brand-muted">
                {op.summary.inferred.map((l, i) => (
                  <li key={i}>· {l}</li>
                ))}
              </ul>
            </Seccion>
          )}
        </>
      )}

      {(data.verdict.blockers.length > 0 || (op.summary?.risks.length ?? 0) > 0) && (
        <Seccion title="Riesgos y lo que falta">
          <ul className="space-y-1 text-[13.5px] leading-relaxed text-amber-900">
            {data.verdict.blockers.map((b, i) => (
              <li key={`b${i}`}>· {b}</li>
            ))}
            {(op.summary?.risks ?? []).map((r, i) => (
              <li key={`r${i}`}>· {r}</li>
            ))}
          </ul>
        </Seccion>
      )}

      {op.landingDomain && (
        <Seccion title="A dónde llevan los anuncios">
          <a
            href={`https://${op.landingDomain}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[13.5px] text-brand-info underline underline-offset-2"
          >
            {op.landingDomain}
          </a>
        </Seccion>
      )}
    </>
  );
}

function Anuncios({ data }: { data: DetailPayload }) {
  const [orden, setOrden] = useState<"antiguos" | "recientes" | "pagina">("antiguos");
  if (data.ads.length === 0) return <Vacio titulo="Sin anuncios guardados">Los anuncios se guardan al ejecutar una búsqueda. Vuelve a lanzarla y aparecerán aquí.</Vacio>;

  const lista = [...data.ads].sort((a, b) => {
    if (orden === "pagina") return (a.advertiserName ?? "").localeCompare(b.advertiserName ?? "");
    // «Antiguos primero» es el orden útil: un anuncio que lleva meses vivo es
    // la mejor prueba de que el producto vende.
    if (orden === "antiguos") return (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity);
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] text-brand-tertiary">Ordenar por</span>
        <select
          value={orden}
          onChange={(e) => setOrden(e.target.value as typeof orden)}
          className="h-9 rounded-lg border border-brand-border bg-brand-surface px-2 text-[13px] cursor-pointer"
        >
          <option value="antiguos">Los que llevan más tiempo</option>
          <option value="recientes">Los más nuevos</option>
          <option value="pagina">Página</option>
        </select>
        {data.adCount > data.ads.length && (
          <span className="text-[12px] text-brand-tertiary">
            Mostrando {miles(data.ads.length)} de {miles(data.adCount)}
          </span>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {lista.map((a) => (
          <Card key={a.id} className="p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-medium truncate">{a.advertiserName ?? "Sin nombre"}</span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[.06em] ${
                  a.active ? "bg-emerald-50 text-emerald-800" : "bg-brand-surface-2 text-brand-tertiary"
                }`}
              >
                {a.active ? "activo" : "parado"}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-brand-tertiary">
              {a.startedAt ? new Date(a.startedAt * 1000).toLocaleDateString("es-ES") : "sin fecha"}
              {a.activeDays !== null && ` · ${a.activeDays} días`}
              {a.platform && ` · ${a.platform}`}
            </div>
            {a.adCopy && <p className="mt-2 text-[12.5px] leading-relaxed text-brand-muted line-clamp-4">{a.adCopy}</p>}
            <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
              {a.previewUrl && (
                <a href={a.previewUrl} target="_blank" rel="noreferrer noopener" className="text-brand-info underline underline-offset-2">
                  Ver en Meta
                </a>
              )}
              {a.landingUrl && (
                <a
                  href={a.landingUrl.includes("://") ? a.landingUrl : `https://${a.landingUrl}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-brand-info underline underline-offset-2"
                >
                  {a.landingUrl.replace(/^https?:\/\//, "").slice(0, 32)}
                </a>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Creatividades({ c }: { c: CreativeAnalysis }) {
  const vacio = c.hooks.length === 0 && c.angles.length === 0 && c.traits.length === 0;
  if (vacio) return <Vacio titulo="Sin texto que analizar">Estos anuncios no traen copy, así que no hay ángulos ni ganchos que leer.</Vacio>;
  return (
    <>
      {c.dominantFormat && (
        <Seccion title="Formato dominante">
          <p className="text-[15px] font-medium capitalize">{c.dominantFormat}</p>
        </Seccion>
      )}
      {c.hooks.length > 0 && (
        <Seccion title="Ganchos que más se repiten" hint="Primera frase de cada anuncio: es donde se juega la atención.">
          <ul className="space-y-1.5">
            {c.hooks.map((h, i) => (
              <li key={i} className="rounded-lg border border-brand-border bg-brand-surface px-3 py-2 text-[13.5px] leading-relaxed shadow-[var(--shadow-card)]">
                «{h}»
              </li>
            ))}
          </ul>
        </Seccion>
      )}
      {c.angles.length > 0 && (
        <Seccion title="Ángulos de venta">
          <div className="flex flex-wrap gap-1.5">
            {c.angles.map((a) => (
              <span key={a} className="rounded-full bg-brand-surface-2 px-3 py-1 text-[12.5px] text-brand-muted">
                {a}
              </span>
            ))}
          </div>
        </Seccion>
      )}
      {c.traits.length > 0 && (
        <Seccion title="Rasgos observados">
          <div className="flex flex-wrap gap-1.5">
            {c.traits.map((t) => (
              <span key={t} className="rounded-full bg-brand-surface-2 px-3 py-1 text-[12.5px] text-brand-muted">
                {t}
              </span>
            ))}
          </div>
        </Seccion>
      )}
      {c.takeaways.length > 0 && (
        <Seccion title="Qué copiaría">
          <ul className="space-y-1 text-[13.5px] leading-relaxed">
            {c.takeaways.map((t, i) => (
              <li key={i}>· {t}</li>
            ))}
          </ul>
        </Seccion>
      )}
      {!c.aiGenerated && (
        <p className="text-[11px] text-brand-tertiary">
          Análisis por patrones de texto, sin modelo. Con clave de IA la lectura es bastante más fina.
        </p>
      )}
    </>
  );
}

function Competidores({ data }: { data: DetailPayload }) {
  if (data.competitors.length === 0) return <Vacio titulo="Sin anunciantes identificados">Ninguno de los anuncios trae el nombre de la página que lo publica.</Vacio>;
  return (
    <Card className="overflow-x-auto px-4 py-1">
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="border-b border-brand-border text-left text-[11px] uppercase tracking-[.08em] text-brand-tertiary">
            <th className="pb-2 font-medium">Página</th>
            <th className="pb-2 font-medium text-right">Anuncios</th>
            <th className="pb-2 font-medium text-right">Activos</th>
            <th className="pb-2 font-medium text-right">Antigüedad</th>
            <th className="pb-2 font-medium">Países</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-brand-border">
          {data.competitors.map((c) => (
            <tr key={c.name}>
              <td className="py-2 pr-3 font-medium">{c.name}</td>
              <td className="py-2 text-right tabular-nums">{miles(c.adCount)}</td>
              <td className="py-2 text-right tabular-nums">{miles(c.activeCount)}</td>
              <td className="py-2 text-right tabular-nums text-brand-muted">
                {c.oldestDays === null ? "—" : `${c.oldestDays} d`}
              </td>
              <td className="py-2 pl-3 text-brand-muted">{c.countries.join(", ") || "—"}</td>
              <td className="py-2 pl-3 text-right">
                {c.adLibraryUrl && (
                  <a href={c.adLibraryUrl} target="_blank" rel="noreferrer noopener" className="text-brand-info underline underline-offset-2">
                    Ver
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Evolucion({ data }: { data: DetailPayload }) {
  const h = data.history;
  const s = data.opportunity.signals;

  if (h.length < 2) {
    return (
      <>
        <Vacio titulo="Todavía no hay tendencia">
          Solo tenemos una foto de este producto. La tendencia necesita al menos dos: repite la búsqueda dentro de unos días —o ponlo en Vigilar— y aquí saldrá la evolución.
        </Vacio>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Anuncios activos hoy" value={miles(s.activeAds)} />
          <Stat label="Anunciantes hoy" value={miles(s.advertiserCount)} />
          <Stat label="Creatividades" value={miles(s.creativeCount)} />
          <Stat label="Nuevos en 7 días" value={s.newAds7d === null ? UNKNOWN : miles(s.newAds7d)} />
        </div>
      </>
    );
  }

  const primero = h[0].signals;
  const ultimo = h[h.length - 1].signals;
  const max = Math.max(...h.map((p) => p.signals.activeAds), 1);

  return (
    <>
      <Seccion title="Actividad" hint={`${h.length} fotos guardadas`}>
        <Card className="flex h-24 items-end gap-1 px-3 py-3">
          {h.map((p) => (
            <div
              key={p.takenAt}
              title={`${new Date(p.takenAt * 1000).toLocaleDateString("es-ES")}: ${p.signals.activeAds} anuncios activos`}
              className="min-w-[3px] flex-1 rounded-sm bg-brand-gold/75"
              style={{ height: `${Math.max(4, (p.signals.activeAds / max) * 100)}%` }}
            />
          ))}
        </Card>
      </Seccion>

      <Seccion title="Cambio en el periodo">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Delta label="Anuncios activos" antes={primero.activeAds} ahora={ultimo.activeAds} />
          <Delta label="Anunciantes" antes={primero.advertiserCount} ahora={ultimo.advertiserCount} />
          <Delta label="Creatividades" antes={primero.creativeCount} ahora={ultimo.creativeCount} />
        </div>
      </Seccion>
    </>
  );
}

function Delta({ label, antes, ahora }: { label: string; antes: number; ahora: number }) {
  const cambio = antes > 0 ? Math.round(((ahora - antes) / antes) * 100) : null;
  const sube = ahora > antes;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[.08em] text-brand-tertiary">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-[17px] font-semibold tabular-nums">{miles(ahora)}</span>
        <span className="text-[12px] tabular-nums text-brand-tertiary">antes {miles(antes)}</span>
      </div>
      {cambio !== null && cambio !== 0 && (
        <div className={`text-[12px] font-medium tabular-nums ${sube ? "text-emerald-700" : "text-brand-tertiary"}`}>
          {sube ? "+" : ""}
          {cambio} %
        </div>
      )}
    </div>
  );
}

function Economia({ data }: { data: DetailPayload }) {
  const e = data.opportunity.economics;
  const tp = data.testPlan;
  if (!e) {
    return (
      <Vacio titulo="Falta el coste de proveedor">
        Sin él no se puede calcular nada de esto. Dropi no tiene API pública, así que ese dato hay que meterlo a mano — y hasta que esté, cualquier margen que enseñáramos aquí sería inventado.
      </Vacio>
    );
  }
  return (
    <>
      <Seccion title="Por pedido" hint="Calculado con tus tasas reales de entrega y rehúse, no con medias del sector.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat
            label="Precio de venta"
            value={
              <>
                {money(e.salePrice.value)} <ProvenanceTag provenance={e.salePrice.provenance} />
              </>
            }
          />
          <Stat
            label="Coste de proveedor"
            value={
              <>
                {money(e.supplierCost.value)} <ProvenanceTag provenance={e.supplierCost.provenance} />
              </>
            }
          />
          <Stat
            label="Beneficio esperado"
            value={
              <>
                {money(e.expectedProfit.value)} <ProvenanceTag provenance={e.expectedProfit.provenance} />
              </>
            }
          />
          <Stat label="Margen" value={pct(e.margin.value)} />
          <Stat label="CPA de equilibrio" value={money(e.breakEvenCPA.value)} hint="A partir de aquí se pierde dinero." />
          <Stat label="CPA objetivo" value={money(tp?.targetCPA ?? null)} />
        </div>
      </Seccion>

      {tp && (
        <Seccion title="Si lo testeas">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Precio sugerido" value={money(tp.recommendedPrice)} />
            <Stat label="Presupuesto diario" value={money(tp.recommendedDailyBudget)} />
            <Stat label="Duración" value={tp.testDurationDays === null ? UNKNOWN : `${tp.testDurationDays} días`} />
            <Stat label="Ángulos" value={miles(tp.creativeAngles.length)} />
          </div>
          {tp.rationale.length > 0 && (
            <ul className="mt-3 space-y-1 text-[12.5px] leading-relaxed text-brand-muted">
              {tp.rationale.map((r, i) => (
                <li key={i}>· {r}</li>
              ))}
            </ul>
          )}
        </Seccion>
      )}
    </>
  );
}

function Calculo({ op }: { op: ProductOpportunity }) {
  const partes = op.scores.opportunity.parts;
  return (
    <>
      <Seccion title="De qué se compone el score" hint="Media ponderada con penalizaciones duras, no un promedio simple.">
        {partes.length === 0 ? (
          <Vacio titulo="El score no se ha podido calcular">
            {op.scores.opportunity.unavailableReason === "INSUFFICIENT_HISTORY"
              ? "Hace falta al menos una foto anterior de este producto para poder comparar."
              : "No hay señales suficientes: hacen falta más anuncios o más anunciantes."}
          </Vacio>
        ) : (
          <Card className="overflow-hidden px-4 py-1">
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-brand-border">
              {partes.map((p) => (
                <tr key={p.key}>
                  <td className="py-1.5 pr-3">{p.label}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium">{p.value === null ? UNKNOWN : Math.round(p.value)}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums text-brand-tertiary">×{p.weight}</td>
                  <td className="py-1.5 pl-3 text-brand-tertiary">{p.observed ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </Card>
        )}
      </Seccion>

      {op.features.length > 0 && (
        <Seccion title="Lo que infirió la IA" hint="Leyendo el texto de los anuncios. Es una lectura, no una medición.">
          <Card className="overflow-hidden px-4 py-1">
          <table className="w-full text-[13px]">
            <tbody className="divide-y divide-brand-border">
              {op.features.map((f) => (
                <tr key={f.key}>
                  <td className="py-1.5 pr-3">{PRODUCT_FEATURE_LABEL[f.key] ?? f.key}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium">{f.value === null ? UNKNOWN : Math.round(f.value)}</td>
                  <td className="py-1.5 pl-3 text-brand-tertiary">{f.rationale ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </Card>
        </Seccion>
      )}

      <Seccion title="Fiabilidad">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Confianza" value={pct(op.scores.opportunity.confidence)} />
          <Stat label="Agrupación" value={pct(op.clusterConfidence)} hint="Cuánto nos fiamos de que todo esto sea UN producto." />
          <Stat label="Fuentes" value={op.providers.join(", ") || UNKNOWN} />
        </div>
      </Seccion>
    </>
  );
}
