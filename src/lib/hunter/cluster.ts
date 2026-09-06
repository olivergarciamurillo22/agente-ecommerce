// ============================================================
// AI Winner Radar — AGRUPAR ANUNCIOS EN PRODUCTOS.
//
// El problema: veinte marcas venden el MISMO producto con veinte nombres
// distintos ("Pet Hair Remover Pro", "Cepillo quitapelos", "Rodillo quita
// pelos mascotas"). Si no se agrupan, el radar enseña veinte oportunidades
// mediocres en vez de una buena; y si se agrupa de más, mezcla productos
// distintos y todas las señales quedan sin sentido.
//
// De los dos errores, EL PEOR ES AGRUPAR DE MÁS: un cluster inflado parece
// una oportunidad enorme y no lo es. Por eso los umbrales son conservadores
// y una coincidencia de categoría NUNCA basta ("los dos son de mascotas" no
// los hace el mismo producto).
//
// Cuatro pasadas, de la más fiable a la más difusa:
//   1. LANDING   mismo dominio + mismo anunciante → prácticamente seguro
//   2. NOMBRE    nombre normalizado idéntico
//   3. TOKENS    solape alto de palabras significativas (Jaccard)
//   4. IMAGEN    hueco preparado; sin descarga de medios no se ejecuta
//
// Cada unión guarda con qué pasada y con qué similitud se hizo, para poder
// auditar por qué dos anuncios acabaron juntos.
// ============================================================

import { extractDomain, normalizeText } from "./normalize";
import type { HunterAd } from "./types";

export type ClusterPass = "landing" | "name" | "tokens" | "image" | "manual";

export interface AdCluster {
  id: string;
  adIds: string[];
  canonicalName: string;
  /** 0..1 — cuánto nos fiamos de que esto sea UN producto. */
  confidence: number;
  passes: ClusterPass[];
  /** Por qué se unió cada anuncio, para poder revisarlo. */
  links: Array<{ adId: string; pass: ClusterPass; similarity: number }>;
}

/** Palabras vacías del sector: aparecen en todo y no distinguen nada. */
const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "para", "con", "sin", "en", "y", "a", "por",
  "the", "for", "with", "and", "of", "to", "pro", "plus", "premium", "new",
  "nuevo", "nueva", "oferta", "envio", "gratis", "original", "kit", "set",
  "profesional", "professional", "deluxe", "es", "un", "una", "mejor",
]);

export const TOKEN_SIMILARITY_THRESHOLD = 0.6;
/**
 * Umbral para cuando NO hay nombre y hay que conformarse con el copy. Más
 * alto a propósito: el texto publicitario comparte fórmula entre productos
 * distintos, así que un parecido del 60 % ahí no significa lo mismo.
 */
export const COPY_SIMILARITY_THRESHOLD = 0.8;

export function significantTokens(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  );
}

/** Jaccard: intersección sobre unión. 1 = idénticos, 0 = nada en común. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface Nodo {
  ad: HunterAd;
  /** Tokens del NOMBRE del producto. Es lo que identifica un producto. */
  nameTokens: Set<string>;
  /** Tokens del texto del anuncio. Mucho más ruidoso: casi todo es fórmula. */
  copyTokens: Set<string>;
  dominio: string;
}

/**
 * Similitud entre dos anuncios, o `null` si no llegan a parecerse lo
 * suficiente para unirlos. Devolver `null` en vez de un número bajo obliga a
 * que la decisión viva AQUÍ y no repartida por el bucle.
 */
