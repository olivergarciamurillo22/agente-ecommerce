"use client";

// Ficha del candidato: drawer derecho (560 px) en escritorio, hoja a pantalla
// completa en móvil. Secciones planas separadas por hairlines. Todo lo que la
// fuente no sabe se pinta como "No disponible".

import { useCallback, useEffect, useState } from "react";
import { formatEuro, GhostButton, ModalShell, PrimaryButton, Skeleton, StatusDot } from "../ui";
import {
  computeCandidateMargin,
  landingDomain,
  SCORE_PENDING_LABEL,
  scoreLabel,
  signalValueLabel,
  toCandidateShape,
  UNAVAILABLE_LABEL,
} from "@/lib/product-hunter/scoring";
import {
  CREATIVE_FORMAT_LABEL,
  PRODUCT_RESEARCH_STATUS_LABEL,
  PRODUCT_RESEARCH_STATUSES,
  type AdLibraryResult,
  type CandidateEconomics,
  type ProductResearchStatus,
  type WinningProductCandidate,
} from "@/lib/product-hunter/types";
import { displayName, PreviewImage, ToggleButton } from "./CandidateCard";
import {
  confidenceLabel,
  confidenceStatus,
  CountryChips,
  DataStatusPill,
  Drawer,
  DrawerSection,
  FactRow,
  Field,
  formatDate,
  formatDateTime,
  formatDays,
  formatPrice,
  formatVariations,
  hunterGet,
  hunterPost,
  INPUT_CLASS,
  InlineNotice,
  MAX_COMPARE,
  Pill,
  SaturationPill,
  SELECT_CLASS,
  TEXTAREA_CLASS,
} from "./hunter-shared";

export interface DetailTarget {
  id: string;
  /** Lo que ya sabíamos (tarjeta) para pintar al instante mientras carga. */
  initial?: AdLibraryResult | WinningProductCandidate;
}

interface EconomicsForm {
  costEstimate: string;
  salePriceEstimate: string;
  shippingCost: string;
  returnCost: string;
}

const PIPELINE_TARGETS = PRODUCT_RESEARCH_STATUSES.filter((s) => s !== "discovered");

function isCandidate(x: AdLibraryResult | WinningProductCandidate): x is WinningProductCandidate {
  return "status" in x && "decisions" in x;
}

function numToField(n: number | null): string {
  return n === null ? "" : String(n);
}

function fieldToNum(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function economicsForm(e: CandidateEconomics | null): EconomicsForm {
  return {
    costEstimate: numToField(e?.costEstimate ?? null),
    salePriceEstimate: numToField(e?.salePriceEstimate ?? null),
    shippingCost: numToField(e?.shippingCost ?? null),
    returnCost: numToField(e?.returnCost ?? null),
  };
}

function formToEconomics(f: EconomicsForm): CandidateEconomics {
  return {
    costEstimate: fieldToNum(f.costEstimate),
    salePriceEstimate: fieldToNum(f.salePriceEstimate),
    shippingCost: fieldToNum(f.shippingCost),
    returnCost: fieldToNum(f.returnCost),
  };
}

function SignalBar({ value }: { value: number | null }) {
  if (value === null) {
    return <div className="h-1.5 w-full rounded-full border border-dashed border-brand-border" aria-hidden />;
  }
  const w = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full rounded-full bg-brand-surface-2 overflow-hidden" aria-hidden>
      <div className="h-full rounded-full bg-brand-gold transition-[width] duration-200" style={{ width: `${w}%` }} />
    </div>
  );
}

