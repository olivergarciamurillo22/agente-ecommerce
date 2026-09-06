// ============================================================
// AI Winner Radar — INFORME EJECUTIVO Y «QUÉ HARÍA HOY».
//
// El resultado de una búsqueda no es una lista: es una respuesta. Una lista
// de 38 productos ordenados por score sigue dejando todo el trabajo del lado
// de Pedro. El informe hace la parte que puede hacerse sola: qué se miró,
// qué salió, con qué empezar mañana y qué evitar.
//
// TODO EL INFORME SE CONSTRUYE CON CÓDIGO. La IA solo puede AÑADIR notas de
// mercado y pulir la redacción, y si no está configurada el informe sale
// entero igual. Un informe que depende de un modelo es un informe que un día
// aparece vacío sin que nadie sepa por qué.
//
// Y una línea que no se cruza: aquí no se llama «ganador» a nada. Se dice qué
// se ha OBSERVADO y qué se RECOMIENDA probar. La diferencia cuesta dinero.
// ============================================================

import { ask, extractJson, llmConfigured, stringList } from "./llm";
import { decideVerdict } from "./verdict";
import type { ProductOpportunity, RadarReport, SearchRun, TodayAction } from "./types";

/** Cuántas oportunidades entran en el podio de la portada. */
export const TOP_PICKS = 3;
/** Tope de acciones de «qué haría hoy»: una lista de 12 no la hace nadie. */
export const MAX_TODAY_ACTIONS = 5;

export async function buildReport(run: SearchRun, ops: ProductOpportunity[]): Promise<RadarReport> {
  const ordenadas = [...ops].sort((a, b) => (b.scores.opportunity.score ?? -1) - (a.scores.opportunity.score ?? -1));

  const testear = ordenadas.filter((o) => o.recommendation === "TESTEAR");
  const vigilar = ordenadas.filter((o) => o.recommendation === "VIGILAR");
  const descartar = ordenadas.filter((o) => o.recommendation === "DESCARTAR");

  const top = (testear.length > 0 ? testear : ordenadas).slice(0, TOP_PICKS);
  // «Para vigilar» NO puede repetir lo que ya está en el podio. Cuando no hay
  // nada testeable, el podio se rellena con los mejores —que son justo los
  // que merecen seguimiento—, y sin este filtro el mismo producto aparecía
  // arriba y abajo, y encima con dos consejos distintos.
  const enElPodio = new Set(top.map((o) => o.id));
  const watch = vigilar.filter((o) => !enElPodio.has(o.id)).slice(0, 8);

  const base: RadarReport = {
    headline: headlineFor(run, testear.length, ordenadas.length),
    summary: summaryLines(run, ordenadas, testear.length, vigilar.length),
    topPickIds: top.map((o) => o.id),
    watchIds: watch.map((o) => o.id),
    risks: riskLines(ordenadas, descartar, run),
    marketNotes: marketNotes(ordenadas),
    todayActions: todayActions(top, watch, descartar, run),
    generatedAt: Math.floor(Date.now() / 1000),
    aiGenerated: false,
  };

  if (!llmConfigured() || ordenadas.length === 0) return base;

  // La IA solo añade LECTURA de mercado. No toca contadores, ni el podio, ni
  // las acciones: eso ya está decidido con datos.
  const system =
    `Eres un analista de producto. Te doy hechos ya calculados sobre un mercado.\n` +
    `Devuelve SOLO este JSON: {"marketNotes":["2-4 observaciones de mercado, una frase cada una"]}\n` +
    `Reglas: NO inventes cifras (usa solo las dadas). NO llames "ganador" a nada. ` +
    `NO des consejos financieros. Español claro, sin jerga. Responde solo el JSON.`;
  const datos = [
    `Búsqueda: ${run.title ?? run.prompt ?? "sin título"}`,
    `Productos detectados: ${ordenadas.length}. Recomendados para test: ${testear.length}. Para vigilar: ${vigilar.length}.`,
    "",
    ...ordenadas.slice(0, 8).map((o) => {
      const s = o.signals;
      return `- ${o.canonicalName}: ${s.advertiserCount} anunciantes, ${s.activeAds} anuncios activos, ` +
        `saturación ${fmtScore(o.scores.saturation.score)}, momentum ${fmtScore(o.scores.momentum.score)}, ` +
        `oportunidad ${fmtScore(o.scores.opportunity.score)}`;
    }),
  ].join("\n");

  const json = extractJson(await ask(system, datos, { tier: "deep", maxTokens: 500, json: true }));
  const notas = stringList(json?.marketNotes, 4, 220);
  if (notas.length === 0) return base;
  return { ...base, marketNotes: notas, aiGenerated: true };
}

