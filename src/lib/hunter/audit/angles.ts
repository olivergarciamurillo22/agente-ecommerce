// ============================================================
// ÁNGULOS DE VENTA A PARTIR DEL TEXTO REAL DE LOS ANUNCIOS (07-09-2026)
// docs/HUNTER-AUDITOR.md
//
// La Ad Library devuelve el TEXTO de cada anuncio (cuerpo, título, caption,
// descripción del enlace). Eso sí es dato. Lo que hace este fichero es
// clasificar ese texto en ángulos conocidos del COD (precio, urgencia, prueba
// social, dolor/beneficio, garantía, envío, regalo, autoridad) y devolver,
// para cada ángulo, LAS FRASES LITERALES que lo delatan.
//
// La cita es el dato; la etiqueta del ángulo es una heurística sobre palabras,
// y así se declara. Nada se resume hasta perder el texto original, y no se
// mira ninguna imagen ni vídeo: eso sigue desactivado.
// ============================================================

import type { AdLibraryAd } from "../discovery/types";

export type AngleId =
  | "precio_oferta"
  | "urgencia_escasez"
  | "prueba_social"
  | "dolor_beneficio"
  | "garantia_devolucion"
  | "envio_pago"
  | "regalo_ocasion"
  | "autoridad_calidad"
  | "facilidad_uso";

export interface AngleRule {
  id: AngleId;
  label: string;
  /** Patrones sobre el texto normalizado (minúsculas, sin acentos). */
  patterns: RegExp[];
}

export const ANGLE_RULES: AngleRule[] = [
  { id: "precio_oferta", label: "Precio y oferta", patterns: [/\b(oferta|descuento|rebaja|rebajado|solo \d+|por solo|desde \d+|\d+ ?%|mitad de precio|2x1|ahorra|precio especial|liquidacion|promocion)\b/] },
  { id: "urgencia_escasez", label: "Urgencia y escasez", patterns: [/\b(ultimas? unidades?|solo hoy|hasta agotar|se agota|quedan pocas?|ultimos? dias?|por tiempo limitado|no te quedes sin|date prisa|antes de que se acabe)\b/] },
  { id: "prueba_social", label: "Prueba social", patterns: [/\b(opiniones|valoraciones|resenas|clientes satisfechos|ya lo tienen|mas vendido|estrellas|recomendado por|miles de|\d+\.?\d* ?(personas|clientes|familias))\b/] },
  { id: "dolor_beneficio", label: "Dolor y beneficio", patterns: [/\b(dolor|alivia|alivio|molestias?|cansancio|caidas?|resbal[oa]n?|inseguridad|sin esfuerzo|mas comod[oa]|comodidad|mas segur[oa]|seguridad|estabilidad|autonomia|evita|previene|recupera|mejora)\b/] },
  { id: "garantia_devolucion", label: "Garantía y devolución", patterns: [/\b(garantia|devolucion|devuelve|si no te gusta|sin compromiso|satisfaccion garantizada|\d+ dias de prueba|te devolvemos)\b/] },
  { id: "envio_pago", label: "Envío y forma de pago", patterns: [/\b(contra ?reembolso|paga al recibir|pago al recibir|envio gratis|envio gratuito|entrega en (24|48|72)|24-48|envio rapido|sin pagar por adelantado|sin tarjeta)\b/] },
  { id: "regalo_ocasion", label: "Regalo y ocasión", patterns: [/\b(regalo|regala|para tu (madre|padre|abuel[oa]|abuelos|mayores)|dia de la madre|dia del padre|navidad|reyes|san valentin|cumpleanos)\b/] },
  { id: "autoridad_calidad", label: "Autoridad y calidad", patterns: [/\b(recomendado por (medicos|fisioterapeutas|profesionales)|homologado|certificado|calidad premium|acero inoxidable|resistente|duradero|fabricado en|disenado en|espanol[ae]?s?)\b/] },
  { id: "facilidad_uso", label: "Facilidad de uso e instalación", patterns: [/\b(sin herramientas|sin taladrar|sin obras|facil de (usar|instalar|montar)|en segundos|listo para usar|se adapta|universal|plug ?and ?play)\b/] },
];

export interface AngleEvidence {
  /** Frase literal del anuncio, recortada a una longitud legible. */
  quote: string;
  adId: string;
  /** De qué campo de la API salió. */
  field: "body" | "title" | "caption" | "description";
}

export interface AngleFinding {
  id: AngleId;
  label: string;
  /** Cuántos anuncios distintos lo usan. */
  ads: number;
  evidence: AngleEvidence[];
  /** Siempre la misma frase: la etiqueta es heurística; las citas son el dato. */
  nature: "heuristica_sobre_texto_real";
}

export interface AngleReport {
  angles: AngleFinding[];
  /** Anuncios que no encajaron en ningún ángulo conocido, con su primer texto. */
  unclassified: Array<{ adId: string; sample: string }>;
  adsAnalyzed: number;
  adsWithoutText: number;
}

export const normalizeAngleText = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Divide un texto en frases cortas para citar solo la que contiene el patrón. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+|\s[•·▪►✔✅]\s?/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

/** Frase literal recortada: si es muy larga, se corta con «…», nunca se reescribe. */
function quote(sentence: string, max = 180): string {
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

export function extractAngles(ads: AdLibraryAd[]): AngleReport {
  const porAngulo = new Map<AngleId, AngleFinding>();
  const unclassified: Array<{ adId: string; sample: string }> = [];
  let adsWithoutText = 0;

  for (const ad of ads) {
    const fields: Array<[AngleEvidence["field"], string[]]> = [
      ["body", ad.bodies],
      ["title", ad.titles],
      ["caption", ad.captions],
      ["description", ad.descriptions ?? []],
    ];
    let algunTexto = false;
    let clasificado = false;
    let primerTexto = "";
    const vistasEnEsteAnuncio = new Set<AngleId>();
    for (const [field, textos] of fields) {
      for (const texto of textos) {
        if (!texto.trim()) continue;
        algunTexto = true;
        if (!primerTexto) primerTexto = texto.trim();
        for (const frase of sentences(texto)) {
          const plano = normalizeAngleText(frase);
          for (const rule of ANGLE_RULES) {
            if (!rule.patterns.some((re) => re.test(plano))) continue;
            clasificado = true;
            const finding = porAngulo.get(rule.id) ?? { id: rule.id, label: rule.label, ads: 0, evidence: [], nature: "heuristica_sobre_texto_real" as const };
            if (!vistasEnEsteAnuncio.has(rule.id)) {
              finding.ads += 1;
              vistasEnEsteAnuncio.add(rule.id);
            }
            const q = quote(frase);
            if (finding.evidence.length < 6 && !finding.evidence.some((e) => e.quote === q)) finding.evidence.push({ quote: q, adId: ad.id, field });
            porAngulo.set(rule.id, finding);
          }
        }
      }
    }
    if (!algunTexto) adsWithoutText += 1;
    else if (!clasificado) unclassified.push({ adId: ad.id, sample: quote(primerTexto, 140) });
  }

  return {
    angles: [...porAngulo.values()].sort((a, b) => b.ads - a.ads),
    unclassified: unclassified.slice(0, 10),
    adsAnalyzed: ads.length,
    adsWithoutText,
  };
}
