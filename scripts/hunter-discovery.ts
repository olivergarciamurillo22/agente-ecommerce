import "./env-loader";
import fs from "node:fs";
import path from "node:path";
import { runDiscovery } from "../src/lib/hunter/discovery/service";

function arg(name: string): string | null { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
async function main() {
  const token = (process.env.META_AD_LIBRARY_ACCESS_TOKEN ?? process.env.META_ADS_ACCESS_TOKEN ?? "").trim(); if (!token) throw new Error("Falta META_AD_LIBRARY_ACCESS_TOKEN con ads_read");
  const termsPath = path.resolve(arg("--terminos") ?? "config/hunter-discovery-terms.json");
  const parsed = JSON.parse(fs.readFileSync(termsPath, "utf8")) as { terms?: unknown };
  const terms = Array.isArray(parsed.terms) ? parsed.terms.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, 50) : [];
  if (!terms.length) throw new Error("El JSON no contiene terms[] validos");
  const country = (arg("--pais") ?? "ES").toUpperCase(); if (!/^[A-Z]{2}$/.test(country)) throw new Error("--pais debe ser ISO alpha-2");
  const days = Number(arg("--dias") ?? 14); if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--dias debe estar entre 1 y 90");
  const result = await runDiscovery({ terms, country, days, token });
  console.table(result.snapshots.map((s) => ({ pagina: s.pageName ?? s.pageId, anuncios_activos: s.activeAds,
    dias_mas_antiguo: s.oldestActiveAt ? Math.floor((Date.now() / 1000 - s.oldestActiveAt) / 86400) : "sin datos",
    momentum: s.momentum === "sin_historico" ? "sin historico" : s.momentum, ruido: s.noise ? `si: ${s.noiseReason}` : "no" })));
  console.log(`Crudos: ${result.rawCount} · pasan ruido: ${result.passedNoiseCount} · grupos: ${result.groupCount}`);
  console.log(result.rateLimit ? `Cabeceras de uso Meta: ${JSON.stringify(result.rateLimit)}` : "Meta no envio cabeceras de limite en esta consulta.");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