function fmtScore(n: number | null): string {
  return n === null ? "sin dato" : String(Math.round(n));
}

function headlineFor(run: SearchRun, testables: number, total: number): string {
  if (total === 0) return "No hemos encontrado productos con esta búsqueda";
  if (testables === 0) return `${total} producto${total === 1 ? "" : "s"} detectado${total === 1 ? "" : "s"}, ninguno listo para testear`;
  return `${testables} producto${testables === 1 ? "" : "s"} en zona de test`;
}

function summaryLines(run: SearchRun, ops: ProductOpportunity[], testables: number, vigilables: number): string[] {
  const out: string[] = [];
  const anuncios = run.progress.adsAnalyzed;
  const detectados = run.progress.productsDetected;

  out.push(
    `Analizamos ${miles(anuncios)} anuncio${anuncios === 1 ? "" : "s"} y detectamos ${miles(detectados)} producto${detectados === 1 ? "" : "s"}.`
  );
  if (ops.length !== detectados) {
    out.push(ops.length === 1
      ? `1 pasó tus filtros; ${miles(run.progress.candidatesDiscarded)} se descartaron por no cumplirlos.`
      : `${miles(ops.length)} pasaron tus filtros; ${miles(run.progress.candidatesDiscarded)} se descartaron por no cumplirlos.`);
  }
  if (testables > 0) out.push(`${testables} está${testables === 1 ? "" : "n"} en zona de test y ${vigilables} merece${vigilables === 1 ? "" : "n"} seguimiento.`);
  else if (vigilables > 0) out.push(`Ninguno está listo para gastar en un test; ${vigilables} merece${vigilables === 1 ? "" : "n"} seguimiento.`);

  if (run.coverage === "partial") {
    out.push("Cobertura parcial: alguna fuente no respondió, así que puede faltar mercado por ver.");
  }
  return out;
}

function riskLines(ops: ProductOpportunity[], descartados: ProductOpportunity[], run: SearchRun): string[] {
  const out: string[] = [];
  if (run.fixtureMode) out.push("Estos datos son de EJEMPLO: no sirven para decidir nada.");
  if (run.coverage === "partial" && run.progress.sourcesFailed.length > 0) {
    out.push(`No respondieron: ${run.progress.sourcesFailed.join(", ")}. Los números son un suelo, no un total.`);
  }

  const sinEconomia = ops.filter((o) => o.economics === null).length;
  if (sinEconomia > 0) {
    out.push(`${sinEconomia} producto${sinEconomia === 1 ? "" : "s"} sin coste de proveedor: de esos no se sabe si dejan margen.`);
  }
  const sinHistorico = ops.filter((o) => o.scores.momentum.score === null).length;
  if (sinHistorico === ops.length && ops.length > 0) {
    out.push("Es la primera vez que vemos estos productos: no hay tendencia todavía. Repite la búsqueda en una semana y la habrá.");
  }
  const saturados = descartados.filter((o) => (o.scores.saturation.score ?? 0) >= 70);
  if (saturados.length > 0) {
    out.push(`${saturados.length} descartado${saturados.length === 1 ? "" : "s"} por saturación: ${saturados.slice(0, 3).map((o) => o.canonicalName).join(", ")}.`);
  }
  return out.slice(0, 5);
}

