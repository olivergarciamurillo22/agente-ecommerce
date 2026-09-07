import crypto from "node:crypto";
import type { AdLibraryAd, DiscoveryGroup } from "./types";

// ============================================================
// AGRUPACIÓN POR COMPETIDOR — docs/HUNTER-DISCOVERY-AUDITORIA.md
//
// Tres arreglos del 07-09, todos con su bug demostrado:
//  1. RENDIMIENTO: los tokens de cada anuncio se calculaban DENTRO del bucle
//     de comparación, y se comparaba contra todos los grupos de todos los
//     anunciantes. Medido: 3.000 anuncios de un mismo anunciante bloqueaban
//     el proceso ~65 s. Ahora se tokeniza una vez por anuncio y solo se
//     compara dentro del mismo page_id.
//  2. HUELLA ESTABLE: la huella hasheaba solo los 30 primeros tokens en orden
//     alfabético del PRIMER anuncio del grupo. Dos grupos del mismo anunciante
//     con esos 30 tokens en común compartían candidate_key, y el segundo
//     INSERT violaba UNIQUE(query_id, candidate_id): rollback de la corrida
//     ENTERA. Ahora la huella cubre TODO el vocabulario del grupo y las claves
//     se desduplican antes de salir.
//  3. RUIDO: el filtro vetaba por palabra suelta, y "seguro" y "servicio" son
//     vocabulario COD normal. Comprobado contra la función real: "Pago seguro
//     contra reembolso" y "Envío seguro y rápido" se marcaban como basura, es
//     decir, se tiraba justo lo que se busca.
// ============================================================

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const adText = (ad: AdLibraryAd) => [...ad.captions, ...ad.bodies, ...ad.titles].join(" ");
const tokens = (ad: AdLibraryAd) => new Set(normalize(adText(ad)).split(" ").filter((x) => x.length > 2));

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((x) => b.has(x)).length;
  return common / new Set([...a, ...b]).size;
}

const active = (ad: AdLibraryAd, now: number) => !ad.stopTime || Date.parse(ad.stopTime) / 1000 >= now - 86400;

/**
 * Qué NO es un producto físico de dropshipping. Frases, no palabras sueltas:
 * "seguro" a secas es COD ("pago seguro contra reembolso"), pero "seguro de
 * coche" es un producto financiero. Cada patrón lleva su motivo.
 */
const NON_PRODUCT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(curso|cursos|masterclass|webinar|formacion|academia|clases online|ebook|infoproducto)\b/, reason: "formación o infoproducto" },
  { re: /\b(software|saas|aplicacion movil|descarga la app|suscripcion mensual|suscripcion anual|prueba gratuita)\b/, reason: "software o suscripción" },
  { re: /\b(hipoteca|prestamo|credito rapido|seguro de (vida|coche|hogar|salud|decesos)|poliza|plan de pensiones|inversion)\b/, reason: "producto financiero o seguro" },
  { re: /\b(consultoria|asesoria|agencia de|abogado|abogados|clinica dental|tratamiento presencial|cita previa)\b/, reason: "servicio profesional presencial" },
  { re: /\b(empleo|ofertas de trabajo|buscamos personal|unete al equipo|contratamos)\b/, reason: "oferta de empleo" },
];

/** Marcas grandes: no son competencia replicable para un COD pequeño. */
const BIG_BRANDS = new Set([
  "amazon", "ikea", "lidl", "aldi", "carrefour", "decathlon", "mediamarkt", "el corte ingles",
  "temu", "aliexpress", "shein", "leroy merlin", "worten", "pccomponentes", "primor", "action",
]);

const AUDIENCE_BIG = 1_000_000;

export interface NoiseVerdict {
  noise: boolean;
  noiseReason: string | null;
}

