// ============================================================
// Cazador de productos — FIXTURES DE DESARROLLO (solo mock).
//
// Todo lo que hay aquí es FICTICIO: anunciantes inventados, dominios
// `.example`, previews en SVG inline y puntuaciones etiquetadas "[MOCK]".
// No hay marcas reales ni personas. Este archivo no puede alimentar
// producción: el adaptador mock se niega a arrancar con NODE_ENV=production.
// ============================================================

import {
  WINNER_SIGNAL_LABEL,
  type ScoreConfidence,
  type WinnerScoreBreakdown,
  type WinnerScoreSignal,
  type WinnerSignalKey,
  type WinningProductCandidate,
} from "./types";

export const MOCK_NOTICE = "Datos de ejemplo (mock). Nada de esto es real.";

const MOCK_ANALYZED_AT = "2026-09-01T08:00:00.000Z";

/** Pesos de ejemplo (suman 1,0). El backend real decide los suyos. */
const MOCK_WEIGHTS: Record<WinnerSignalKey, number> = {
  ad_age: 0.15,
  active_continuity: 0.1,
  creative_variations: 0.1,
  advertiser_similar_ads: 0.05,
  multi_country: 0.05,
  landing_quality: 0.1,
  offer_clarity: 0.1,
  price_potential: 0.1,
  saturation: 0.1,
  cod_fit: 0.1,
  margin_potential: 0.05,
};

type SignalSeed = Partial<Record<WinnerSignalKey, { value: number; observed: string }>>;

function breakdown(total: number, confidence: ScoreConfidence, seeds: SignalSeed, reason: string): WinnerScoreBreakdown {
  const signals: WinnerScoreSignal[] = (Object.keys(MOCK_WEIGHTS) as WinnerSignalKey[]).map((key) => {
    const seed = seeds[key];
    return {
      key,
      label: WINNER_SIGNAL_LABEL[key],
      value: seed ? seed.value : null,
      weight: MOCK_WEIGHTS[key],
      observed: seed ? seed.observed : null,
      missing: !seed,
    };
  });
  return { total, confidence, analyzedAt: MOCK_ANALYZED_AT, reason: `[MOCK] ${reason}`, signals };
}

