// ============================================================
// AI Winner Radar — REGISTRO DE PROVEEDORES (META PRIMERO).
//
// Decide QUÉ fuentes hay vivas en cada momento y expone su estado sin filtrar
// un solo secreto.
//
// ══ POR QUÉ META Y NO UN AGREGADOR DE PAGO ══
// La Biblioteca de Anuncios de Meta es la fuente PRIMARIA: son los anuncios
// de verdad, publicados por las marcas, con su fecha de arranque real. Un
// agregador comercial es esa misma información, cobrada, con retraso y con
// estimaciones encima que no se pueden auditar. Depender de él significa que
// el día que cambie de precio o cierre, el radar deja de existir.
//
// WinningHunter sigue soportado, pero como COMPLEMENTO opcional. El radar
// funciona entero sin él, y `WINNER_RADAR_PROVIDER` decide quién manda.
//
// La regla de §53 se mantiene intacta: en producción no se sustituye una
// fuente que falta por datos de ejemplo. Se dice que falta. Un panel que
// enseña productos inventados con aspecto de reales es peor que uno vacío.
// ============================================================

import { CallBudget } from "../http";
import type { ProviderHealth, ProviderId } from "../types";
import { CasamableInternalProvider } from "./internal";
import { FixtureProvider, fixtureModeActive, fixtureModeRequested } from "./fixture";
import { MetaAdLibraryProvider } from "./meta-ad-library";
import { SupplierProvider } from "./supplier";
import { TikTokResearchProvider } from "./tiktok-research";
import { WinningHunterProvider } from "./winninghunter";
import type { IntelligenceProvider } from "./types";

export interface RegistryOptions {
  budget?: CallBudget;
}

/**
 * `meta`   → solo Meta (por defecto: es la fuente que no depende de nadie)
 * `wh`     → solo WinningHunter (para comparar o si Meta está caída)
 * `all`    → todas las que tengan credencial, Meta primero
 */
export type RadarProviderMode = "meta" | "wh" | "all";

export function providerMode(): RadarProviderMode {
  const raw = (process.env.WINNER_RADAR_PROVIDER ?? "meta").trim().toLowerCase();
  if (raw === "wh" || raw === "winninghunter") return "wh";
  if (raw === "all" || raw === "auto") return "all";
  return "meta";
}

/** Interruptor general del módulo. Ausente = encendido: no rompe lo que ya había. */
export function radarEnabled(): boolean {
  const raw = (process.env.WINNER_RADAR_ENABLED ?? "").trim();
  return raw !== "0" && raw.toLowerCase() !== "false";
}

function metaConfigured(): boolean {
  return (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? "").trim().length > 0;
}
function whConfigured(): boolean {
  return (process.env.WINNINGHUNTER_API_KEY ?? "").trim().length > 0;
}
function tiktokConfigured(): boolean {
  return (
    (process.env.TIKTOK_RESEARCH_CLIENT_KEY ?? "").trim().length > 0 &&
    (process.env.TIKTOK_RESEARCH_CLIENT_SECRET ?? "").trim().length > 0
  );
}

/**
 * Proveedores que pueden BUSCAR anuncios. El ORDEN importa: el primero marca
 * el vocabulario y el resto complementa, así que Meta va delante salvo que se
 * pida explícitamente lo contrario.
 */
export function searchProviders(opts: RegistryOptions = {}): IntelligenceProvider[] {
  if (fixtureModeActive()) return [new FixtureProvider()];
  const modo = providerMode();
  const out: IntelligenceProvider[] = [];

  if (modo !== "wh" && metaConfigured()) out.push(new MetaAdLibraryProvider(opts.budget));
  if (modo !== "meta" && whConfigured()) out.push(new WinningHunterProvider(opts.budget));
  if (modo === "all" && tiktokConfigured()) out.push(new TikTokResearchProvider(opts.budget));

  // Red de seguridad: si el modo pedido no tiene credencial pero el OTRO sí,
  // se usa el que hay en vez de dejar el radar muerto. Se dice en `reason`.
  if (out.length === 0) {
    if (metaConfigured()) out.push(new MetaAdLibraryProvider(opts.budget));
    else if (whConfigured()) out.push(new WinningHunterProvider(opts.budget));
  }
  return out;
}

/** Todos, incluidos los que solo enriquecen (internos y proveedor). */
export function allProviders(opts: RegistryOptions = {}): IntelligenceProvider[] {
  return [...searchProviders(opts), new CasamableInternalProvider(), new SupplierProvider()];
}

export interface RadarReadiness {
  /** ¿Se puede buscar algo? */
  canSearch: boolean;
  reason: string;
  /** Qué hay que hacer para poder buscar. Vacío si ya se puede. */
  nextStep: string | null;
  mode: RadarProviderMode;
  /** Proveedor que va a mandar de verdad en la próxima búsqueda. */
  activeProvider: ProviderId | null;
  /** Fuentes configuradas que NO responden. Vacío es lo normal. */
  brokenProviders: ProviderId[];
  enabled: boolean;
  fixtureMode: boolean;
  /** Petición de modo ejemplo ignorada por estar en producción. */
  fixtureRefusedInProduction: boolean;
  /** ¿Hay modelo de IA? El radar funciona sin él, con menos lectura. */
  llm: "openai" | "openrouter" | "none";
  providers: ProviderHealth[];
}

