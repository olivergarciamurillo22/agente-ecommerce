"use client";

// ============================================================
// INFORME DE AUDITORÍA DE UNA TIENDA (07-09-2026) — docs/HUNTER-AUDITOR.md
//
// Pinta el resultado del modo A (una tienda) y cada candidata del modo B.
// Reglas de lo que se enseña:
//  · los ángulos llevan SIEMPRE la frase literal del anuncio como evidencia;
//    la etiqueta del ángulo va marcada como heurística;
//  · lo que no se pudo completar se lista con su motivo, arriba, no escondido;
//  · nada de gasto, ventas ni rendimiento: la propia ficha dice que no existen.
// ============================================================

interface AngleEvidence { quote: string; adId: string; field: string }
interface AngleFinding { id: string; label: string; ads: number; evidence: AngleEvidence[] }
interface AngleReport { angles: AngleFinding[]; unclassified: Array<{ adId: string; sample: string }>; adsAnalyzed: number; adsWithoutText: number }

export interface StoreAuditReportView {
  storeUrl: string;
  domain: string;
  brandName: string | null;
  profile: { origin: string; isShopify: boolean; shopifyHints: string[]; homepageStatus: string; homepageReason: string | null; facebookUrls: string[] };
  catalog: { status: string; reason: string | null; products: number; truncated: boolean; priceMin: number | null; priceMax: number | null; topTypes: Array<{ type: string; count: number }>; topVendors: Array<{ vendor: string; count: number }>; sample: Array<{ title: string; price: number | null; url: string }> };
  facebook: { urls: string[]; source: string | null; slugs: string[]; note: string };
  adLibrary: { status: string; reason: string | null; searchTerms: string[]; matchedBy: string[]; competitors: Array<{ pageName: string | null; pageId: string; activeAds: number; snapshotUrls: string[]; signals: Array<{ id: string; label: string; value: string | number | null; confirmado: boolean; source: string; limite: string | null }> }>; activeAds: number; stopReason: string | null };
  angles: AngleReport | null;
  incomplete: Array<{ part: string; reason: string }>;
  notAvailable: readonly string[];
}

const eur = (n: number | null) => (n === null ? "—" : `${n.toFixed(2).replace(".", ",")} €`);

export default function StoreAuditView({ r, compact = false }: { r: StoreAuditReportView; compact?: boolean }) {
  return (
    <div className="space-y-3 text-[13px]">
      {r.incomplete.length > 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">No se pudo completar</div>
          <ul className="mt-1 space-y-0.5 text-brand-muted">
            {r.incomplete.map((i) => (
              <li key={i.part}>
                <span className="text-brand-text">{i.part}:</span> {i.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-tertiary">Qué vende</div>
        {r.catalog.status === "ok" ? (
          <>
            <p className="mt-0.5 text-brand-text">
              {r.catalog.products}
              {r.catalog.truncated ? "+" : ""} productos · precios de {eur(r.catalog.priceMin)} a {eur(r.catalog.priceMax)}
              {r.profile.isShopify ? " · Shopify" : ""}
            </p>
            {r.catalog.topTypes.length ? <p className="text-brand-muted">Tipos: {r.catalog.topTypes.map((t) => `${t.type} (${t.count})`).join(", ")}</p> : null}
            {r.catalog.topVendors.length ? <p className="text-brand-muted">Proveedores declarados: {r.catalog.topVendors.map((v) => `${v.vendor} (${v.count})`).join(", ")}</p> : null}
            {!compact ? (
              <ul className="mt-1 space-y-0.5">
                {r.catalog.sample.map((p) => (
                  <li key={p.url}>
                    <a href={p.url} target="_blank" rel="noreferrer" className="text-brand-accent underline">
                      {p.title}
                    </a>{" "}
                    <span className="text-brand-tertiary">{eur(p.price)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="mt-0.5 text-brand-muted">
            Catálogo no accesible: {r.catalog.reason ?? r.catalog.status}. Solo se lee el catálogo público de Shopify; no se inventa nada.
          </p>
        )}
      </div>

      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-tertiary">Anuncios activos en la Ad Library</div>
        {r.adLibrary.status === "ok" ? (
          <p className="mt-0.5 text-brand-text">
            {r.adLibrary.activeAds} activo(s) · atribuidos a la tienda por {r.adLibrary.matchedBy.map((m) => m.replace(/_/g, " ")).join(" y ")}
            {r.adLibrary.searchTerms.length ? <span className="text-brand-tertiary"> · buscado como «{r.adLibrary.searchTerms.join("», «")}»</span> : null}
          </p>
        ) : (
          <p className="mt-0.5 text-brand-muted">{r.adLibrary.reason ?? r.adLibrary.status}</p>
        )}
        {r.adLibrary.competitors.slice(0, compact ? 1 : 3).map((c) => (
          <div key={c.pageId} className="mt-1 text-brand-muted">
            {c.pageName ?? c.pageId}: {c.signals.filter((s) => s.value !== null && s.id !== "momentum" && s.id !== "paises_vistos").map((s) => `${s.label.toLowerCase()} ${s.value}`).join(" · ")}
            {c.snapshotUrls[0] ? (
              <>
                {" "}
                <a href={c.snapshotUrls[0]} target="_blank" rel="noreferrer" className="text-brand-accent underline">
                  ficha →
                </a>
              </>
            ) : null}
          </div>
        ))}
        <p className="mt-1 text-[11px] text-brand-tertiary">Facebook: {r.facebook.urls[0] ?? "sin enlace"} · {r.facebook.note}</p>
      </div>

      {r.angles && r.angles.angles.length ? (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-tertiary">
            Ángulos que usa <span className="normal-case font-normal">(etiqueta heurística; la cita es el dato)</span>
          </div>
          <ul className="mt-1 space-y-1.5">
            {r.angles.angles.slice(0, compact ? 4 : 9).map((a) => (
              <li key={a.id}>
                <span className="font-medium text-brand-text">{a.label}</span>{" "}
                <span className="text-brand-tertiary">· en {a.ads} anuncio(s)</span>
                <ul className="ml-3 mt-0.5 space-y-0.5 text-brand-muted">
                  {a.evidence.slice(0, compact ? 1 : 3).map((e, i) => (
                    <li key={i}>
                      «{e.quote}» <span className="text-[11px] text-brand-tertiary">[{e.field}]</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {r.angles.unclassified.length && !compact ? (
            <p className="mt-1 text-[11px] text-brand-tertiary">
              {r.angles.unclassified.length} anuncio(s) sin ángulo reconocido, p. ej. «{r.angles.unclassified[0].sample}»
            </p>
          ) : null}
        </div>
      ) : r.adLibrary.status === "ok" ? (
        <p className="text-brand-tertiary">Ningún ángulo reconocido en el texto de sus anuncios.</p>
      ) : null}

      {!compact ? (
        <p className="text-[11px] leading-relaxed text-brand-tertiary">
          <strong className="text-brand-muted">No disponible, y por eso no se enseña:</strong> {r.notAvailable.join(" · ")}.
        </p>
      ) : null}
    </div>
  );
}
