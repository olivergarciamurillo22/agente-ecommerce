// ============================================================
// AI Winner Radar — REGISTRO DE PROVEEDORES.
//
// Decide QUÉ fuentes hay vivas en cada momento y expone su estado sin filtrar
// un solo secreto. Es también donde se aplica la regla de §53: en producción
// no se sustituye una fuente que falta por datos de ejemplo; se dice que
// falta. Un panel que enseña productos inventados con aspecto de reales es
// peor que un panel vacío.
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

/** Proveedores que pueden BUSCAR anuncios (los que alimentan el radar). */
export function searchProviders(opts: RegistryOptions = {}): IntelligenceProvider[] {
  if (fixtureModeActive()) return [new FixtureProvider()];
  const out: IntelligenceProvider[] = [];
  if ((process.env.WINNINGHUNTER_API_KEY ?? "").trim()) out.push(new WinningHunterProvider(opts.budget));
  if ((process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? "").trim()) out.push(new MetaAdLibraryProvider(opts.budget));
  if ((process.env.TIKTOK_RESEARCH_CLIENT_KEY ?? "").trim() && (process.env.TIKTOK_RESEARCH_CLIENT_SECRET ?? "").trim()) {
    out.push(new TikTokResearchProvider(opts.budget));
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
  fixtureMode: boolean;
  /** Petición de modo ejemplo ignorada por estar en producción. */
  fixtureRefusedInProduction: boolean;
  providers: ProviderHealth[];
}

export async function radarReadiness(): Promise<RadarReadiness> {
  const fixture = fixtureModeActive();
  const refused = fixtureModeRequested() && !fixture;
  const providers = await Promise.all(allProviders().map((p) => p.health()));
  const buscadores = searchProviders();

  let reason: string;
  if (fixture) {
    reason = "Modo de EJEMPLO activo: los resultados son inventados y no valen para decidir nada.";
  } else if (buscadores.length === 0) {
    reason = refused
      ? "HUNTER_FIXTURE_MODE está pedido pero se ignora en producción. Configura al menos WINNINGHUNTER_API_KEY."
      : "Ninguna fuente de anuncios configurada. Añade WINNINGHUNTER_API_KEY para empezar.";
  } else {
    reason = `${buscadores.length} fuente(s) de anuncios configurada(s).`;
  }

  return {
    canSearch: fixture || buscadores.length > 0,
    reason,
    fixtureMode: fixture,
    fixtureRefusedInProduction: refused,
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