export async function radarReadiness(): Promise<RadarReadiness> {
  // Import perezoso: `llm.ts` arrastra el SDK de OpenAI y este módulo lo
  // importa también el doctor, que no debería pagar ese coste para nada.
  const { llmBackend } = await import("../llm");
  const fixture = fixtureModeActive();
  const refused = fixtureModeRequested() && !fixture;
  const modo = providerMode();
  const providers = await Promise.all(allProviders().map((p) => p.health()));
  const buscadores = searchProviders();
  const activo = (buscadores[0]?.id ?? null) as ProviderId | null;

  // ══ «SE PUEDE BUSCAR» TIENE QUE SIGNIFICAR QUE SE PUEDE BUSCAR ══
  // Esto solo miraba que hubiera una fuente CONFIGURADA. En una validación
  // real, con el token de Meta caducado, el doctor decía META ERROR en una
  // línea y «SE PUEDE BUSCAR» tres líneas más abajo, y salía con código 0.
  // Un diagnóstico que se contradice a sí mismo es peor que ninguno: manda a
  // buscar a quien no puede, y en integración continua pasa por verde.
  const salud = new Map(providers.map((p) => [p.id, p]));
  const vivas = buscadores.filter((b) => {
    const h = salud.get(b.id);
    return h ? h.status === "CONNECTED" || h.status === "READY" : false;
  });
  const rotas = buscadores.filter((b) => !vivas.some((v) => v.id === b.id));

  let reason: string;
  let nextStep: string | null = null;

  if (!radarEnabled()) {
    reason = "El radar está apagado (WINNER_RADAR_ENABLED=0).";
    nextStep = "Quita WINNER_RADAR_ENABLED del .env o ponlo a 1.";
  } else if (fixture) {
    reason = "Modo de EJEMPLO activo: los resultados son inventados y no valen para decidir nada.";
  } else if (buscadores.length === 0) {
    reason = "Todavía no hay ninguna fuente de anuncios conectada.";
    nextStep = "Añade META_AD_LIBRARY_ACCESS_TOKEN al .env. Es un token de la Biblioteca de Anuncios de Meta, gratuito.";
  } else if (modo === "meta" && activo !== "meta_ad_library") {
    reason = `Meta no está configurada; se usará ${activo} en su lugar.`;
    nextStep = "Añade META_AD_LIBRARY_ACCESS_TOKEN para usar la fuente principal.";
  } else if (modo === "wh" && activo !== "winninghunter") {
    reason = `WINNER_RADAR_PROVIDER=wh pero falta WINNINGHUNTER_API_KEY; se usará ${activo}.`;
  } else if (vivas.length === 0) {
    // Configurada pero sin responder. El motivo lo da la propia sonda, y ahí
    // está lo que hay que arreglar (token caducado, permiso, cuota).
    const detalle = rotas.map((r) => salud.get(r.id)?.detail).filter(Boolean)[0];
    reason = `La fuente está configurada pero NO responde. ${detalle ?? ""}`.trim();
    nextStep = rotas.some((r) => r.id === "meta_ad_library")
      ? "Revisa META_AD_LIBRARY_ACCESS_TOKEN: los tokens de Meta caducan. Genera uno nuevo en developers.facebook.com."
      : "Revisa la credencial de la fuente que falla.";
  } else if (rotas.length > 0) {
    reason = `${vivas.length} de ${buscadores.length} fuentes responden. Fallan: ${rotas.map((r) => r.id).join(", ")}.`;
  } else {
    const nombres = buscadores.length === 1 ? "la Biblioteca de Anuncios de Meta" : `${buscadores.length} fuentes`;
    reason = `Listo para buscar con ${activo === "meta_ad_library" ? "la Biblioteca de Anuncios de Meta" : nombres}.`;
  }

  return {
    // Se puede buscar si hay AL MENOS UNA fuente que responde, no una
    // configurada. Con varias, que caiga una da cobertura parcial, no cero.
    canSearch: radarEnabled() && (fixture || vivas.length > 0),
    reason,
    nextStep,
    mode: modo,
    activeProvider: (vivas[0]?.id ?? activo) as ProviderId | null,
    brokenProviders: rotas.map((r) => r.id) as ProviderId[],
    enabled: radarEnabled(),
    fixtureMode: fixture,
    fixtureRefusedInProduction: refused,
    llm: llmBackend(),
    providers,
  };
}

export function providerById(id: ProviderId, opts: RegistryOptions = {}): IntelligenceProvider | null {
  switch (id) {
    case "winninghunter":
      return new WinningHunterProvider(opts.budget);
    case "meta_ad_library":
      return new MetaAdLibraryProvider(opts.budget);
    case "tiktok_research":
      return new TikTokResearchProvider(opts.budget);
    case "casamable_internal":
      return new CasamableInternalProvider();
    case "supplier":
      return new SupplierProvider();
    case "fixture":
      return fixtureModeActive() ? new FixtureProvider() : null;
  }
}

export { fixtureModeActive, fixtureModeRequested };
