import { AdLibraryClient, probeAdLibraryFields } from "./client";
import { DiscoveryBudget, mergeRateLimits, type StopReason } from "./budget";
import { DiscoveryHaltedError, asAdLibraryError } from "./errors";
import { groupAds } from "./grouping";
import { canRunDiscovery } from "../../safety";
import { DiscoveryRepository } from "./repository";
import type { DiscoverySnapshot } from "./types";

/** Puente explicito hacia el Hunter predictivo; no calcula economia aqui. */
export function predictiveInputFor(snapshot: DiscoverySnapshot): { productQuery: string; sourceAdUrl: string | null } | null {
  if (snapshot.noise || snapshot.momentum !== "fuerte") return null;
  const ad = snapshot.ads[0];
  const text = [...ad.titles, ...ad.captions, snapshot.pageName ?? ""].map((value) => value.trim()).find(Boolean);
  return text ? { productQuery: text.slice(0, 200), sourceAdUrl: ad.snapshotUrl } : null;
}

export interface DiscoveryRunResult {
  snapshots: DiscoverySnapshot[];
  rawCount: number;
  groupCount: number;
  passedNoiseCount: number;
  rateLimit: Record<string, unknown> | null;
  fieldProbes: Awaited<ReturnType<typeof probeAdLibraryFields>>;
  /** Por qué terminó la corrida. "completado" = se agotaron los términos. */
  stopReason: StopReason;
  /** Términos que llegaron a consultarse (puede ser menos que los pedidos). */
  termsQueried: string[];
  requests: number;
  pages: number;
}

/**
 * Una corrida de descubrimiento. Cambios del 07-09
 * (docs/HUNTER-DISCOVERY-AUDITORIA.md):
 *
 *  - PERSISTE LO PARCIAL. Antes, cualquier error en el término 17 de 26 tiraba
 *    la corrida entera sin guardar una fila y sin dejar rastro, después de
 *    haber gastado la cuota. Ahora el bucle captura, anota el motivo de parada
 *    y guarda lo que haya.
 *  - PARA EN SECO CON UN TOKEN INVÁLIDO. Antes el sondeo se tragaba los 14
 *    errores, se quedaba con la lista de campos vacía y seguía consultando
 *    hasta morir. Un token caducado ahora se detecta en el sondeo.
 *  - AUDITA LO QUE DE VERDAD PIDIÓ. Antes guardaba la constante entera de
 *    campos, no los que sobrevivieron al sondeo: el registro mentía.
 *  - PRESUPUESTO. Fecha límite y tope de peticiones compartidos por toda la
 *    corrida, más la cuota que Meta declara en sus cabeceras.
 */
export async function runDiscovery(input: {
  terms: string[];
  country: string;
  days: number;
  token: string;
  now?: number;
  client?: AdLibraryClient;
  repository?: DiscoveryRepository;
  budget?: DiscoveryBudget;
  /** Se llama tras cada término: sirve para enseñar progreso en vivo. */
  onProgress?: (p: { term: string; index: number; total: number; ads: number; requests: number }) => void;
}): Promise<DiscoveryRunResult> {
  // GATE: se comprueba ANTES de tocar nada. Falla con su motivo; no devuelve
  // una corrida vacia que parezca "no hay competencia".
  if (!canRunDiscovery()) throw new DiscoveryHaltedError();
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const until = new Date(now * 1000).toISOString().slice(0, 10);
  const since = new Date((now - input.days * 86400) * 1000).toISOString().slice(0, 10);
  const client = input.client ?? new AdLibraryClient(input.token);
  const budget = input.budget ?? new DiscoveryBudget();

  const seed = input.terms[0];
  const fieldProbes = await probeAdLibraryFields(client, { term: seed, country: input.country, since, until }, undefined, budget);
  const fields = fieldProbes.filter((field) => field.status !== "error").map((field) => field.field);
  if (!fields.includes("id")) fields.unshift("id");
  if (!fields.includes("page_id")) fields.unshift("page_id");

  // Si TODOS los campos fallaron, no es que Meta rechace campos opcionales: es
  // que la consulta no funciona (token caducado o sin permiso sobre
  // /ads_archive). Seguir solo sirve para quemar la cuota.
  const errores = fieldProbes.filter((f) => f.status === "error");
  if (errores.length === fieldProbes.length && fieldProbes.length > 0) {
    const motivo = asAdLibraryError(new Error(errores[0].error ?? "error")).abortRun ? "token_invalido" : "error";
    const guardado = (input.repository ?? new DiscoveryRepository()).saveRun({
      terms: [], country: input.country, days: input.days, fields, rawCount: 0, groups: [], rateLimit: null, now,
      stopReason: motivo, requests: budget.requests,
    });
    return {
      snapshots: guardado, rawCount: 0, groupCount: 0, passedNoiseCount: 0, rateLimit: null, fieldProbes,
      stopReason: motivo as StopReason, termsQueried: [], requests: budget.requests, pages: 0,
    };
  }

  const all = [];
  const termsQueried: string[] = [];
  let rateLimit: Record<string, unknown> | null = null;
  let stopReason: StopReason = "completado";
  let pages = 0;

  for (const [index, term] of input.terms.entries()) {
    const freno = budget.check();
    if (freno) {
      stopReason = freno;
      break;
    }
    try {
      const result = await client.search({ term, country: input.country, since, until, fields, budget });
      all.push(...result.ads);
      termsQueried.push(term);
      pages += result.pages;
      rateLimit = mergeRateLimits(rateLimit, result.rateLimit);
      input.onProgress?.({ term, index, total: input.terms.length, ads: all.length, requests: budget.requests });
      if (result.stopReason !== "completado") {
        stopReason = result.stopReason;
        break;
      }
    } catch (err) {
      // Token inválido o permiso: no hay nada que salvar consultando más.
      const error = asAdLibraryError(err);
      stopReason =
        error.kind === "token_invalido" ? "token_invalido"
        : error.kind === "permiso" ? "permiso"
        : error.kind === "parada_emergencia" ? "parada_emergencia"
        : "error";
      break;
    }
  }

  const unique = [...new Map(all.map((ad) => [ad.id, ad])).values()];
  const groups = groupAds(unique, now, input.country);
  const snapshots = (input.repository ?? new DiscoveryRepository()).saveRun({
    terms: termsQueried.length ? termsQueried : input.terms,
    country: input.country,
    days: input.days,
    fields, // los que de verdad se pidieron, no la constante entera
    rawCount: unique.length,
    groups,
    rateLimit,
    now,
    stopReason,
    requests: budget.requests,
  });
  return {
    snapshots,
    rawCount: unique.length,
    groupCount: groups.length,
    passedNoiseCount: groups.filter((g) => !g.noise).length,
    rateLimit,
    fieldProbes,
    stopReason,
    termsQueried,
    requests: budget.requests,
    pages,
  };
}
