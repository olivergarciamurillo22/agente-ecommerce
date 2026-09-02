// ============================================================
// Cazador de productos — TESTS DE CONTRATO.
//
// No es un runner: exporta `runProductHunterContractTests(assert)` que
// devuelve casos {name, fn} para engancharlos en tests/run-tests.ts.
// Sin red, sin DB, sin WhatsApp. Cada caso restaura el entorno al salir.
// ============================================================

import {
  createProductHunterDataSource,
  NotConfiguredError,
  productHunterAvailability,
  resetMockStore,
} from "./adapter";
import {
  assertCompareIds,
  computeCandidateMargin,
  findForbiddenMetricKeys,
  normalizeCandidate,
  ProductHunterInputError,
  SCORE_PENDING_LABEL,
  scoreLabel,
} from "./scoring";
import type { AdLibraryResult, WinnerScoreBreakdown } from "./types";

/** Subconjunto estructural de node:assert (vale el normal y el strict). */
export type ContractAssert = Pick<
  typeof import("node:assert"),
  "ok" | "equal" | "notEqual" | "deepEqual" | "throws" | "rejects" | "match" | "fail"
>;

export interface ContractTestCase {
  name: string;
  fn: () => Promise<void> | void;
}

const env = process.env as Record<string, string | undefined>;

/** Aplica variables solo durante fn() y SIEMPRE las restaura. */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const backup: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    backup[k] = env[k];
    if (overrides[k] === undefined) delete env[k];
    else env[k] = overrides[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(backup)) {
      if (backup[k] === undefined) delete env[k];
      else env[k] = backup[k];
    }
  }
}

/** Entorno de mock válido: fuera de producción, sin tocar NODE_ENV si ya vale. */
function mockEnv(): Record<string, string | undefined> {
  return {
    PRODUCT_HUNTER_SOURCE: "mock",
    PRODUCT_HUNTER_API_URL: undefined,
    NODE_ENV: env.NODE_ENV === "production" ? "test" : env.NODE_ENV,
  };
}

const RESULT_KEYS: ReadonlyArray<keyof AdLibraryResult> = [
  "id",
  "productName",
  "advertiser",
  "countries",
  "format",
  "cta",
  "startedAt",
  "activeDays",
  "variations",
  "landingUrl",
  "detectedPrice",
  "previewUrl",
  "adCopy",
  "dataStatus",
  "winnerScore",
];

