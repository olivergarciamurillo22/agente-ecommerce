import type { AdSource, RawAd } from "./types";

/** Provider seguro para la primera versión: acepta datos importados, sin tocar Meta Ads. */
export class ManualImportProvider implements AdSource {
  constructor(private readonly ads: RawAd[] = []) {}
  async searchAds(query: string): Promise<RawAd[]> {
    const needle = query.toLocaleLowerCase("es");
    return this.ads.filter((ad) => `${ad.productName ?? ""} ${ad.copy}`.toLocaleLowerCase("es").includes(needle)).map((ad) => ({ ...ad, provider: "JSON_IMPORT" }));
  }
}

export class UnconfiguredProvider implements AdSource {
  async searchAds(): Promise<RawAd[]> { return []; }
}

/** Solo tests. Nunca se selecciona desde API, CLI productivo o Auto Hunt. */
export class TestFixtureProvider implements AdSource {
  constructor(private readonly ads: RawAd[]) {}
  async searchAds(): Promise<RawAd[]> { return this.ads.map((ad) => ({ ...ad, provider: "TEST_FIXTURE" })); }
}