export function noiseOf(ads: AdLibraryAd[]): NoiseVerdict {
  const text = ads.flatMap((ad) => [...ad.captions, ...ad.bodies, ...ad.titles]).join(" ");
  if (!text.trim()) return { noise: true, noiseReason: "sin texto comercial para identificar un producto fisico" };
  const plano = normalize(text);
  for (const { re, reason } of NON_PRODUCT_PATTERNS) {
    if (re.test(plano)) return { noise: true, noiseReason: `heuristica: anuncio de servicio, app o contenido (${reason})` };
  }
  // El anunciante se mira ENTERO (por contención, no por igualdad): "Amazon
  // España" es Amazon. Antes solo se miraba la audiencia estimada.
  const anunciantes = ads.map((ad) => normalize(ad.pageName ?? "")).filter(Boolean);
  for (const marca of BIG_BRANDS) {
    if (anunciantes.some((nombre) => nombre === marca || nombre.startsWith(`${marca} `) || nombre.includes(` ${marca} `))) {
      return { noise: true, noiseReason: `heuristica: marca establecida (${marca})` };
    }
  }
  // Si Meta no devuelve estimated_audience_size, este filtro NO puede opinar:
  // antes el máximo daba 0 y todas las marcas grandes pasaban en silencio.
  const conAudiencia = ads.map((ad) => ad.audience?.upperBound).filter((v): v is number => typeof v === "number");
  if (conAudiencia.length > 0 && Math.max(...conAudiencia) >= AUDIENCE_BIG) {
    return { noise: true, noiseReason: "heuristica: audiencia estimada >= 1.000.000 (marca establecida posible)" };
  }
  return { noise: false, noiseReason: null };
}

/** Umbral de parecido entre creativos del mismo anunciante para considerarlos el mismo producto. */
export const SIMILARITY_THRESHOLD = 0.55;

/**
 * Agrupa por anunciante y producto. `country` entra en la clave porque una
 * misma página anunciando en dos países son dos corridas distintas y, sin él,
 * la segunda pisaba el histórico de momentum de la primera.
 */
export function groupAds(ads: AdLibraryAd[], now = Math.floor(Date.now() / 1000), country = "ES"): DiscoveryGroup[] {
  // Un índice por anunciante evita comparar contra grupos de otras páginas
  // (que nunca casarían) y convierte el coste en cuadrático POR ANUNCIANTE.
  const porPagina = new Map<string, Array<{ pageId: string; pageName: string | null; seed: Set<string>; vocabulario: Set<string>; ads: AdLibraryAd[] }>>();
  const orden: Array<{ pageId: string; pageName: string | null; seed: Set<string>; vocabulario: Set<string>; ads: AdLibraryAd[] }> = [];

  for (const ad of ads) {
    const suyos = porPagina.get(ad.pageId) ?? [];
    const propios = tokens(ad); // se calcula UNA vez por anuncio
    const candidate = suyos.find((g) => similarity(g.seed, propios) >= SIMILARITY_THRESHOLD);
    if (candidate) {
      candidate.ads.push(ad);
      for (const t of propios) candidate.vocabulario.add(t);
      continue;
    }
    const grupo = { pageId: ad.pageId, pageName: ad.pageName, seed: propios, vocabulario: new Set(propios), ads: [ad] };
    suyos.push(grupo);
    porPagina.set(ad.pageId, suyos);
    orden.push(grupo);
  }

  const vistos = new Set<string>();
  const salida: DiscoveryGroup[] = [];
  for (const group of orden) {
    // La huella cubre TODO el vocabulario del grupo, no los 30 primeros
    // tokens del primer anuncio: dos productos distintos del mismo anunciante
    // ya no pueden compartir clave y tumbar la corrida.
    const fingerprintText = [...group.vocabulario].sort().join(" ");
    const fingerprint = crypto.createHash("sha256").update(fingerprintText || group.ads[0].id).digest("hex").slice(0, 16);
    const current = group.ads.filter((ad) => active(ad, now));
    const starts = current.map((ad) => (ad.startTime ? Date.parse(ad.startTime) / 1000 : NaN)).filter(Number.isFinite);
    let key = `${country}:${group.pageId}:${fingerprint}`;
    if (vistos.has(key)) {
      // Cinturón: si aun así coincidiera, se desambigua con el id del primer
      // anuncio en vez de dejar que SQLite tire la corrida entera.
      key = `${key}:${group.ads[0].id}`;
    }
    vistos.add(key);
    salida.push({
      key,
      pageId: group.pageId,
      pageName: group.pageName,
      fingerprint,
      ads: group.ads,
      activeAds: current.length,
      oldestActiveAt: starts.length ? Math.min(...starts) : null,
      ...noiseOf(group.ads),
    });
  }
  return salida;
}