export function runProductHunterContractTests(assert: ContractAssert): ContractTestCase[] {
  return [
    {
      name: "product-hunter: sin PRODUCT_HUNTER_SOURCE la fuente está apagada y no finge datos",
      fn: () =>
        withEnv({ PRODUCT_HUNTER_SOURCE: undefined, PRODUCT_HUNTER_API_URL: undefined }, async () => {
          const a = productHunterAvailability();
          assert.equal(a.available, false);
          assert.equal(a.source, "off");
          assert.match(a.reason, /PRODUCT_HUNTER_SOURCE=api/);
          const ds = createProductHunterDataSource();
          assert.equal(ds.source, "off");
          await assert.rejects(ds.search({ country: "ES", keywords: "x" }), (e: unknown) => e instanceof NotConfiguredError);
          await assert.rejects(ds.listSaved(), (e: unknown) => e instanceof NotConfiguredError);
          await assert.rejects(ds.compare(["a", "b"]), (e: unknown) => e instanceof NotConfiguredError);
        }),
    },
    {
      name: "product-hunter: el mock está PROHIBIDO en producción (NODE_ENV=production)",
      fn: () =>
        withEnv({ PRODUCT_HUNTER_SOURCE: "mock", NODE_ENV: "production" }, () => {
          const a = productHunterAvailability();
          assert.equal(a.available, false);
          assert.equal(a.source, "mock");
          assert.match(a.reason, /producción/);
          assert.throws(() => createProductHunterDataSource(), (e: unknown) => e instanceof NotConfiguredError);
        }),
    },
    {
      name: "product-hunter: valores raros de PRODUCT_HUNTER_SOURCE caen en 'off', nunca en mock",
      fn: () =>
        withEnv({ PRODUCT_HUNTER_SOURCE: "MOCK-ish", NODE_ENV: "production" }, () => {
          const a = productHunterAvailability();
          assert.equal(a.source, "off");
          assert.equal(a.available, false);
          assert.equal(createProductHunterDataSource().source, "off");
        }),
    },
    {
      name: "product-hunter: source=api sin URL → NotConfiguredError; con URL disponible y sin filtrar el token",
      fn: () =>
        withEnv({ PRODUCT_HUNTER_SOURCE: "api", PRODUCT_HUNTER_API_URL: undefined, PRODUCT_HUNTER_API_TOKEN: "secreto-de-test-xyz" }, async () => {
          const off = productHunterAvailability();
          assert.equal(off.available, false);
          assert.equal(off.source, "api");
          assert.throws(() => createProductHunterDataSource(), (e: unknown) => e instanceof NotConfiguredError);

          await withEnv({ PRODUCT_HUNTER_API_URL: "https://hunter.example.test/v1/" }, () => {
            const on = productHunterAvailability();
            assert.equal(on.available, true);
            assert.equal(on.source, "api");
            assert.equal(JSON.stringify(on).includes("secreto-de-test-xyz"), false, "el token jamás sale en la disponibilidad");
            assert.equal(createProductHunterDataSource().source, "api");
          });
        }),
    },
    {
      name: "product-hunter: la búsqueda mock devuelve datos PARCIALES honestos y ninguna métrica prohibida",
      fn: () =>
        withEnv(mockEnv(), async () => {
          resetMockStore();
          const ds = createProductHunterDataSource();
          assert.equal(ds.source, "mock");
          const page = await ds.search({ country: "ES", keywords: "", pageSize: 48 });
          assert.ok(page.results.length >= 5, "el mock trae varios resultados");
          for (const r of page.results) {
            for (const k of RESULT_KEYS) assert.ok(k in r, `falta la clave ${k} en ${r.id}`);
          }
          assert.ok(page.results.some((r) => r.dataStatus === "partial"), "hay resultados con dato parcial");
          assert.ok(page.results.some((r) => r.productName === null), "hay productos sin identificar (null, no inventado)");
          assert.ok(page.results.some((r) => r.detectedPrice === null), "hay precios no disponibles (null, no 0)");
          assert.ok(page.results.some((r) => r.winnerScore === null), "hay puntuaciones pendientes");
          assert.ok(page.results.some((r) => r.winnerScore?.reason?.startsWith("[MOCK]")), "el mock se etiqueta como mock");
          assert.ok(page.results.every((r) => !r.previewUrl || r.previewUrl.startsWith("data:image/svg+xml")), "previews inline, sin imágenes externas");

          const payload = JSON.parse(JSON.stringify(page)) as unknown;
          assert.deepEqual(findForbiddenMetricKeys(payload), []);
          // Y el detector detecta de verdad (para que el test anterior no pase por casualidad).
          assert.deepEqual(findForbiddenMetricKeys({ roas: 1 }), ["$.roas"]);
          assert.equal(findForbiddenMetricKeys({ a: [{ estimatedSales: 3 }] }).length, 1);
          assert.equal(findForbiddenMetricKeys({ suspendedAt: "x", conversionsCount: 1 }).length, 1, "'suspended' no es 'spend'; 'conversions' sí cuenta");
        }),
    },
    {
      name: "product-hunter: filtros del mock (país, formato, mínimo de días, palabras clave)",
      fn: () =>
        withEnv(mockEnv(), async () => {
          resetMockStore();
          const ds = createProductHunterDataSource();
          const videos = await ds.search({ country: "ES", keywords: "", creativeFormat: "video", minActiveDays: 30 });
          assert.ok(videos.results.length >= 1);
          assert.ok(videos.results.every((r) => r.format === "video" && r.activeDays !== null && r.activeDays >= 30));

          const pt = await ds.search({ country: "PT", keywords: "" });
          assert.ok(pt.results.length >= 1);
          assert.ok(pt.results.every((r) => r.countries.includes("PT")));

          const cocina = await ds.search({ country: "ES", keywords: "cocina" });
          assert.ok(cocina.results.length >= 1);
          assert.ok(
            cocina.results.every((r) => `${r.productName ?? ""} ${r.advertiser ?? ""} ${r.adCopy ?? ""}`.toLowerCase().includes("cocina"))
          );

          const paged = await ds.search({ country: "ES", keywords: "", pageSize: 2, page: 1 });
          assert.equal(paged.results.length, 2);
          assert.equal(paged.hasMore, true);
        }),
    },
    {
      name: "product-hunter: computeCandidateMargin devuelve null cuando faltan datos (nunca inventa)",
      fn: () => {
        const empty = computeCandidateMargin({ costEstimate: null, salePriceEstimate: null, shippingCost: null, returnCost: null });
        assert.equal(empty.grossMargin, null);
        assert.equal(empty.profitPerOrder, null);
        assert.match(empty.note, /Falta/);

        const noReturn = computeCandidateMargin({ costEstimate: 6.5, salePriceEstimate: 29.99, shippingCost: 5.5, returnCost: null });
        assert.equal(noReturn.grossMargin, 17.99);
        assert.equal(noReturn.profitPerOrder, null);
        assert.match(noReturn.note, /devolución/);

        const noPrice = computeCandidateMargin({ costEstimate: 6.5, salePriceEstimate: null, shippingCost: 5.5, returnCost: 4.5 });
        assert.equal(noPrice.grossMargin, null);
        assert.equal(noPrice.profitPerOrder, null);
      },
    },
    {
      name: "product-hunter: computeCandidateMargin es determinista (29,99 / 6,5 / 5,5 / 4,5 al 70 %)",
      fn: () => {
        const e = { costEstimate: 6.5, salePriceEstimate: 29.99, shippingCost: 5.5, returnCost: 4.5 };
        const a = computeCandidateMargin(e, 0.7);
        const b = computeCandidateMargin(e, 0.7);
        assert.equal(a.grossMargin, 17.99);
        assert.equal(a.profitPerOrder, 11.24);
        assert.deepEqual(a, b);
        assert.deepEqual(computeCandidateMargin(e), a, "el supuesto por defecto es 0,7");
        assert.equal(computeCandidateMargin(e, 1).profitPerOrder, 17.99);
        assert.equal(computeCandidateMargin(e, 0).profitPerOrder, null, "tasa 0 no es un supuesto válido");
        assert.equal(computeCandidateMargin(e, 1.5).profitPerOrder, null);
      },
    },
    {
      name: "product-hunter: guardar y mover registra decisiones con from/to y nota",
      fn: () =>
        withEnv(mockEnv(), async () => {
          resetMockStore();
          const ds = createProductHunterDataSource();
          const found = await ds.search({ country: "ES", keywords: "lámpara" });
          assert.equal(found.results.length, 1);
          const result = found.results[0];

          const saved = await ds.saveCandidate({ result, note: "  primera nota  " });
          assert.equal(saved.status, "saved");
          assert.notEqual(saved.savedAt, null);
          assert.equal(saved.decisions.length, 1);
          assert.equal(saved.decisions[0].from, null);
          assert.equal(saved.decisions[0].to, "saved");
          assert.equal(saved.notes.length, 1);
          assert.equal(saved.notes[0].text, "primera nota");

          const moved = await ds.moveCandidate(result.id, "researching", "probar con proveedor");
          assert.equal(moved.status, "researching");
          const last = moved.decisions[moved.decisions.length - 1];
          assert.equal(last.from, "saved");
          assert.equal(last.to, "researching");
          assert.equal(last.note, "probar con proveedor");
          assert.equal(moved.decisions.length, 2);

          const again = await ds.getCandidate(result.id);
          assert.equal(again?.status, "researching");
          const pipeline = await ds.listSaved({ status: ["researching"] });
          assert.ok(pipeline.some((c) => c.id === result.id));

          await assert.rejects(
            ds.moveCandidate(result.id, "volando" as unknown as "saved"),
            (e: unknown) => e instanceof ProductHunterInputError && e.code === "BAD_INPUT"
          );
          await assert.rejects(ds.moveCandidate("no_existe", "saved"), (e: unknown) => e instanceof ProductHunterInputError && e.code === "NOT_FOUND");

          // Las economías se sanean: negativos y basura → null, nunca un número inventado.
          const eco = await ds.setEconomics(result.id, {
            costEstimate: -3,
            salePriceEstimate: 19.9,
            shippingCost: Number.NaN,
            returnCost: 9.37,
          });
          assert.deepEqual(eco.economics, { costEstimate: null, salePriceEstimate: 19.9, shippingCost: null, returnCost: 9.37 });
          await assert.rejects(ds.addNote(result.id, "   "), (e: unknown) => e instanceof ProductHunterInputError);
        }),
    },
    {
      name: "product-hunter: comparar exige entre 2 y 4 ids únicos",
      fn: () =>
        withEnv(mockEnv(), async () => {
          resetMockStore();
          assert.throws(() => assertCompareIds(["mock_001"]), (e: unknown) => e instanceof ProductHunterInputError);
          assert.throws(() => assertCompareIds(["mock_001", "mock_001"]), (e: unknown) => e instanceof ProductHunterInputError, "duplicados no cuentan");
          assert.throws(() => assertCompareIds(["a", "b", "c", "d", "e"]), (e: unknown) => e instanceof ProductHunterInputError);
          assert.throws(() => assertCompareIds("mock_001,mock_002"), (e: unknown) => e instanceof ProductHunterInputError);
          assert.deepEqual(assertCompareIds([" mock_001 ", "mock_002"]), ["mock_001", "mock_002"]);

          const ds = createProductHunterDataSource();
          await assert.rejects(ds.compare(["mock_001"]), (e: unknown) => e instanceof ProductHunterInputError);
          await assert.rejects(ds.compare(["mock_001", "mock_002", "mock_003", "mock_005", "mock_006"]), (e: unknown) => e instanceof ProductHunterInputError);
          const cmp = await ds.compare(["mock_001", "mock_003", "mock_006"]);
          assert.equal(cmp.candidates.length, 3);
          assert.deepEqual(cmp.candidates.map((c) => c.id), ["mock_001", "mock_003", "mock_006"]);
        }),
    },
    {
      name: "product-hunter: Winner Score sin total se pinta como pendiente, nunca como 0",
      fn: () => {
        assert.equal(scoreLabel(null).text, SCORE_PENDING_LABEL);
        assert.equal(scoreLabel(null).pending, true);
        assert.equal(scoreLabel(undefined).pending, true);
        const noTotal: WinnerScoreBreakdown = { total: null, confidence: "low", analyzedAt: null, reason: null, signals: [] };
        assert.equal(scoreLabel(noTotal).text, SCORE_PENDING_LABEL);
        assert.equal(scoreLabel(noTotal).pending, true);
        const scored: WinnerScoreBreakdown = { total: 78.4, confidence: "high", analyzedAt: "2026-09-01T08:00:00.000Z", reason: null, signals: [] };
        assert.equal(scoreLabel(scored).text, "78");
        assert.equal(scoreLabel(scored).pending, false);
        assert.equal(scoreLabel(scored).confidence, "high");
      },
    },
    {
      name: "product-hunter: la normalización descarta claves prohibidas y rellena con null, no con ceros",
      fn: () => {
        const raw = {
          id: "x1",
          productName: "Cosa",
          roas: 3.2,
          sales: 120,
          estimatedProfit: 500,
          activeDays: "12",
          countries: ["es", 42, "pt"],
          status: "cualquiera",
          winnerScore: { total: "88", confidence: "alta", signals: [{ key: "cod_fit", value: 70 }, { key: "inventada", value: 1 }] },
        };
        const c = normalizeCandidate(raw);
        assert.ok(c);
        assert.deepEqual(findForbiddenMetricKeys(JSON.parse(JSON.stringify(c))), []);
        assert.equal(c.advertiser, null);
        assert.equal(c.detectedPrice, null);
        assert.equal(c.activeDays, 12);
        assert.deepEqual(c.countries, ["ES", "PT"]);
        assert.equal(c.dataStatus, "unknown");
        assert.equal(c.status, "discovered");
        assert.equal(c.winnerScore?.total, 88);
        assert.equal(c.winnerScore?.confidence, null);
        assert.equal(c.winnerScore?.signals.length, 1);
        assert.equal(c.winnerScore?.signals[0].missing, false);
        assert.equal(normalizeCandidate({ productName: "sin id" }), null);
      },
    },
  ];
}
