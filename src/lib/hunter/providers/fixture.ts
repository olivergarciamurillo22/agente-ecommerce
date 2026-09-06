// ============================================================
// AI Winner Radar — DATOS DE EJEMPLO (modo desarrollo).
//
// Existe para poder construir y probar el pipeline entero sin gastar un
// crédito ni tener una sola clave. Genera anuncios sintéticos PLAUSIBLES:
// varias marcas vendiendo el mismo producto con nombres distintos, que es
// justo el problema que el clustering tiene que resolver.
//
// DOS CANDADOS PARA QUE ESTO NO SE CONFUNDA JAMÁS CON DATOS REALES:
//   1. Solo se activa con HUNTER_FIXTURE_MODE=1 **y** fuera de producción.
//      En producción, si falta una clave, la respuesta es "fuente no
//      configurada" — nunca datos de ejemplo (§53).
//   2. Todo lo que sale de aquí viaja marcado como `fixture`, y la interfaz
//      pinta un cartel visible mientras esté activo.
// ============================================================

import { normalizeExternalAd } from "../normalize";
import type { CapabilityStatus, HunterAd, ProviderCapability, ProviderHealth } from "../types";
import type { AdSearchQuery, AdSearchResponse, IntelligenceProvider, ProviderResult, TrendPoint, TrendQuery } from "./types";
import { noCapabilities, providerOk } from "./types";

const PROVIDER = "fixture" as const;

export function fixtureModeRequested(): boolean {
  return (process.env.HUNTER_FIXTURE_MODE ?? "").trim() === "1";
}

/**
 * En producción NUNCA. Que un panel de decisiones muestre productos
 * inventados con aspecto de reales es la peor forma de romper la confianza
 * en la herramienta.
 */
export function fixtureModeActive(): boolean {
  return fixtureModeRequested() && process.env.NODE_ENV !== "production";
}

/** Familias sintéticas: cada una es UN producto vendido por varias marcas. */
const FAMILIES = [
  {
    canonical: "Quitapelos para mascotas",
    category: "mascotas",
    aliases: [
      "Cepillo quitapelos para perros y gatos",
      "Pet Hair Remover Pro",
      "Rodillo quita pelos mascotas reutilizable",
      "Dog Grooming Brush deluxe",
    ],
    price: [24.9, 39.9],
    advertisers: ["PetGlow", "HomeVet", "AnimalCare ES", "PawStore", "CleanPet"],
  },
  {
    canonical: "Organizador de maletero para coche",
    category: "coche",
    aliases: [
      "Organizador maletero plegable",
      "Car Boot Organizer",
      "Caja organizadora coche antideslizante",
    ],
    price: [29.9, 49.9],
    advertisers: ["AutoNeat", "CarHome", "DriveTidy"],
  },
  {
    canonical: "Cortaúñas eléctrico 3 en 1",
    category: "hogar",
    aliases: ["Cortaúñas eléctrico profesional", "Electric Nail Trimmer 3-in-1"],
    price: [27.9, 37.9],
    advertisers: ["BeautyLab", "NailPro ES"],
  },
  {
    canonical: "Lámpara de proyección estelar",
    category: "hogar",
    aliases: ["Proyector estrellas dormitorio", "Galaxy Star Projector", "Lámpara galaxia LED"],
    price: [19.9, 34.9],
    advertisers: ["LumiHome", "StarRoom", "NightGlow", "DecoLuz"],
  },
];

const DAY = 86400;
/** Latencia simulada por consulta, para que el progreso se vea trabajar. */
const FIXTURE_PACE_MS = 900;

/**
 * Plantillas de copy con ÁNGULOS distintos (problema, demostración,
 * testimonio, oferta, urgencia). Un fixture donde todos los anuncios dicen lo
 * mismo haría que el análisis de creatividades pareciera funcionar cuando en
 * realidad no tiene nada que distinguir.
 */
const COPY_TEMPLATES: ReadonlyArray<(producto: string) => string> = [
  (p) => `¿Harto de perder media hora limpiando? ${p} lo deja listo en dos minutos. Pago al recibir.`,
  (p) => `Mira cómo funciona: pasas ${p} una vez y se acabó. Envío en 24-48 h.`,
  (p) => `"Lo compré sin fe y ahora no lo suelto" — María, Valencia. ${p}, contrareembolso.`,
  (p) => `Antes y después con ${p}. La diferencia se ve en el primer uso. Envío gratis.`,
  (p) => `Últimas unidades de ${p}. 30 % de descuento solo hoy y pagas al recibirlo en casa.`,
  (p) => `${p} frente a hacerlo a mano: mismo resultado, una décima parte del tiempo.`,
];

function copyDe(canonical: string, alias: string, k: number): string {
  return COPY_TEMPLATES[k % COPY_TEMPLATES.length](k % 2 === 0 ? alias : canonical);
}