function marketNotes(ops: ProductOpportunity[]): string[] {
  if (ops.length === 0) return [];
  const out: string[] = [];

  const anunciantes = ops.reduce((a, o) => a + o.signals.advertiserCount, 0);
  const activos = ops.reduce((a, o) => a + o.signals.activeAds, 0);
  out.push(`${miles(anunciantes)} anunciantes distintos y ${miles(activos)} anuncios activos en el conjunto analizado.`);

  const conPrecio = ops.filter((o) => o.observedPriceMax !== null);
  if (conPrecio.length >= 3) {
    const precios = conPrecio.map((o) => o.observedPriceMax as number).sort((a, b) => a - b);
    const mediana = precios[Math.floor(precios.length / 2)];
    out.push(`El precio observado más habitual ronda los ${mediana.toFixed(0)} €.`);
  }

  const enAlza = ops.filter((o) => (o.scores.momentum.score ?? 0) >= 65).length;
  if (enAlza > 0) out.push(`${enAlza} de ${ops.length} muestran crecimiento reciente de anuncios o anunciantes.`);

  return out;
}

/**
 * §18 — «Qué haría hoy». Sale de los productos reales y de sus bloqueos, no
 * de una plantilla. Si no hay nada que hacer, lo dice: inventar tareas para
 * llenar una sección es la forma más rápida de que se deje de leer.
 */
export function todayActions(
  top: ProductOpportunity[],
  watch: ProductOpportunity[],
  descartados: ProductOpportunity[],
  run: SearchRun
): TodayAction[] {
  const out: TodayAction[] = [];
  // UNA acción por producto. Decirle a Pedro «busca proveedor de X» y tres
  // líneas más abajo «vigila X siete días» no son dos tareas: son dos
  // consejos contradictorios sobre la misma cosa, y hacen que la lista deje
  // de leerse.
  const yaMencionado = new Set<string>();
  const anotar = (a: TodayAction) => {
    if (a.productId && yaMencionado.has(a.productId)) return;
    if (a.productId) yaMencionado.add(a.productId);
    out.push(a);
  };

  for (const o of top) {
    const v = decideVerdict(o);
    if (o.recommendation === "TESTEAR") {
      anotar({
        productId: o.id,
        productName: o.canonicalName,
        verb: "TESTEAR",
        text: `Testear ${o.canonicalName}`,
        because: v.because,
      });
    } else if (o.economics === null) {
      anotar({
        productId: o.id,
        productName: o.canonicalName,
        verb: "BUSCAR_PROVEEDOR",
        text: `Buscar proveedor y coste de ${o.canonicalName}`,
        because: "Es lo mejor que ha salido, pero sin coste no se puede saber si deja margen.",
      });
    }
  }

  for (const o of watch.slice(0, 2)) {
    if (out.length >= MAX_TODAY_ACTIONS) break;
    const dias = o.scores.momentum.score === null ? 7 : 5;
    anotar({
      productId: o.id,
      productName: o.canonicalName,
      verb: "VIGILAR",
      text: `Vigilar ${o.canonicalName} durante ${dias} días`,
      because: decideVerdict(o).because,
    });
  }

  const peor = descartados.find((o) => (o.scores.saturation.score ?? 0) >= 75);
  if (peor && out.length < MAX_TODAY_ACTIONS) {
    anotar({
      productId: peor.id,
      productName: peor.canonicalName,
      verb: "EVITAR",
      text: `Evitar ${peor.canonicalName}`,
      because: `Saturación ${Math.round(peor.scores.saturation.score as number)}/100: el CPA ya lo han subido otros.`,
    });
  }

  if (out.length === 0) {
    anotar({
      productId: null,
      productName: null,
      verb: "AMPLIAR_BUSQUEDA",
      text: run.progress.productsDetected === 0 ? "Probar con otras palabras" : "Aflojar algún filtro y repetir",
      because: run.progress.productsDetected === 0
        ? "No ha salido ningún producto: puede que el vocabulario no coincida con el que usan los anunciantes."
        : `Se detectaron ${run.progress.productsDetected} productos pero ninguno pasó los filtros. El más restrictivo suele ser el precio o el coste de proveedor.`,
    });
  }

  return out.slice(0, MAX_TODAY_ACTIONS);
}

function miles(n: number): string {
  return new Intl.NumberFormat("es-ES").format(n);
}