export default function CandidateDetail({
  target,
  onClose,
  onChanged,
  compareIds,
  onToggleCompare,
}: {
  target: DetailTarget | null;
  onClose: () => void;
  onChanged: (candidate: WinningProductCandidate) => void;
  compareIds: string[];
  onToggleCompare: (id: string) => void;
}) {
  const [candidate, setCandidate] = useState<WinningProductCandidate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "move" | "note" | "economics" | null>(null);
  const [moveTo, setMoveTo] = useState<ProductResearchStatus>("researching");
  const [moveNote, setMoveNote] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [eco, setEco] = useState<EconomicsForm>(economicsForm(null));
  const [deliveryRate, setDeliveryRate] = useState("0.7");

  const targetId = target?.id ?? null;

  const load = useCallback(async () => {
    if (!target) return;
    const seed = target.initial ? (isCandidate(target.initial) ? target.initial : toCandidateShape(target.initial)) : null;
    setCandidate(seed);
    setEco(economicsForm(seed?.economics ?? null));
    setLoading(true);
    setError(null);
    setNotice(null);
    const r = await hunterGet<{ candidate: WinningProductCandidate }>("candidate", { id: target.id });
    if (r.ok) {
      setCandidate(r.candidate);
      setEco(economicsForm(r.candidate.economics));
    } else if (r.code === "NOT_FOUND" && seed) {
      // Resultado aún sin guardar en el backend: seguimos con lo que sabíamos.
      setCandidate(seed);
    } else if (!seed) {
      setError(r.error);
    }
    setLoading(false);
  }, [target]);

  useEffect(() => {
    if (!targetId) return;
    setMoveNote("");
    setNoteText("");
    setConfirmDiscard(false);
    void load();
    // `load` ya depende de `target`; solo queremos recargar al cambiar de id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  useEffect(() => {
    if (!candidate) return;
    const next = PIPELINE_TARGETS.find((s) => s !== candidate.status && PRODUCT_RESEARCH_STATUSES.indexOf(s) > PRODUCT_RESEARCH_STATUSES.indexOf(candidate.status));
    setMoveTo(next ?? (candidate.status === "discovered" ? "saved" : candidate.status));
  }, [candidate?.id, candidate?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyResult = (r: { ok: true; candidate: WinningProductCandidate } | { ok: false; error: string }, okText: string) => {
    if (r.ok) {
      setCandidate(r.candidate);
      setEco(economicsForm(r.candidate.economics));
      onChanged(r.candidate);
      setNotice({ tone: "ok", text: okText });
    } else {
      setNotice({ tone: "error", text: r.error });
    }
  };

  const save = async () => {
    if (!candidate) return;
    setBusy("save");
    const r = await hunterPost<{ candidate: WinningProductCandidate }>({ op: "save", result: candidate });
    applyResult(r, "Guardado en el pipeline.");
    setBusy(null);
  };

  const move = async () => {
    if (!candidate) return;
    setConfirmDiscard(false);
    setBusy("move");
    const r = await hunterPost<{ candidate: WinningProductCandidate }>({ op: "move", id: candidate.id, status: moveTo, note: moveNote.trim() || null });
    applyResult(r, `Movido a ${PRODUCT_RESEARCH_STATUS_LABEL[moveTo]}.`);
    if (r.ok) setMoveNote("");
    setBusy(null);
  };

  const addNote = async () => {
    if (!candidate || !noteText.trim()) return;
    setBusy("note");
    const r = await hunterPost<{ candidate: WinningProductCandidate }>({ op: "note", id: candidate.id, text: noteText.trim() });
    applyResult(r, "Nota añadida.");
    if (r.ok) setNoteText("");
    setBusy(null);
  };

  const saveEconomics = async () => {
    if (!candidate) return;
    setBusy("economics");
    const r = await hunterPost<{ candidate: WinningProductCandidate }>({ op: "economics", id: candidate.id, economics: formToEconomics(eco) });
    applyResult(r, "Economía guardada.");
    setBusy(null);
  };

  const open = target !== null;
  const unsaved = candidate ? candidate.savedAt === null || candidate.status === "discovered" : true;
  const title = candidate ? displayName(candidate) : "Detalle";
  const rate = Number(deliveryRate.replace(",", "."));
  const margin = computeCandidateMargin(formToEconomics(eco), Number.isFinite(rate) ? rate : 0.7);
  const score = candidate?.winnerScore ?? null;
  const label = scoreLabel(score);
  const compared = candidate ? compareIds.includes(candidate.id) : false;
  const compareFull = compareIds.length >= MAX_COMPARE;

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={title}
        subtitle={candidate ? `${candidate.advertiser ?? `Anunciante ${UNAVAILABLE_LABEL.toLowerCase()}`} · ${candidate.id}` : undefined}
        header={
          candidate ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <DataStatusPill status={candidate.dataStatus} />
              <Pill tone={unsaved ? "neutral" : "accent"}>{PRODUCT_RESEARCH_STATUS_LABEL[candidate.status]}</Pill>
              <ToggleButton active={compared} disabled={!compared && compareFull} onClick={() => onToggleCompare(candidate.id)} size="sm">
                {compared ? "Comparando" : "Comparar"}
              </ToggleButton>
            </div>
          ) : null
        }
        footer={
          candidate && unsaved ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-brand-muted">Guárdalo para moverlo por el pipeline y anotar.</span>
              <PrimaryButton onClick={() => void save()} busy={busy === "save"}>
                Guardar
              </PrimaryButton>
            </div>
          ) : undefined
        }
      >
        {error && !candidate ? (
          <div className="px-5 py-10 text-center">
            <div className="text-sm text-brand-text">{error}</div>
            <GhostButton onClick={() => void load()} className="mt-3">
              Reintentar
            </GhostButton>
          </div>
        ) : !candidate ? (
          <div className="px-5 py-5 space-y-3">
            <Skeleton className="aspect-video w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            {notice ? (
              <div className="px-5 pt-4">
                <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
              </div>
            ) : null}
            {loading ? (
              <div className="px-5 pt-3 text-[11px] text-brand-muted" aria-live="polite">
                Actualizando desde la fuente…
              </div>
            ) : null}

            {/* ── Creatividades ── */}
            <DrawerSection title="Creatividades">
              <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-brand-border bg-brand-surface-2">
                <PreviewImage src={candidate.previewUrl} alt="" />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Pill>{candidate.format ? CREATIVE_FORMAT_LABEL[candidate.format] : `Formato ${UNAVAILABLE_LABEL.toLowerCase()}`}</Pill>
                {candidate.cta ? <Pill tone="accent">{candidate.cta}</Pill> : <Pill>CTA {UNAVAILABLE_LABEL.toLowerCase()}</Pill>}
              </div>
              <p className={`mt-3 text-sm leading-relaxed whitespace-pre-wrap ${candidate.adCopy ? "text-brand-text" : "text-brand-muted italic"}`}>
                {candidate.adCopy ?? `Copy ${UNAVAILABLE_LABEL.toLowerCase()}`}
              </p>
            </DrawerSection>

            {/* ── Historial temporal ── */}
            <DrawerSection title="Historial temporal">
              <FactRow label="Inicio del anuncio" value={formatDate(candidate.startedAt)} muted={!candidate.startedAt} />
              <FactRow label="Tiempo activo" value={formatDays(candidate.activeDays)} muted={candidate.activeDays === null} />
              <FactRow label="Variaciones" value={formatVariations(candidate.variations)} muted={candidate.variations === null} />
            </DrawerSection>

            {/* ── Anunciante & países ── */}
            <DrawerSection title="Anunciante y países">
              <FactRow label="Anunciante" value={candidate.advertiser ?? UNAVAILABLE_LABEL} muted={!candidate.advertiser} />
              <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span className="text-brand-muted shrink-0">Países</span>
                <CountryChips countries={candidate.countries} />
              </div>
            </DrawerSection>

            {/* ── Landing & precio ── */}
            <DrawerSection title="Landing y precio">
              <FactRow
                label="Landing"
                muted={!candidate.landingUrl}
                value={
                  candidate.landingUrl ? (
                    <a
                      href={candidate.landingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold/60 rounded"
                    >
                      {landingDomain(candidate.landingUrl) ?? candidate.landingUrl} ↗
                    </a>
                  ) : (
                    UNAVAILABLE_LABEL
                  )
                }
              />
              <FactRow label="Precio detectado" value={formatPrice(candidate.detectedPrice)} muted={!candidate.detectedPrice} />
            </DrawerSection>

            {/* ── Winner Score ── */}
            <DrawerSection
              title="Winner Score"
              right={score?.analyzedAt ? <span className="text-[11px] text-brand-muted">Analizado {formatDateTime(score.analyzedAt)}</span> : null}
            >
              {!score || label.pending ? (
                <div className="flex items-center gap-2 py-2 text-sm text-brand-muted">
                  <StatusDot status="muted" />
                  {SCORE_PENDING_LABEL}
                </div>
              ) : (
                <>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="font-display text-4xl font-semibold tabular-nums text-brand-text leading-none">{label.text}</div>
                      <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-brand-muted">
                        <StatusDot status={confidenceStatus(score.confidence)} />
                        {confidenceLabel(score.confidence)}
                      </div>
                    </div>
                    <div className="text-[11px] text-brand-muted text-right max-w-[55%]">
                      Sobre 100. Lo calcula el backend a partir de señales públicas; no mide ventas.
                    </div>
                  </div>
                  {score.reason ? <p className="mt-3 text-sm text-brand-text leading-relaxed">{score.reason}</p> : null}
                  {score.signals.length > 0 ? (
                    <ul className="mt-4 space-y-2.5">
                      {score.signals.map((s) => (
                        <li key={s.key}>
                          <div className="flex items-baseline justify-between gap-3 text-xs">
                            <span className="text-brand-text truncate">{s.label}</span>
                            <span className={`tabular-nums shrink-0 ${s.value === null ? "text-brand-muted" : "text-brand-text font-medium"}`}>
                              {signalValueLabel(s.value)}
                            </span>
                          </div>
                          <div className="mt-1">
                            <SignalBar value={s.value} />
                          </div>
                          <div className="mt-0.5 text-[11px] text-brand-muted truncate">
                            {s.missing ? "Señal no observada" : (s.observed ?? "Observación no disponible")}
                            {s.weight !== null ? ` · peso ${Math.round(s.weight * 100)} %` : ""}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-brand-muted">El backend no ha devuelto el desglose por señal.</p>
                  )}
                </>
              )}
            </DrawerSection>

            {/* ── Saturación & riesgos ── */}
            <DrawerSection title="Saturación y riesgos">
              <div className="flex flex-wrap gap-1.5">
                <SaturationPill level={candidate.saturation} />
                {candidate.risks.length === 0 ? (
                  <Pill>Sin riesgos registrados</Pill>
                ) : (
                  candidate.risks.map((r) => (
                    <Pill key={r} tone="warn">
                      {r}
                    </Pill>
                  ))
                )}
              </div>
            </DrawerSection>

            {/* ── Economía ── */}
            <DrawerSection title="Economía" right={<span className="text-[11px] text-brand-muted">Supuestos tuyos, no datos de la fuente</span>}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Coste estimado (€)">
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={eco.costEstimate} onChange={(e) => setEco({ ...eco, costEstimate: e.target.value })} className={INPUT_CLASS} placeholder="—" />
                </Field>
                <Field label="Precio venta est. (€)">
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={eco.salePriceEstimate} onChange={(e) => setEco({ ...eco, salePriceEstimate: e.target.value })} className={INPUT_CLASS} placeholder="—" />
                </Field>
                <Field label="Transporte (€)">
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={eco.shippingCost} onChange={(e) => setEco({ ...eco, shippingCost: e.target.value })} className={INPUT_CLASS} placeholder="—" />
                </Field>
                <Field label="Coste devolución (€)">
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={eco.returnCost} onChange={(e) => setEco({ ...eco, returnCost: e.target.value })} className={INPUT_CLASS} placeholder="—" />
                </Field>
                <Field label="Tasa de entrega supuesta" hint="0–1. Default 0,7 (70 % de entregas).">
                  <input type="number" inputMode="decimal" min={0.05} max={1} step="0.05" value={deliveryRate} onChange={(e) => setDeliveryRate(e.target.value)} className={INPUT_CLASS} />
                </Field>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-brand-border bg-brand-border/50">
                <div className="bg-brand-surface px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wider text-brand-muted">Margen bruto</div>
                  <div className={`mt-1 font-display text-xl font-semibold tabular-nums ${margin.grossMargin === null ? "text-brand-muted" : margin.grossMargin >= 0 ? "text-brand-text" : "text-red-600"}`}>
                    {margin.grossMargin === null ? UNAVAILABLE_LABEL : formatEuro(margin.grossMargin)}
                  </div>
                </div>
                <div className="bg-brand-surface px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wider text-brand-muted">Beneficio / pedido</div>
                  <div className={`mt-1 font-display text-xl font-semibold tabular-nums ${margin.profitPerOrder === null ? "text-brand-muted" : margin.profitPerOrder >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {margin.profitPerOrder === null ? UNAVAILABLE_LABEL : formatEuro(margin.profitPerOrder)}
                  </div>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-brand-muted leading-snug">{margin.note}</p>
              <div className="mt-3 flex justify-end">
                <PrimaryButton onClick={() => void saveEconomics()} busy={busy === "economics"} disabled={unsaved}>
                  Guardar economía
                </PrimaryButton>
              </div>
            </DrawerSection>

            {/* ── Estado del pipeline ── */}
            <DrawerSection title="Estado del pipeline">
              {unsaved ? (
                <p className="text-sm text-brand-muted">Todavía no está en tu pipeline. Guárdalo (botón de abajo) y podrás moverlo por etapas.</p>
              ) : (
                <div className="space-y-3">
                  <FactRow label="Etapa actual" value={PRODUCT_RESEARCH_STATUS_LABEL[candidate.status]} />
                  <div className="flex flex-col sm:flex-row gap-2">
                    <select value={moveTo} onChange={(e) => setMoveTo(e.target.value as ProductResearchStatus)} aria-label="Mover a" className={SELECT_CLASS}>
                      {PIPELINE_TARGETS.map((s) => (
                        <option key={s} value={s} disabled={s === candidate.status}>
                          {PRODUCT_RESEARCH_STATUS_LABEL[s]}
                          {s === candidate.status ? " (actual)" : ""}
                        </option>
                      ))}
                    </select>
                    <PrimaryButton
                      onClick={() => (moveTo === "discarded" ? setConfirmDiscard(true) : void move())}
                      busy={busy === "move"}
                      disabled={moveTo === candidate.status}
                      className="sm:shrink-0"
                    >
                      Mover
                    </PrimaryButton>
                  </div>
                  <input
                    type="text"
                    value={moveNote}
                    onChange={(e) => setMoveNote(e.target.value)}
                    placeholder="Motivo (opcional): queda en el historial"
                    aria-label="Motivo del cambio de etapa"
                    className={INPUT_CLASS}
                  />
                </div>
              )}
            </DrawerSection>

            {/* ── Notas ── */}
            <DrawerSection title="Notas" right={<span className="text-[11px] text-brand-muted">{candidate.notes.length}</span>}>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder={unsaved ? "Guarda el producto para anotar." : "Qué has visto, qué falta por comprobar…"}
                aria-label="Nueva nota"
                disabled={unsaved}
                className={TEXTAREA_CLASS}
              />
              <div className="mt-2 flex justify-end">
                <GhostButton onClick={() => void addNote()} disabled={unsaved || !noteText.trim() || busy === "note"}>
                  Añadir nota
                </GhostButton>
              </div>
              {candidate.notes.length > 0 ? (
                <ul className="mt-3 divide-y divide-brand-border/60">
                  {[...candidate.notes].reverse().map((n, i) => (
                    <li key={`${n.at}-${i}`} className="py-2.5">
                      <div className="text-sm text-brand-text whitespace-pre-wrap leading-relaxed">{n.text}</div>
                      <div className="mt-0.5 text-[11px] text-brand-muted">{formatDateTime(n.at)}</div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </DrawerSection>

            {/* ── Historial de decisiones ── */}
            <DrawerSection title="Historial de decisiones">
              {candidate.decisions.length === 0 ? (
                <p className="text-sm text-brand-muted">Sin decisiones todavía.</p>
              ) : (
                <ol className="relative ml-1.5 border-l border-brand-border pl-4 space-y-3">
                  {[...candidate.decisions].reverse().map((d, i) => (
                    <li key={`${d.at}-${i}`} className="relative">
                      <span className="absolute -left-5.25 top-1.5 h-2 w-2 rounded-full bg-brand-gold" aria-hidden />
                      <div className="text-sm text-brand-text">
                        {d.from ? (
                          <>
                            <span className="text-brand-muted">{PRODUCT_RESEARCH_STATUS_LABEL[d.from]}</span> → {PRODUCT_RESEARCH_STATUS_LABEL[d.to]}
                          </>
                        ) : (
                          PRODUCT_RESEARCH_STATUS_LABEL[d.to]
                        )}
                      </div>
                      <div className="text-[11px] text-brand-muted">
                        {formatDateTime(d.at)}
                        {d.note ? ` · ${d.note}` : ""}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </DrawerSection>
          </>
        )}
      </Drawer>

      <ModalShell open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="¿Descartar este producto?">
        <p className="text-sm text-brand-muted">
          Pasará a la columna Descartado. No se borra nada: podrás volver a moverlo más adelante.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <GhostButton onClick={() => setConfirmDiscard(false)}>Cancelar</GhostButton>
          <PrimaryButton danger onClick={() => void move()} busy={busy === "move"}>
            Descartar
          </PrimaryButton>
        </div>
      </ModalShell>
    </>
  );
}
