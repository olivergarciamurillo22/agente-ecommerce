// ============================================================
// NIVEL 2 · RADIOGRAFÍA DE LA CUENTA ANUNCIANTE (09-09-2026)
// docs/HUNTER-DEEP-DIVE.md
//
// En cuanto un candidato tiene match, en vez de buscar por palabra se pide
// a /ads_archive TODO lo de esa página con search_page_ids=<page_id>,
// activos e inactivos (ad_active_status=ALL), con fechas de inicio y fin.
// De ahí sale lo que no se ve mirando un solo anuncio:
//   · desde cuándo anuncia la tienda de verdad (el anuncio más antiguo de
//     toda la cuenta, no del producto que casó);
//   · volumen real: cuántos anuncios en total y cuántos activos ahora;
//   · qué ÁNGULOS repite y cuáles lleva más tiempo sin apagar: se clasifica
//     cada anuncio con las mismas reglas de texto del auditor (ANGLE_RULES)
//     y, por ángulo, el activo más antiguo; si no funcionaran, los habrían
//     apagado;
//   · a quién le habla la cuenta en conjunto: patrón de AVATAR por
//     heurística de texto (etiqueta + cita), y, si hay OPENROUTER_API_KEY,
//     una consolidación en texto por Claude (marcada como tal).
//
// Coste: 1 petición por cada 100 anuncios de la cuenta, con tope de páginas
// (ACCOUNT_MAX_PAGES) y presupuesto del discovery. search_page_ids es el
// mismo endpoint y el mismo límite de 100 por página que la búsqueda por
// palabra; la sonda del NAS lo confirma en vivo (paso 5).
// ============================================================

import type { AdLibraryAd } from "../discovery/types";
import type { AdLibraryClient } from "../discovery/client";
import { DiscoveryBudget, type StopReason } from "../discovery/budget";
import { ANGLE_RULES, normalizeAngleText, sentences, type AngleId } from "../audit/angles";

export const ACCOUNT_MAX_PAGES = 5;
/** Ventana de fechas amplia: la Ad Library exige min/max; 2018 cubre toda cuenta comercial en España. */
export const ACCOUNT_SINCE = "2018-01-01";
const DAY = 86_400;

export interface AccountAngle {
  id: AngleId;
  label: string;
  ads: number;
  activeAds: number;
  /** Inicio del anuncio ACTIVO más antiguo con este ángulo. */
  oldestActiveStart: string | null;
  longestActiveDays: number | null;
  /** Cita literal del anuncio activo más antiguo (evidencia). */
  evidence: { adId: string; quote: string } | null;
}

export interface AvatarSignal {
  label: string;
  ads: number;
  evidence: { adId: string; quote: string };
}

export interface AccountXray {
  pageId: string;
  pageName: string | null;
  totalAds: number;
  activeAds: number;
  inactiveAds: number;
  /** Anuncio más antiguo de TODA la cuenta (activo o no). */
  firstAdStart: string | null;
  daysAdvertising: number | null;
  /** Anuncio ACTIVO más antiguo de la cuenta. */
  oldestActiveStart: string | null;
  /** Ángulos, los de activos más antiguos primero: los «ganadores» de esa tienda. */
  angles: AccountAngle[];
  avatar: { signals: AvatarSignal[]; summary: string | null; summarySource: "heuristica" | "claude" | null };
  requests: number;
  pages: number;
  truncated: boolean;
  stopReason: StopReason;
  nature: "heuristica_sobre_texto_real";
}

