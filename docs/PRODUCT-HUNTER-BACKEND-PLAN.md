# Cazador de productos — backend interno: plan e inventario (08-09-2026)

Rama `feat/product-hunter-backend` desde `release/casamable-v4.3` @ `24eb6c0`.
Este documento es la F1 del encargo: qué hay, qué contrato hay que cumplir,
qué dato real alimenta cada campo y qué queda declarado como no disponible.
Las decisiones de aquí mandan sobre el código de las fases siguientes.

## 0 · Decisión de arquitectura

**`PRODUCT_HUNTER_SOURCE=internal`** (valor nuevo). Un adaptador dentro del
mismo proceso Next (`src/lib/product-hunter/internal/`) que implementa la
interfaz `ProductHunterDataSource` leyendo y escribiendo SQLite. Sin fetch
HTTP saliente, sin `PRODUCT_HUNTER_API_URL` ni `PRODUCT_HUNTER_API_TOKEN`.

Por qué no reutilizar `api`: `api` significa «proxy HTTP a un backend externo
con seis endpoints» (`RealAdapter`). Ese backend no existe y nadie lo va a
construir a corto plazo; mantener el nombre con otra semántica habría dejado
dos comportamientos bajo una misma palabra. `api` se conserva tal cual por si
algún día existe; `mock` sigue siendo solo desarrollo; `off` sigue siendo el
default.

`internal` funciona en producción sin ninguna credencial nueva: lo que no
tenga fuente (token de Ad Library caducado, Dropea sin API key) se declara
en la respuesta, no bloquea el módulo entero.

## 1 · Contrato exacto que hay que implementar

Interfaz `ProductHunterDataSource` (`src/lib/product-hunter/types.ts`):

| Método | Entrada | Salida |
|---|---|---|
| `search(params)` | `AdLibrarySearchParams { country; keywords; category?; platform?; creativeFormat?; activeOnly?; startedAfter?; minActiveDays?; sort?; page?; pageSize?; advanced? }` | `AdLibrarySearchPage { results: AdLibraryResult[]; page; pageSize; total: number\|null; hasMore }` |
| `getCandidate(id)` | `string` | `WinningProductCandidate \| null` (404 → `null`) |
| `listSaved(filters?)` | `ProductHunterFilters { status?[]; country?; minScore?; saturation? }` | `SavedCandidate[]` (`savedAt` garantizado, `status ≠ discovered`) |
| `saveCandidate(input)` | `SaveCandidateInput { result: AdLibraryResult; note? }` | `SavedCandidate` (status `saved`, decisión `→ saved`, nota si venía) |
| `moveCandidate(id, status, note?)` | `ProductResearchStatus` | `WinningProductCandidate` con la decisión `{at, from, to, note}` añadida |
| `addNote(id, text)` | texto no vacío | `WinningProductCandidate` |
| `setEconomics(id, economics)` | `CandidateEconomics { costEstimate; salePriceEstimate; shippingCost; returnCost }` (todos `number\|null`) | `WinningProductCandidate` |
| `compare(ids)` | 2–4 ids | `CandidateComparison { ids; candidates; comparedAt }` |

`AdLibraryResult` (lo que devuelve `search` y la base de todo candidato):

```
id, productName, advertiser, countries[], format (video|image|carousel|null),
cta, startedAt (ISO), activeDays, variations, landingUrl, detectedPrice
{amount, currency}|null, previewUrl, adCopy, dataStatus (complete|partial|unknown),
winnerScore: WinnerScoreBreakdown|null
```

`WinnerScoreBreakdown { total: 0-100|null; confidence: low|medium|high|null;
analyzedAt; reason; signals: WinnerScoreSignal[] }` con 11 claves fijas
(`WINNER_SIGNAL_KEYS`), cada una `{ key, label, value 0-100|null, weight|null,
observed, missing }`.

`WinningProductCandidate = AdLibraryResult + { status, economics|null,
notes[], decisions[], savedAt|null, risks[], saturation|null }`.

La ruta `src/app/api/product-hunter/route.ts` (`?op=availability|search|
candidates|candidate|compare` y `POST {op: save|move|note|economics}`) no
cambia de contrato; solo se le añaden los campos manuales de F3.

## 2 · Fuentes reales y mapeo campo a campo

### 2a · `product_candidates` (hunter:add / hunter:score, esquema 19)

| Columna | Campo del contrato | Nota |
|---|---|---|
| `id` | `id = "local:<id>"` | |
| `nombre_limpio` | `productName` | |
| `source_domain` | `advertiser` | es el dominio de origen, no un anunciante: se etiqueta en `adCopy` |
| `source_url` | `landingUrl` | |
| `coste_unitario_eur`, `peso_gramos`, `largo/ancho/alto_cm`, `pvp_entrada_eur` | `facts` (campo nuevo, ver §4) | son los hechos que necesita `hunter:score` |
| `score`, `veredicto`, `margen_unitario_eur`, `cpa_maximo_eur`, `motivos_json` | `hunterScore` (campo nuevo, ver §4) | motor `src/lib/hunter/scoring.ts`, no se reimplementa |
| `estado` (nuevo/descartado/en_prueba/ganador) | no se mapea al `status` del pipeline | dos pipelines distintos; el del contrato vive en `hunter_pipeline` |
| — | `countries`, `format`, `cta`, `startedAt`, `activeDays`, `variations`, `previewUrl`, `detectedPrice` | **null**: un candidato local no viene de un anuncio |