function tokenSimilarity(a: Nodo, b: Nodo): number | null {
  const conNombreA = a.nameTokens.size >= 2;
  const conNombreB = b.nameTokens.size >= 2;

  // Caso normal: los dos traen nombre. Se comparan los nombres y nada más.
  if (conNombreA && conNombreB) {
    if (sharedCount(a.nameTokens, b.nameTokens) < 2) return null;
    const sim = jaccard(a.nameTokens, b.nameTokens);
    return sim >= TOKEN_SIMILARITY_THRESHOLD ? sim : null;
  }

  // Uno tiene nombre y el otro no (pasa en Meta: muchos anuncios no traen
  // título de enlace). Se exige que el copy del anónimo CONTENGA el nombre
  // entero del otro: menos que eso es adivinar.
  if (conNombreA !== conNombreB) {
    const nombre = conNombreA ? a.nameTokens : b.nameTokens;
    const copy = conNombreA ? b.copyTokens : a.copyTokens;
    if (nombre.size < 2 || copy.size === 0) return null;
    const dentro = sharedCount(nombre, copy);
    return dentro === nombre.size ? 0.7 : null;
  }

  // Ninguno tiene nombre: solo queda el copy, con el listón más alto.
  if (a.copyTokens.size < 3 || b.copyTokens.size < 3) return null;
  if (sharedCount(a.copyTokens, b.copyTokens) < 3) return null;
  const sim = jaccard(a.copyTokens, b.copyTokens);
  return sim >= COPY_SIMILARITY_THRESHOLD ? sim : null;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** Union-Find: agrupa sin decidir de antemano cuántos grupos hay. */
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function clusterAds(ads: HunterAd[]): AdCluster[] {
  if (ads.length === 0) return [];

  const nodos: Nodo[] = ads.map((ad) => ({
    ad,
    nameTokens: significantTokens(ad.productNameRaw ?? ""),
    copyTokens: significantTokens(ad.adCopy?.slice(0, 200) ?? ""),
    dominio: extractDomain(ad.landingUrl),
  }));

  const uf = new UnionFind();
  for (const n of nodos) uf.find(n.ad.id);
  const links = new Map<string, { pass: ClusterPass; similarity: number }>();
  const record = (adId: string, pass: ClusterPass, similarity: number) => {
    const prev = links.get(adId);
    if (!prev || similarity > prev.similarity) links.set(adId, { pass, similarity });
  };

  // PASADA 1 · misma landing y mismo anunciante. Es lo más fiable que hay:
  // el mismo sitio vendido por el mismo actor es el mismo producto.
  const porLanding = new Map<string, Nodo[]>();
  for (const n of nodos) {
    if (!n.dominio || !n.ad.advertiserName) continue;
    const clave = `${n.dominio}|${normalizeText(n.ad.advertiserName)}`;
    const arr = porLanding.get(clave) ?? [];
    arr.push(n);
    porLanding.set(clave, arr);
  }
  for (const grupo of porLanding.values()) {
    for (let i = 1; i < grupo.length; i++) {
      uf.union(grupo[0].ad.id, grupo[i].ad.id);
      record(grupo[i].ad.id, "landing", 1);
    }
  }

  // PASADA 2 · nombre normalizado idéntico, aunque el anunciante cambie.
  const porNombre = new Map<string, Nodo[]>();
  for (const n of nodos) {
    if (!n.ad.productNameRaw) continue;
    const clave = [...significantTokens(n.ad.productNameRaw)].sort().join(" ");
    if (!clave) continue;
    const arr = porNombre.get(clave) ?? [];
    arr.push(n);
    porNombre.set(clave, arr);
  }
  for (const grupo of porNombre.values()) {
    for (let i = 1; i < grupo.length; i++) {
      uf.union(grupo[0].ad.id, grupo[i].ad.id);
      record(grupo[i].ad.id, "name", 0.95);
    }
  }

  // PASADA 3 · solape de palabras significativas. Es la que puede meter la
  // pata, así que va con tres frenos.
  //
  // ── FRENO 1: EL NOMBRE MANDA SOBRE EL COPY ──
  // Los anuncios del mismo nicho usan la MISMA fórmula: "¿Cansado de X? Y lo
  // resuelve en segundos. Envío 24-48 h y pago contrareembolso". Eso son diez
  // palabras compartidas entre productos que no tienen nada que ver, y basta
  // para superar cualquier umbral razonable. Comprobado con datos reales del
  // módulo: 37 anuncios de CUATRO productos distintos acabaron en un solo
  // cluster, y el radar enseñó una oportunidad gigante que no existía.
  // Cuando los dos anuncios traen nombre de producto, se comparan SOLO los
  // nombres. El copy no puede unir nada por sí solo.
  //
  // ── FRENO 2: MÍNIMO DOS PALABRAS EN COMÚN ──
  // Con una sola, "cepillo" uniría el cepillo del perro con el del pelo.
  //
  // ── FRENO 3: NADA DE CADENAS ──
  // Union-Find une por transitividad: si A se parece a B y B a C, A y C
  // acaban juntos aunque no se parezcan en nada. Un solo enlace flojo
  // colapsa el mercado entero en un producto. Antes de unir se comprueba
  // también contra el REPRESENTANTE del grupo de destino.
  const representante = new Map<string, Nodo>();
  for (const n of nodos) representante.set(uf.find(n.ad.id), n);

  for (let i = 0; i < nodos.length; i++) {
    for (let j = i + 1; j < nodos.length; j++) {
      const a = nodos[i];
      const b = nodos[j];
      const ra = uf.find(a.ad.id);
      const rb = uf.find(b.ad.id);
      if (ra === rb) continue;

      const sim = tokenSimilarity(a, b);
      if (sim === null) continue;

      // Freno 3: el enlace tiene que sostenerse también contra los
      // representantes, no solo contra el anuncio concreto que hizo de puente.
      const repA = representante.get(ra);
      const repB = representante.get(rb);
      if (repA && repA !== a && tokenSimilarity(repA, b) === null) continue;
      if (repB && repB !== b && tokenSimilarity(a, repB) === null) continue;

      uf.union(a.ad.id, b.ad.id);
      record(b.ad.id, "tokens", sim);
      const nuevaRaiz = uf.find(a.ad.id);
      representante.set(nuevaRaiz, repA ?? a);
    }
  }

  // PASADA 4 · imagen. Deliberadamente NO implementada: exigiría descargar
  // creatividades, lo que choca con §34/§58 (no scraping agresivo, no
  // almacenar medios pesados). El hueco queda listo para cuando haya una
  // fuente de hashes perceptuales legítima.

  const grupos = new Map<string, HunterAd[]>();
  for (const n of nodos) {
    const raiz = uf.find(n.ad.id);
    const arr = grupos.get(raiz) ?? [];
    arr.push(n.ad);
    grupos.set(raiz, arr);
  }

  return [...grupos.entries()].map(([raiz, miembros]) => {
    const pases = new Set<ClusterPass>();
    const enlaces = miembros
      .map((m) => {
        const l = links.get(m.id);
        if (l) pases.add(l.pass);
        return l ? { adId: m.id, pass: l.pass, similarity: l.similarity } : null;
      })
      .filter((x): x is { adId: string; pass: ClusterPass; similarity: number } => x !== null);

    return {
      id: `cl_${raiz.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
      adIds: miembros.map((m) => m.id),
      canonicalName: chooseCanonicalName(miembros),
      confidence: clusterConfidence(miembros, enlaces),
      passes: [...pases],
      links: enlaces,
    };
  });
}

/**
 * Nombre representativo: el más repetido; en empate, el más corto. Los
 * nombres largos suelen ser el título entero del anuncio con adornos
 * ("¡OFERTA! Cepillo quitapelos… ENVÍO GRATIS"), y el corto es el producto.
 */
export function chooseCanonicalName(ads: HunterAd[]): string {
  const cuenta = new Map<string, number>();
  for (const ad of ads) {
    const n = ad.productNameRaw?.trim();
    if (!n) continue;
    cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
  }
  if (cuenta.size === 0) {
    const anunciante = ads.find((a) => a.advertiserName)?.advertiserName;
    return anunciante ? `Producto de ${anunciante}` : "Producto sin nombre";
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
}

/**
 * Confianza del cluster. Un grupo de uno es 100 % fiable (no se ha unido
 * nada); los grandes unidos solo por tokens bajan, porque es la pasada que
 * puede equivocarse.
 */
export function clusterConfidence(
  ads: HunterAd[],
  links: Array<{ pass: ClusterPass; similarity: number }>
): number {
  if (ads.length <= 1) return 1;
  if (links.length === 0) return 0.5;
  const peso: Record<ClusterPass, number> = { landing: 1, name: 0.9, tokens: 0.7, image: 0.75, manual: 1 };
  const suma = links.reduce((s, l) => s + peso[l.pass] * Math.max(0.5, l.similarity), 0);
  const media = suma / links.length;
  // Cuanto más grande el grupo, más oportunidades de haber colado algo.
  const penalizacionTamano = Math.min(0.15, (ads.length - 2) * 0.01);
  return Math.max(0, Math.min(1, media - penalizacionTamano));
}