/** Reglas de AVATAR: a quién le habla el texto. Heurística con cita, no diagnóstico. */
export const AVATAR_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "personas mayores / seniors", patterns: [/\b(mayores|senior|abuel[oa]s?|tercera edad|jubilad[oa]s?|a partir de los 6\d)\b/] },
  { label: "madres, embarazo y bebés", patterns: [/\b(mam[aá]s?|embaraz\w+|postparto|beb[eé]s?|reci[eé]n nacid[oa])\b/] },
  { label: "familias con niños", patterns: [/\b(ni[nñ][oa]s|peques|hij[oa]s|colegio|infantil)\b/] },
  { label: "mujeres", patterns: [/\b(mujer(es)?|ella|femenin[oa]|chicas)\b/] },
  { label: "hombres", patterns: [/\b(hombres?|masculin[oa]|barba|afeitad[oa]|chicos)\b/] },
  { label: "dolor articular, espalda o cuello", patterns: [/\b(dolor(es)? de (espalda|cuello|rodilla|cervical|lumbar|coxis|cadera)|lumbares|cervicales|ci[aá]tica|artrosis|articulaci)/] },
  { label: "trabajo sentado / oficina / teletrabajo", patterns: [/\b(oficina|teletrabajo|escritorio|sentad[oa]s?|silla de oficina|jornada)\b/] },
  { label: "dueños de mascotas", patterns: [/\b(mascotas?|perr[oa]s?|gat[oa]s?|peludo)\b/] },
  { label: "hogar y cocina", patterns: [/\b(cocina|hogar|casa|limpieza|ba[nñ]o|sal[oó]n)\b/] },
  { label: "deporte y forma física", patterns: [/\b(gym|gimnasio|deport\w+|entren\w+|fitness|running|yoga)\b/] },
  { label: "conductores", patterns: [/\b(coche|conducir|conductor(es)?|volante|carretera)\b/] },
  { label: "salud y bienestar general", patterns: [/\b(salud|bienestar|descanso|dormir|sue[nñ]o|estr[eé]s|ansiedad)\b/] },
];

const adText = (ad: AdLibraryAd) => [...ad.bodies, ...ad.titles, ...(ad.descriptions ?? [])].join("\n");
const isActive = (ad: AdLibraryAd) => !ad.stopTime;
const startSec = (ad: AdLibraryAd) => { const t = ad.startTime ? Date.parse(ad.startTime) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };

/** Clasifica un anuncio en sus ángulos (ids) y devuelve la primera frase que casó por ángulo. */
export function anglesOfAd(ad: AdLibraryAd): Map<AngleId, string> {
  const out = new Map<AngleId, string>();
  for (const frase of sentences(adText(ad))) {
    const plano = normalizeAngleText(frase);
    for (const rule of ANGLE_RULES) if (!out.has(rule.id) && rule.patterns.some((re) => re.test(plano))) out.set(rule.id, frase.trim().slice(0, 180));
  }
  return out;
}

export function avatarSignals(ads: AdLibraryAd[]): AvatarSignal[] {
  const porLabel = new Map<string, AvatarSignal>();
  for (const ad of ads) {
    const vistos = new Set<string>();
    for (const frase of sentences(adText(ad))) {
      const plano = normalizeAngleText(frase);
      for (const rule of AVATAR_RULES) {
        if (vistos.has(rule.label) || !rule.patterns.some((re) => re.test(plano))) continue;
        vistos.add(rule.label);
        const prev = porLabel.get(rule.label);
        if (prev) prev.ads += 1; else porLabel.set(rule.label, { label: rule.label, ads: 1, evidence: { adId: ad.id, quote: frase.trim().slice(0, 180) } });
      }
    }
  }
  return [...porLabel.values()].sort((a, b) => b.ads - a.ads);
}