### 2b · Discovery de Ad Library (`adlib_candidates` + `adlib_candidate_snapshots`, esquema 21–30)

Se lee el **último snapshot no ruido** de cada candidato (`noise=0`),
filtrando por país (prefijo `PAIS:` de `candidate_key`) y por término contra
`page_name` y los textos de `ads_json`.

| Origen | Campo del contrato | Nota |
|---|---|---|
| `candidate_key` | `id = "adlib:<candidate_key>"` | |
| primer `ad_creative_link_titles` / primer cuerpo recortado | `productName` | texto **declarado** por el anunciante |
| `page_name` | `advertiser` | |
| `DiscoveryRepository.countriesForCandidate` | `countries` | «donde lo hemos buscado y encontrado», no alcance real |
| `oldest_active_at` | `startedAt`, `activeDays` | |
| `creativeVariants(ads)` (signals.ts) | `variations` | |
| `declaredDomains(ads)[0]` | `landingUrl = "https://<dominio>"` | dominio de visualización declarado en el caption; no se visita |
| primer `ad_snapshot_url` | `previewUrl` | enlace a la ficha del anuncio en Meta, no el creativo |
| cuerpos + títulos | `adCopy` | |
| parser de precios sobre `adCopy` (F6a) | `detectedPrice` | «precio detectado en el anuncio», nunca confirmado |
| `active_ads`, `momentum`, señales | `winnerScore` | ver §3 |
| — | `format`, `cta` | **null**: la Ad Library no devuelve media ni CTA en los campos que pedimos |
| — | `dataStatus` | `partial` siempre (faltan format/cta/precio confirmado) |

### 2c · Catálogo de Dropea (`GET /dropshipper/products`, contrato documentado)

Lo documentado y tipado hoy (`DropeaProductVariant`): `variant_id`, `sku`,
`name`, `price` (lo que pagamos), `recommended_sale_price`, `currency?`,
`stock?`; y por producto `id`, `name`, `status`. **No hay peso ni medidas en
el contrato conocido**: se declaran `null` y F3 (entrada manual) sigue siendo
necesaria también para productos de Dropea. **No hay parámetro de búsqueda**:
solo `page`/`limit` (máximo observado 100), y el catálogo real tenía 4.142
productos (`scripts/dropea-mapping-inspect.ts`). Por eso la búsqueda no va a
la API en vivo: se sincroniza una copia local (`dropea_catalog`) con un CLI y
el panel busca en la copia, enseñando la fecha de la sincronización.

| Origen | Campo del contrato |
|---|---|
| `variant_id` | `id = "dropea:<variant_id>"` |
| `variants[].name` (o `product.name`) | `productName` |
| `"Dropea"` | `advertiser` |
| `price` | `facts.unitCostEur` (coste mayorista **real**) |
| `recommended_sale_price` | `economics.salePriceEstimate` sugerido; PVPR de Dropea, etiquetado |
| — | todo lo de anuncio (`countries`, `startedAt`, `activeDays`, `variations`, `previewUrl`, `adCopy`, `detectedPrice`) → **null** salvo que exista un cruce (F6a) |

### 2d · Cruces Dropea × Ad Library (F6a, tabla nueva `hunter_cruces`)

Un cruce es un producto de Dropea + el mejor grupo de anuncios que casa por
texto + precio detectado + score. Se expone como resultado con
`id = "cruce:<id>"`, `productName` de Dropea, `advertiser` de la página que
anuncia, señales de anuncio del grupo y `winnerScore` = Score de Oportunidad
Validada (fórmula en §3b).

## 3 · Scores: fórmulas explícitas

### 3a · `winnerScore` de un resultado de Ad Library (F2)

Solo con señales que existen; el resto `missing: true` y fuera del total.

| Señal | Valor 0–100 | Peso |
|---|---|---|
| `ad_age` | `min(100, activeDays / 90 × 100)` | 40 |
| `creative_variations` | `min(100, variations / 5 × 100)` | 25 |
| `advertiser_similar_ads` | `min(100, activeAds / 10 × 100)` | 20 |
| `multi_country` | `min(100, países_vistos / 3 × 100)` | 15 |
| resto (`landing_quality`, `offer_clarity`, `price_potential`, `saturation`, `cod_fit`, `margin_potential`, `active_continuity`) | `null`, `missing` | 0 |

`total = Σ valor×peso / Σ pesos_medidos`; `confidence`: `low` con ≤2 señales
medidas, `medium` con 3, `high` con 4 (nunca más: no hay más datos). El
`reason` lo dice en texto. Momentum «fuerte» no suma puntos: se enseña como
`observed` de `active_continuity` con su traza, porque compara contra una
fecha que el usuario tiene que ver (`docs/HUNTER-DISCOVERY-AUDITORIA.md`).

