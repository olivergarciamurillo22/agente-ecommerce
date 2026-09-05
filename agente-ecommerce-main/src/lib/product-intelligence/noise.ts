import type { NoiseReason, RawAd } from "./types";

const SERVICE = /\b(consulta|consultoría|curso|formación|agencia|seguro|abogado|clínica|tratamiento presencial|reserva cita)\b/i;
const APP = /\b(app|aplicación móvil|software|saas|suscripción digital|descarga digital)\b/i;
const NON_PHYSICAL = /\b(ebook|e-book|infoproducto|webinar|masterclass|membresía|plantilla digital)\b/i;
const LARGE_BRANDS = new Set(["amazon", "ikea", "lidl", "carrefour", "decathlon", "mediamarkt", "el corte inglés", "temu", "aliexpress"]);
const PRODUCT_SIGNAL = /\b(compra|precio|oferta|envío|entrega|producto|corrector|almohada|cepillo|limpiador|soporte|dispositivo|pack|unidad)\b/i;

export function classifyNoise(ads: RawAd[]): { noise: boolean; reason?: NoiseReason; candidateEligible: boolean } {
  const text = ads.map((ad) => `${ad.advertiserName} ${ad.productName ?? ""} ${ad.title ?? ""} ${ad.caption ?? ""} ${ad.copy}`).join(" ");
  const advertiser = ads[0]?.advertiserName.trim().toLocaleLowerCase("es") ?? "";
  if (LARGE_BRANDS.has(advertiser)) return { noise: true, reason: "LARGE_ESTABLISHED_BRAND", candidateEligible: false };
  if (NON_PHYSICAL.test(text)) return { noise: true, reason: "NON_PHYSICAL_PRODUCT", candidateEligible: false };
  if (APP.test(text)) return { noise: true, reason: "APP", candidateEligible: false };
  if (SERVICE.test(text)) return { noise: true, reason: "SERVICE", candidateEligible: false };
  if (!PRODUCT_SIGNAL.test(text) && !ads.some((ad) => ad.productName || ad.title || ad.landingUrl)) {
    return { noise: true, reason: "INSUFFICIENT_PRODUCT_SIGNAL", candidateEligible: false };
  }
  return { noise: false, candidateEligible: true };
}