/** Radiografía a partir de los anuncios ya bajados (sin red): separable para tests. */
export function xrayFromAds(pageId: string, ads: AdLibraryAd[], now: number, meta: { requests: number; pages: number; truncated: boolean; stopReason: StopReason }): AccountXray {
  const vistos = new Set<string>();
  const unicos = ads.filter((a) => (vistos.has(a.id) ? false : (vistos.add(a.id), true))); // el primero manda (paginación: el mismo id no vuelve a contar)
  const activos = unicos.filter(isActive);
  const inicios = unicos.map(startSec).filter((n): n is number => n !== null);
  const iniciosActivos = activos.map(startSec).filter((n): n is number => n !== null);
  const first = inicios.length ? Math.min(...inicios) : null;
  const oldestActive = iniciosActivos.length ? Math.min(...iniciosActivos) : null;
  const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString().slice(0, 10));

  const porAngulo = new Map<AngleId, AccountAngle & { _oldest: number | null }>();
  for (const ad of unicos) {
    const start = startSec(ad);
    for (const [id, frase] of anglesOfAd(ad)) {
      const rule = ANGLE_RULES.find((r) => r.id === id)!;
      const a = porAngulo.get(id) ?? { id, label: rule.label, ads: 0, activeAds: 0, oldestActiveStart: null, longestActiveDays: null, evidence: null, _oldest: null };
      a.ads += 1;
      if (isActive(ad)) {
        a.activeAds += 1;
        if (start !== null && (a._oldest === null || start < a._oldest)) { a._oldest = start; a.oldestActiveStart = iso(start); a.longestActiveDays = Math.max(0, Math.floor((now - start) / DAY)); a.evidence = { adId: ad.id, quote: frase }; }
      }
      if (!a.evidence) a.evidence = { adId: ad.id, quote: frase };
      porAngulo.set(id, a);
    }
  }
  const angles = [...porAngulo.values()]
    .sort((x, y) => (y.longestActiveDays ?? -1) - (x.longestActiveDays ?? -1) || y.activeAds - x.activeAds || y.ads - x.ads)
    .map(({ _oldest, ...rest }) => rest);

  return {
    pageId, pageName: unicos.find((a) => a.pageName)?.pageName ?? null,
    totalAds: unicos.length, activeAds: activos.length, inactiveAds: unicos.length - activos.length,
    firstAdStart: iso(first), daysAdvertising: first === null ? null : Math.max(0, Math.floor((now - first) / DAY)),
    oldestActiveStart: iso(oldestActive),
    angles,
    avatar: { signals: avatarSignals(unicos).slice(0, 5), summary: null, summarySource: null },
    requests: meta.requests, pages: meta.pages, truncated: meta.truncated, stopReason: meta.stopReason,
    nature: "heuristica_sobre_texto_real",
  };
}

export interface AccountXrayInput {
  client: AdLibraryClient;
  pageId: string;
  country: string;
  now: number;
  budget?: DiscoveryBudget;
  maxPages?: number;
  /** Consolidación del avatar en texto (Claude por OpenRouter). Opcional; si falla, queda la heurística. */
  summarize?: ((bodies: string[], signals: AvatarSignal[]) => Promise<string | null>) | null;
}

export async function readAccountXray(input: AccountXrayInput): Promise<AccountXray> {
  const budget = input.budget ?? new DiscoveryBudget({ deadlineAt: Date.now() + 2 * 60_000, maxRequests: (input.maxPages ?? ACCOUNT_MAX_PAGES) + 1 });
  const until = new Date(input.now * 1000).toISOString().slice(0, 10);
  const antes = budget.requests;
  const r = await input.client.search({ term: "", pageIds: [input.pageId], country: input.country, since: ACCOUNT_SINCE, until, activeStatus: "ALL", budget, maxPages: input.maxPages ?? ACCOUNT_MAX_PAGES });
  const xray = xrayFromAds(input.pageId, r.ads, input.now, { requests: budget.requests - antes, pages: r.pages, truncated: r.pages >= (input.maxPages ?? ACCOUNT_MAX_PAGES) && r.stopReason === "completado", stopReason: r.stopReason });
  if (input.summarize && r.ads.length) {
    try {
      const bodies = [...new Set(r.ads.flatMap((a) => a.bodies).map((b) => b.trim()).filter(Boolean))].slice(0, 40);
      const s = await input.summarize(bodies, xray.avatar.signals);
      if (s) { xray.avatar.summary = s.slice(0, 600); xray.avatar.summarySource = "claude"; }
    } catch { /* la consolidación es opcional: queda la heurística */ }
  }
  if (!xray.avatar.summary && xray.avatar.signals.length) {
    xray.avatar.summary = xray.avatar.signals.slice(0, 3).map((s) => `${s.label} (${s.ads} anuncio${s.ads === 1 ? "" : "s"})`).join(" · ");
    xray.avatar.summarySource = "heuristica";
  }
  return xray;
}