### 3b · Score de Oportunidad Validada (F6a)

Detalle, pesos y ejemplo numérico en `docs/PRODUCT-HUNTER-BACKEND-USO.md`
§cruce, escritos junto con la implementación (F6a). Principios fijados aquí:

- coste = `dropea_catalog.cost_eur` (exacto);
- precio de competencia = **solo** si el parser lo detecta en el texto del
  anuncio (`detected_price_source = "anuncio"`); si no, margen «no
  calculable — falta precio de competencia» y la parte de margen queda
  `missing`, nunca estimada;
- momentum y señales de anuncio: `computeMomentum`, `creativeVariants`,
  `oldestActiveAt` del discovery, importados, no reimplementados;
- confianza del emparejamiento por texto (Jaccard de palabras clave entre el
  nombre de Dropea y el texto del anuncio) penaliza el total; con una sola
  palabra genérica coincidente el match es `dudoso`;
- sin match en Ad Library: el cruce se guarda como «sin validar» con score
  bajo y motivo, no se descarta en silencio.

## 4 · Cambios de contrato (aditivos, en este repo)

`WinningProductCandidate` gana dos campos opcionales que los normalizadores
copian tal cual (antes los habrían tirado):

- `facts: { unitCostEur, salePriceEur, weightGrams, lengthCm, widthCm,
  heightCm, source: "manual"|"dropea"|"scraping"|null } | null` — los hechos
  logísticos con su origen;
- `hunterScore: { score, verdict, unitMarginEur, maxCpaEur, breakEvenDeliveryPct,
  shippingTier, reasons[] } | null` — el resultado del motor `hunter:score`
  cuando hay un `product_candidates` enlazado.

`SaveCandidateInput` gana `facts?` (los mismos campos manuales) para F3 desde
el panel. `AdLibrarySearchParams.advanced.source` acepta
`"ad_library" | "dropea" | "cruce" | "local"` (default: `ad_library` +
`local`, unidos).

## 5 · Persistencia: migración 31 (`migrateProductHunterInternal`), aditiva

Una sola migración, declarada aquí, con tres tablas nuevas:

- `dropea_catalog` — copia local del catálogo: `variant_id` PK, `product_id`,
  `sku`, `name`, `product_name`, `cost_eur`, `recommended_price_eur`,
  `currency`, `stock`, `status`, `raw_json`, `synced_at`.
- `hunter_pipeline` — el pipeline del contrato: `id` TEXT PK
  (`local:|adlib:|dropea:|cruce:`), `source`, `result_json`
  (`AdLibraryResult`), `status`, `economics_json`, `notes_json`,
  `decisions_json`, `risks_json`, `saturation`, `saved_at`,
  `product_candidate_id` (FK lógica a `product_candidates`), `created_at`,
  `updated_at`.
- `hunter_cruce_runs` + `hunter_cruces` — F6a: corridas (fecha, categoría,
  límite, procesados, peticiones, parada) y cruces (producto Dropea, términos,
  match y confianza, grupo de anuncios, precio detectado, coste, margen,
  score con desglose, `captured_at`).

`SCHEMA_VERSION` pasa de 30 a 31. No se mezcla con ninguna otra migración.

## 6 · Lo que el contrato pide y NO se puede hacer honestamente

- `format` (vídeo/imagen/carrusel) y `cta`: la Ad Library no los devuelve en
  `ads_archive` con los campos que pedimos. Siempre `null`.
- `landingUrl` real: solo el dominio **declarado** en el caption. No se visita.
- Precio de competencia confirmado: solo «detectado en el texto del anuncio».
  Visitar la landing del competidor queda como mejora futura, no se hace.
- `saturation` y `risks`: no hay dato que los alimente; `null` / `[]`. Un
  número de anunciantes por término sí existe (`group_count` de
  `adlib_queries`), pero convertirlo en «saturación baja/alta» sería un
  umbral inventado; se deja fuera y se dice.
- Peso y medidas de Dropea: no están en el contrato conocido de su API. Si la
  respuesta real los trae, se conservan en `raw_json` para poder mapearlos
  después, pero no se afirman.
- Cualquier métrica de ventas/ROAS/gasto: prohibida por el contrato y por la
  fuente.

## 7 · Orden de trabajo y commits (hecho el 08-09-2026)

Lo implementado y cómo se usa está en `PRODUCT-HUNTER-BACKEND-USO.md`. Dos
ajustes respecto al plan, decididos al probar: (a) el cruce funde los grupos
del discovery por página anunciante antes de casar (la unidad es el
anunciante, no la línea de producto); (b) una sola palabra clave coincidente
es «dudoso» sea cual sea la cobertura, y nunca «si».

Orden previsto:

1. F1 (este documento) · 2. F2b catálogo Dropea + migración 31 + adaptador
`internal` con búsqueda · 3. F2 búsqueda Ad Library + local · 4. F3 hechos
manuales (CLI y panel) · 5. F4 economics/compare con el motor existente ·
6. F6a cruce (motor, CLI, panel, tests) · 7. F5 Studio, F6 `.env`, F7 docs.
Suite y typecheck en verde antes de cada commit.