export class FixtureProvider implements IntelligenceProvider {
  readonly id = PROVIDER;

  capabilities(): Record<ProviderCapability, CapabilityStatus> {
    return {
      ...noCapabilities(),
      META_ADS: "AVAILABLE",
      TIKTOK_ADS: "AVAILABLE",
      TRENDS: "AVAILABLE",
    };
  }

  async health(): Promise<ProviderHealth> {
    return {
      id: PROVIDER,
      status: "READY",
      detail: "DATOS DE EJEMPLO. Nada de lo que se ve aquí es real.",
      capabilities: this.capabilities(),
      creditsRemaining: null,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }

  async searchAds(q: AdSearchQuery): Promise<ProviderResult<AdSearchResponse>> {
    // Pausa deliberada. El modo de ejemplo existe para poder ver y probar la
    // experiencia completa; sin ella la búsqueda termina antes de que se
    // pinte la primera etapa y la pantalla de progreso no se puede revisar.
    // Es una constante, no una variable de entorno: nadie tiene que
    // configurar nada para que el modo demo se comporte como el real.
    await new Promise((r) => setTimeout(r, FIXTURE_PACE_MS));
    const now = Math.floor(Date.now() / 1000);
    const term = q.keywords.toLowerCase();
    // Se filtra por palabra clave para que la búsqueda se comporte como una
    // búsqueda de verdad y no devuelva siempre lo mismo.
    const familias = FAMILIES.filter(
      (f) =>
        !term ||
        f.canonical.toLowerCase().includes(term) ||
        f.category.includes(term) ||
        f.aliases.some((a) => a.toLowerCase().includes(term)) ||
        term.split(/\s+/).some((t) => t.length > 3 && f.canonical.toLowerCase().includes(t))
    );
    const elegidas = familias.length > 0 ? familias : FAMILIES;

    // ══ EL ÍNDICE ES EL DE LA FAMILIA, NO EL DE ESTA RESPUESTA ══
    // Antes se usaba la posición dentro de la lista YA FILTRADA, así que la
    // familia del coche era `fx-0-*` en la consulta "organizador" y la de
    // mascotas era `fx-0-*` en la consulta "quitapelos". Al juntar los
    // resultados de las ocho consultas de una búsqueda, dos productos
    // distintos compartían identificadores: la deduplicación se quedaba con
    // uno de cada par y el resultado era un cluster mezclado que no
    // correspondía a nada.
    //
    // Con datos de ejemplo eso es una demo que miente; con datos reales, el
    // identificador lo pone Meta y es estable. La demo tiene que comportarse
    // igual o no sirve para comprobar nada.
    const ads: HunterAd[] = [];
    elegidas.forEach((fam) => {
      const fi = FAMILIES.indexOf(fam);
      fam.advertisers.forEach((adv, ai) => {
        // Cada anunciante tiene entre 1 y 4 creatividades del mismo producto.
        const nAds = 1 + ((fi + ai) % 4);
        for (let k = 0; k < nAds; k++) {
          const startedAt = now - (12 + ((fi * 7 + ai * 5 + k * 3) % 90)) * DAY;
          const alias = fam.aliases[(ai + k) % fam.aliases.length];
          ads.push(
            normalizeExternalAd({
              provider: PROVIDER,
              externalId: `fx-${fi}-${ai}-${k}`,
              platform: k % 3 === 0 ? "instagram" : k % 3 === 1 ? "facebook" : "tiktok",
              advertiserName: adv,
              advertiserExternalId: `fxadv-${fi}-${ai}`,
              productName: alias,
              adCopy: copyDe(fam.canonical, alias, k),
              format: k % 2 === 0 ? "video" : "image",
              countries: [q.country.toUpperCase()],
              startedAt,
              lastSeenAt: now,
              active: true,
              activeDays: Math.floor((now - startedAt) / DAY),
              landingUrl: `https://${adv.toLowerCase().replace(/[^a-z]/g, "")}.example/producto-${fi}`,
              previewUrl: null,
              imageUrl: null,
              creativeIds: [`fxc-${fi}-${ai}-${k}`],
              priceAmount: fam.price[0] + ((ai + k) % 5),
              priceCurrency: "EUR",
              raw: { fixture: true, family: fam.canonical },
            })
          );
        }
      });
    });

    return providerOk({ ads: ads.slice(0, q.limit ?? 60), nextCursor: null }, { calls: 0, credits: 0 });
  }

  async searchTrends(q: TrendQuery): Promise<ProviderResult<TrendPoint[]>> {
    return providerOk(
      [{ keyword: q.keyword, score: 62, direction: "rising", raw: { fixture: true } }],
      { calls: 0, credits: 0 }
    );
  }
}