/** Preview SVG inline (sin imágenes externas). */
function svgPreview(label: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">` +
    `<rect width="640" height="360" fill="hsl(${hue} 30% 93%)"/>` +
    `<rect x="220" y="70" width="200" height="140" rx="18" fill="hsl(${hue} 45% 74%)"/>` +
    `<circle cx="320" cy="140" r="34" fill="hsl(${hue} 40% 90%)"/>` +
    `<text x="320" y="262" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="24" font-weight="600" text-anchor="middle" fill="hsl(${hue} 30% 28%)">${label}</text>` +
    `<text x="320" y="300" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="15" text-anchor="middle" fill="hsl(${hue} 15% 46%)">MOCK · creatividad de ejemplo</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Nueve candidatos ficticios con cobertura de datos mixta: algunos completos,
 * otros con campos a null (dataStatus partial/unknown) y dos sin Winner Score.
 * Tres ya están en el pipeline para que el tablero y el comparador tengan
 * algo que enseñar.
 */
export function buildMockCandidates(): WinningProductCandidate[] {
  return [
    {
      id: "mock_001",
      productName: "Organizador plegable de cocina",
      advertiser: "Tienda Demo Norte",
      countries: ["ES", "PT"],
      format: "video",
      cta: "Comprar ahora",
      startedAt: "2026-06-20",
      activeDays: 74,
      variations: 7,
      landingUrl: "https://demo-norte.example/organizador-plegable",
      detectedPrice: { amount: 24.99, currency: "EUR" },
      previewUrl: svgPreview("Organizador plegable", 210),
      adCopy: "Duplica el espacio de tu cocina en 10 segundos. Se pliega, se limpia y aguanta 15 kg.",
      dataStatus: "complete",
      winnerScore: breakdown(
        78,
        "high",
        {
          ad_age: { value: 80, observed: "empezó hace 74 días" },
          active_continuity: { value: 85, observed: "sin pausas detectadas" },
          creative_variations: { value: 70, observed: "7 variaciones" },
          advertiser_similar_ads: { value: 60, observed: "3 anuncios más del mismo anunciante" },
          multi_country: { value: 50, observed: "2 países" },
          landing_quality: { value: 75, observed: "landing de producto único" },
          offer_clarity: { value: 80, observed: "precio y beneficio en el copy" },
          price_potential: { value: 70, observed: "24,99 € detectado" },
          saturation: { value: 65, observed: "pocos anunciantes con el mismo producto" },
          cod_fit: { value: 85, observed: "ticket y tamaño compatibles con COD" },
          margin_potential: { value: 70, observed: "coste mayorista estimado bajo" },
        },
        "Puntuación ficticia de desarrollo: anuncio longevo con variaciones y buena claridad de oferta."
      ),
      status: "researching",
      economics: null,
      notes: [{ at: "2026-08-29T11:20:00.000Z", text: "7 variaciones activas: el anunciante sigue invirtiendo." }],
      decisions: [
        { at: "2026-08-28T10:00:00.000Z", from: null, to: "saved", note: null },
        { at: "2026-08-30T09:30:00.000Z", from: "saved", to: "researching", note: "Buscar proveedor en Dropi" },
      ],
      savedAt: "2026-08-28T10:00:00.000Z",
      risks: ["Producto voluminoso: transporte más caro"],
      saturation: "low",
    },
    {
      id: "mock_002",
      productName: "Lámpara de lectura con clip",
      advertiser: "Hogar Ficticio Sur",
      countries: ["ES"],
      format: "image",
      cta: "Más información",
      startedAt: "2026-08-10",
      activeDays: 23,
      variations: 2,
      landingUrl: "https://ficticio-sur.example/lampara-clip",
      detectedPrice: { amount: 19.9, currency: "EUR" },
      previewUrl: svgPreview("Lámpara con clip", 40),
      adCopy: "Lee sin molestar a nadie. Tres tonos de luz y batería para una semana.",
      dataStatus: "complete",
      winnerScore: breakdown(
        54,
        "medium",
        {
          ad_age: { value: 35, observed: "empezó hace 23 días" },
          active_continuity: { value: 60, observed: "sin pausas detectadas" },
          creative_variations: { value: 30, observed: "2 variaciones" },
          multi_country: { value: 20, observed: "1 país" },
          landing_quality: { value: 65, observed: "landing de catálogo" },
          offer_clarity: { value: 70, observed: "beneficio claro, sin precio en el copy" },
          price_potential: { value: 55, observed: "19,90 € detectado" },
          saturation: { value: 50, observed: "varios anunciantes similares" },
          cod_fit: { value: 75, observed: "producto pequeño y ligero" },
        },
        "Puntuación ficticia de desarrollo: anuncio reciente, aún sin señal de continuidad."
      ),
      status: "discovered",
      economics: null,
      notes: [],
      decisions: [],
      savedAt: null,
      risks: [],
      saturation: "medium",
    },
    {
      id: "mock_003",
      productName: "Cepillo eléctrico para mascotas",
      advertiser: "Prueba Mascotas Felices",
      countries: ["ES", "IT", "FR"],
      format: "video",
      cta: "Comprar",
      startedAt: "2026-05-02",
      activeDays: 123,
      variations: 12,
      landingUrl: "https://mascotas-felices.example/cepillo-electrico",
      detectedPrice: { amount: 32.9, currency: "EUR" },
      previewUrl: svgPreview("Cepillo para mascotas", 140),
      adCopy: "Adiós al pelo por toda la casa. Aspira mientras cepilla, sin ruido que asuste.",
      dataStatus: "complete",
      winnerScore: breakdown(
        85,
        "high",
        {
          ad_age: { value: 95, observed: "empezó hace 123 días" },
          active_continuity: { value: 90, observed: "sin pausas detectadas" },
          creative_variations: { value: 90, observed: "12 variaciones" },
          advertiser_similar_ads: { value: 70, observed: "5 anuncios más del mismo anunciante" },
          multi_country: { value: 75, observed: "3 países" },
          landing_quality: { value: 80, observed: "landing de producto único con reseñas" },
          offer_clarity: { value: 85, observed: "precio, beneficio y garantía en el copy" },
          price_potential: { value: 80, observed: "32,90 € detectado" },
          saturation: { value: 45, observed: "bastantes anunciantes con el mismo producto" },
          cod_fit: { value: 90, observed: "ticket ideal para COD" },
          margin_potential: { value: 75, observed: "coste mayorista estimado medio" },
        },
        "Puntuación ficticia de desarrollo: señales fuertes de longevidad y escala, saturación a vigilar."
      ),
      status: "validate_supplier",
      economics: { costEstimate: 9.8, salePriceEstimate: 32.9, shippingCost: 5.5, returnCost: 9.37 },
      notes: [
        { at: "2026-08-26T16:05:00.000Z", text: "Pedir muestra al proveedor antes de grabar creatividad." },
        { at: "2026-08-31T09:12:00.000Z", text: "Dos proveedores en Dropi con stock; comparar tiempos de envío." },
      ],
      decisions: [
        { at: "2026-08-25T12:00:00.000Z", from: null, to: "saved", note: null },
        { at: "2026-08-26T16:00:00.000Z", from: "saved", to: "researching", note: null },
        { at: "2026-08-31T09:10:00.000Z", from: "researching", to: "validate_supplier", note: "Proveedor localizado" },
      ],
      savedAt: "2026-08-25T12:00:00.000Z",
      risks: ["Saturación en aumento: varios anunciantes activos", "Pilas/batería: revisar restricciones de transporte"],
      saturation: "medium",
    },
    {
      id: "mock_004",
      productName: null,
      advertiser: "Demo Gadgets Ibéricos",
      countries: ["ES"],
      format: "carousel",
      cta: null,
      startedAt: null,
      activeDays: null,
      variations: 3,
      landingUrl: null,
      detectedPrice: null,
      previewUrl: svgPreview("Gadget sin identificar", 280),
      adCopy: "Descubre el gadget del que todo el mundo habla este verano.",
      dataStatus: "partial",
      winnerScore: null,
      status: "discovered",
      economics: null,
      notes: [],
      decisions: [],
      savedAt: null,
      risks: [],
      saturation: null,
    },
    {
      id: "mock_005",
      productName: "Masajeador cervical portátil",
      advertiser: null,
      countries: ["ES", "DE"],
      format: "video",
      cta: "Comprar ahora",
      startedAt: "2026-07-14",
      activeDays: 50,
      variations: null,
      landingUrl: "https://ejemplo-bienestar.example/masajeador-cervical",
      detectedPrice: { amount: 39.99, currency: "EUR" },
      previewUrl: svgPreview("Masajeador cervical", 330),
      adCopy: "15 minutos al día y olvida la tensión del cuello. Calor + impulsos, sin cables.",
      dataStatus: "partial",
      winnerScore: breakdown(
        66,
        "medium",
        {
          ad_age: { value: 70, observed: "empezó hace 50 días" },
          active_continuity: { value: 65, observed: "una pausa breve detectada" },
          multi_country: { value: 50, observed: "2 países" },
          landing_quality: { value: 70, observed: "landing de producto único" },
          offer_clarity: { value: 75, observed: "beneficio y precio en el copy" },
          price_potential: { value: 80, observed: "39,99 € detectado" },
          cod_fit: { value: 70, observed: "ticket alto para COD, entrega más sensible" },
        },
        "Puntuación ficticia de desarrollo con señales incompletas: no se pudo leer el anunciante ni las variaciones."
      ),
      status: "discovered",
      economics: null,
      notes: [],
      decisions: [],
      savedAt: null,
      risks: ["Ticket alto: más rehusados esperables en COD"],
      saturation: null,
    },
    {
      id: "mock_006",
      productName: "Set de cuchillos cerámicos",
      advertiser: "Muestra Cocina Fácil",
      countries: ["ES", "PT", "FR", "IT"],
      format: "image",
      cta: "Comprar",
      startedAt: "2026-04-15",
      activeDays: 140,
      variations: 9,
      landingUrl: "https://cocina-facil.example/cuchillos-ceramicos",
      detectedPrice: { amount: 27.5, currency: "EUR" },
      previewUrl: svgPreview("Cuchillos cerámicos", 15),
      adCopy: "Afilados de por vida. Set de 4 con fundas, ligeros y sin óxido.",
      dataStatus: "complete",
      winnerScore: breakdown(
        71,
        "medium",
        {
          ad_age: { value: 95, observed: "empezó hace 140 días" },
          active_continuity: { value: 80, observed: "sin pausas detectadas" },
          creative_variations: { value: 80, observed: "9 variaciones" },
          advertiser_similar_ads: { value: 55, observed: "2 anuncios más del mismo anunciante" },
          multi_country: { value: 90, observed: "4 países" },
          landing_quality: { value: 60, observed: "landing de catálogo" },
          offer_clarity: { value: 65, observed: "beneficio claro, precio solo en landing" },
          price_potential: { value: 60, observed: "27,50 € detectado" },
          saturation: { value: 25, observed: "muchos anunciantes con el mismo producto" },
          cod_fit: { value: 70, observed: "tamaño compatible; objeto cortante" },
          margin_potential: { value: 60, observed: "coste mayorista estimado medio" },
        },
        "Puntuación ficticia de desarrollo: producto probado en varios países pero muy saturado."
      ),
      status: "ready_to_test",
      economics: { costEstimate: 8.2, salePriceEstimate: 27.5, shippingCost: 5.5, returnCost: 9.37 },
      notes: [{ at: "2026-09-01T07:45:00.000Z", text: "Creatividad grabada; falta subtitular." }],
      decisions: [
        { at: "2026-08-20T09:00:00.000Z", from: null, to: "saved", note: null },
        { at: "2026-08-22T10:00:00.000Z", from: "saved", to: "validate_supplier", note: "Saltamos investigación: ya lo conocemos" },
        { at: "2026-08-27T18:30:00.000Z", from: "validate_supplier", to: "prepare_creative", note: null },
        { at: "2026-09-01T07:40:00.000Z", from: "prepare_creative", to: "ready_to_test", note: null },
      ],
      savedAt: "2026-08-20T09:00:00.000Z",
      risks: ["Saturación alta: coste de anuncio probablemente elevado", "Objeto cortante: comprobar política de transportista"],
      saturation: "high",
    },
    {
      id: "mock_007",
      productName: "Corrector de postura ajustable",
      advertiser: "Demo Bienestar Casa",
      countries: ["ES"],
      format: "video",
      cta: "Más información",
      startedAt: "2026-08-25",
      activeDays: 8,
      variations: 1,
      landingUrl: null,
      detectedPrice: { amount: 22, currency: "EUR" },
      previewUrl: svgPreview("Corrector de postura", 95),
      adCopy: "Espalda recta sin pensar en ello. Invisible bajo la ropa.",
      dataStatus: "partial",
      winnerScore: breakdown(
        38,
        "low",
        {
          ad_age: { value: 15, observed: "empezó hace 8 días" },
          creative_variations: { value: 15, observed: "1 variación" },
          multi_country: { value: 20, observed: "1 país" },
          offer_clarity: { value: 60, observed: "beneficio claro, sin precio en el copy" },
          price_potential: { value: 55, observed: "22,00 € detectado" },
          saturation: { value: 30, observed: "producto muy repetido en la biblioteca" },
          cod_fit: { value: 75, observed: "producto pequeño y ligero" },
        },
        "Puntuación ficticia de desarrollo: anuncio demasiado nuevo para juzgar continuidad; landing no leída."
      ),
      status: "discovered",
      economics: null,
      notes: [],
      decisions: [],
      savedAt: null,
      risks: ["Tallaje: posibles devoluciones por ajuste"],
      saturation: "high",
    },
    {
      id: "mock_008",
      productName: null,
      advertiser: "Ficticia Belleza Zen",
      countries: ["PT", "ES"],
      format: "image",
      cta: "Comprar ahora",
      startedAt: "2026-08-01",
      activeDays: 32,
      variations: 4,
      landingUrl: "https://belleza-zen.example/",
      detectedPrice: null,
      previewUrl: null,
      adCopy: null,
      dataStatus: "unknown",
      winnerScore: null,
      status: "discovered",
      economics: null,
      notes: [],
      decisions: [],
      savedAt: null,
      risks: [],
      saturation: null,
    },
    {
      id: "mock_009",
      productName: "Botella de agua con infusor",
      advertiser: "Tienda Ejemplo Luz",
      countries: ["ES"],
      format: "carousel",
      cta: "Comprar",
      startedAt: "2026-03-01",
      activeDays: 185,
      variations: 15,
      landingUrl: "https://ejemplo-luz.example/botella-infusor",
      detectedPrice: { amount: 14.99, currency: "EUR" },
      previewUrl: svgPreview("Botella con infusor", 185),
      adCopy: "Agua con sabor sin azúcar. 900 ml, sin BPA, lista para el gimnasio.",
      dataStatus: "complete",
      winnerScore: breakdown(
        45,
        "high",
        {
          ad_age: { value: 100, observed: "empezó hace 185 días" },
          active_continuity: { value: 85, observed: "sin pausas detectadas" },
          creative_variations: { value: 95, observed: "15 variaciones" },
          advertiser_similar_ads: { value: 40, observed: "1 anuncio más del mismo anunciante" },
          multi_country: { value: 20, observed: "1 país" },
          landing_quality: { value: 70, observed: "landing de producto único" },
          offer_clarity: { value: 75, observed: "precio y beneficio en el copy" },
          price_potential: { value: 25, observed: "14,99 € detectado: ticket bajo" },
          saturation: { value: 15, observed: "producto genérico, muchísimos anunciantes" },
          cod_fit: { value: 35, observed: "ticket bajo: el rehusado se come el margen" },
          margin_potential: { value: 20, observed: "margen estimado insuficiente" },
        },
        "Puntuación ficticia de desarrollo: anuncio longevo pero ticket bajo y saturación alta."
      ),
      status: "discarded",
      economics: { costEstimate: 4.1, salePriceEstimate: 14.99, shippingCost: 5.5, returnCost: 9.37 },
      notes: [],
      decisions: [
        { at: "2026-08-18T08:00:00.000Z", from: null, to: "saved", note: null },
        { at: "2026-08-19T08:30:00.000Z", from: "saved", to: "discarded", note: "Margen insuficiente para COD" },
      ],
      savedAt: "2026-08-18T08:00:00.000Z",
      risks: ["Ticket bajo: un rehusado anula tres entregas"],
      saturation: "high",
    },
  ];
}
