# Evaluación: PI Engine (`hunter-end-to-end-v1`) frente al Hunter canónico (07-09-2026)

**Solo análisis. No se ha mergeado ni implementado nada.** Rama analizada:
`hunter-end-to-end-v1` (`src/lib/product-intelligence/`, 1.161 líneas en 19
ficheros + `providers/`). Referencia: `release/casamable-v4.3`
(`src/lib/hunter/`, 949 líneas: `scoring.ts`, `discovery/`, `predictive/`).

**Conclusión en una frase:** no portar el PI Engine; extraer cuatro piezas
pequeñas (redacción de secretos, gobierno de cuota Meta, dos reglas de ruido,
delta de momentum como razón legible) y descartar el resto, que o ya existe
en el Hunter con mejor calidad o contradice su regla «sin evidencia no hay
afirmación» (`HUNTER-SPEC.md`).

## 1 · Capacidad por capacidad

| Capacidad (PI Engine) | Qué hace exactamente | ¿Existe en Hunter? | Veredicto |
|---|---|---|---|
| `momentum.ts` `calculateMomentum` | Compara el snapshot actual con el anterior: `activeAds ≥ 5 && delta ≥ 2 && newAds ≥ 2 && oldAdsStillActive > 0` → STRONG_GROWTH **85**; `delta > 0 \|\| newAds > 0` → GROWTH **65**; `delta < 0 \|\| removed > 0` → DECLINING **10**; resto STABLE **40**; sin previo → 0 | **Sí.** `discovery/repository.ts:18-20`: misma regla 5/2 → `fuerte`/`debil`/`sin_datos`/`sin_historico`, persistida en `adlib_candidate_snapshots.momentum` con `previous_active_ads` | **Redundante.** El PI añade dos ramas (DECLINING, `newAds`) y cuatro scores literales sin origen. Lo único valioso (los `components` = deltas) se puede exponer en Hunter como razón legible (ver §4) |
| `noise.ts` `classifyNoise` | 5 reglas de texto, cero umbrales numéricos (detalle §2) | **Parcial.** `discovery/grouping.ts:8-17` `noiseOf`: regex `NON_PRODUCT` (app, software, curso, seguro…) + `maxAudience ≥ 1.000.000` (regla que el PI no tiene) + normalización de acentos (el PI no normaliza) | **Portar parcial:** solo el `Set` de marcas grandes y el regex de infoproductos (`ebook`, `webinar`, `masterclass`, `membresía`…) como dos reglas más de `noiseOf`. El resto ya está |
| `diff-engine.ts` `diffObservations` | Señales de cambio: `CREATIVE_SPIKE` (+3 anuncios en 7 d), `SCORE_SPIKE` (+10), `SCORE_DROP` (−10), `LIFECYCLE_CHANGE` | **No.** Hunter guarda `candidate_events` con `previous_score/next_score`, sin señales | **Descartar.** Dentro del PI es código muerto: solo lo importa un test; la lógica productiva está duplicada en `state.ts:27-34` |
| `clustering.ts` fingerprint + Jaccard | Normaliza (NFD, stopwords ES, alias `juanetes→hallux`, `ferula→corrector`), Jaccard ≥ 0,75 HIGH / ≥ 0,5 MEDIUM; clave de anunciante `page:`/`domain:`/`name:` | **Sí.** `discovery/grouping.ts:4-32`: misma normalización, misma Jaccard (umbral 0,55), agrupación por `pageId`, fingerprint hasheado a clave estable | **Redundante**, salvo el diccionario de alias y las stopwords ES (dos constantes) |
| `scoring.ts` Opportunity Score + lifecycle + recomendación | 10 pesos que suman 1,00 (`config.ts:12-21`) sobre entradas 0–100; lifecycle por umbrales (75/12, 25/25, 70/60, 70/65, 50/5); TEST_NOW ≥ 80, WATCHLIST ≥ 65, RESEARCH ≥ 45 | **No comparable.** Hunter puntúa economía COD real: margen/CPA/variantes/ticket/recompra (40/35/0/10/10/5) con cada constante trazada a Pedro | **Descartar.** Con datos de Meta, `casamableFit=65`, `creativePotential=60`, `logistics=65` son literales fijos (`engine.ts:51-55`) y `economics=0` porque el provider nunca rellena `price`: ~22 puntos idénticos para todo candidato. `HUNTER-VS-PI-ENGINE.md` ya prohíbe sumar o promediar ambos scores |
| `predictive.ts` `estimatePredictiveEconomics` | Rango min/max por fuente, mayorista más cercano a 100/500 uds, **logística 6,48 € (≤1 kg) / 8,90 € (≤4 kg)**, veredicto DESCARTAR / INVESTIGAR / CANDIDATO_FUERTE (margen peor ≥ 8 €), TTL 30 días | **Sí, casi línea a línea.** `predictive/estimate.ts`: misma fórmula, mismo umbral 8 €, mismo TTL, pero logística = `PICKING_EUR + COD_FEE_EUR + tramo(peso)` = 5,90–6,10 € con fuente (contrato Beeping), y persistida en `hunter_predictive_estimates` | **Descartar.** Misma función con dos números peores: 6,48/8,90 € no tienen fuente y contradicen la tabla de tramos confirmada |
| `predictive.ts` scraping público (AliExpress, 1688, Alibaba) | UA `Casamable-Hunter-Predictivo/1.0`, timeout 7 s, 2 intentos, 2 MiB, detección de bloqueo (401/403/429/login/captcha), límite 1–20 | **Sí, es el mismo fichero reescrito.** `predictive/scraping-publico.ts`: misma UA literal, mismos límites, mismo flag `HUNTER_PREDICTIVE_SEARCH_SOURCE`; además valida `content-length`, captcha en chino y promedia precios | **Redundante y peligroso:** activar ambos con el mismo env var duplicaría las peticiones a las tres tiendas |
| `predictive.ts` `HttpPredictiveProvider` | POST JSON con Bearer opcional, 20 s, solo https | **Sí y mejor.** `predictive/search.ts` añade allowlist de dominios mayoristas | **Redundante** |
| `providers/meta-ad-library-provider.ts` | Cliente `ads_archive` con cursor, **presupuesto por hora y por ciclo**, **backoff exponencial + jitter + `cooldownUntil` ante 429 y códigos 4/17/613**, `x-app-usage`, `healthCheck`, `auditFields` | **Sí, salvo la cuota.** `discovery/client.ts`: mismo endpoint, 20 páginas con pausa 1 s, timeout 20 s, lee cabeceras de uso, `probeAdLibraryFields` ≈ `auditFields`. **Sin** presupuesto ni backoff ante rate-limit | **Portar como pieza independiente: solo el gobierno de cuota** (presupuesto + backoff + cooldown). Es lo que evita que Meta corte el token |
| `provider.ts` (Manual / Unconfigured / TestFixture) | Providers desde JSON local, vacío y fixture de tests | **No** (Hunter inyecta `fetch` en tests) | **Descartar:** la inyección de `fetch` es más simple que un tercer tipo de provider |
| `creative-cache.ts` | Caché JSON de análisis de creatividades por sha256, sin TTL ni límite | **No** | **Descartar:** código muerto en el propio PI (nadie llama a `get/setCreativeAnalysis`) |
| `redaction.ts` | Sustituye `Bearer…`, `access_token…`, `app_secret…`, `cookie…` por `[REDACTED]` y poda claves `/token\|secret\|authorization\|cookie/i` recursivamente | **No.** Hunter guarda `ads_json` y `rate_limit_json` crudos en `adlib_candidate_snapshots` | **Portar como pieza independiente.** 10 líneas, cero dependencias, y el Hunter sí persiste payloads de terceros sin filtrar. El mejor candidato del inventario |
| `persistence.ts` / `state.ts` / `repository.ts` / `pipeline-repository.ts` | **Sin SQLite ni versión de esquema**: 4 ficheros JSON en `DATA_DIR` con lock por `open("wx")`, `.bak`, `fsync`, recuperación de corruptos; sesiones y runs recortados a 100; watchlist | **Distinto por diseño.** Hunter: `better-sqlite3`, transacciones, `user_version` 24, guarda `assertSchemaNotNewer`. Watchlist no existe (estados `nuevo/descartado/en_prueba/ganador`) | **Descartar el almacén.** El lock usa `Atomics.wait` sobre `SharedArrayBuffer` (`persistence.ts:20`): espera bloqueante del event loop dentro de Next.js. Reescribe el JSON entero por iteración. Si hiciera falta «watchlist», es un estado más en `product_candidates` |
| `export.ts` | Tres `JSON.stringify` (dossiers, watchlist, reporte diario) | No (Hunter expone por API/CLI) | **Descartar:** en SQLite es un `SELECT` |
| `engine.ts` `analyzeAds` (derivación de señales) | `metaValidation = min(100, ads·12 + anunciantes·8)`, `longevity = oldest·2`, `creativeVelocity = recent·18`, `saturation = 100 − (anunciantes·8 + …)`, `pain = 80 si /dolor\|problema\|alivia…/ si no 50`, constantes 60/65/65, `penalties = 25 si ruido` | **Parcial** (solo la agrupación). El resto **no existe a propósito**: `HUNTER-SPEC.md` no puntúa demanda, competencia ni saturación | **Descartar:** contradice la regla 7 del Hunter. Además el pipeline destruye su propia entrada: persiste `newAds7d = round(creativeVelocity/18)` sobre un valor ya topado en 100 (`engine.ts:48` vs `:156`), y `newAds14d` no se mide en ningún sitio |
| `engine.ts` `runResearch` + `calculateQueryScore` + `expand` | BFS por prioridad: 12 queries/run, profundidad 2, 5 hijos; `queryScore = productos·15 + anunciantes·8 + oportunidad·0,45 − duplicados·35 − vacíos·10`; poda si duplicados ≥ 0,9; semillas en `config/hunter-search-terms/casamable-60-plus-es.json` | **No.** `discovery/service.ts` es un bucle plano sobre términos | **Portar como pieza independiente (candidato débil).** Única capacidad realmente ausente, pero acoplada al Opportunity Score. Solo tiene sentido reescribiendo `queryScore` sobre señales del Hunter (grupos nuevos, tasa de duplicados) |
| `pipeline.ts` `runHunterPipeline` | Orquesta research → predictivo sobre los 10 mejores por Opportunity Score, ventana 1–90 días (default 14), `autoHunt24x7: OFF`, `decisionEligible = false` | **Parcial.** `discovery/service.ts` + `predictiveInputFor`, que exige `!noise && momentum === "fuerte"` y no copia scores | **Redundante** (y el puente del Hunter es más estricto) |
| `smoke-test.ts` | `healthCheck` + research de prueba | **Sí.** `scripts/hunter-discovery-doctor.ts` | **Redundante** |
| `types.ts` (180 líneas, `ProductFinding` con 34 campos) | Tipos con veredictos en MAYÚSCULAS | Hunter: 151 líneas en tres ficheros, veredictos en minúscula con `CHECK` en SQLite | **Descartar** |

## 2 · Foco: ¿es «momentum auditable»?

**No del todo.** Emite componentes numéricos (`deltaActiveAds`, `deltaCreatives`,
`newAds`, `removedAds`, `oldAdsStillActive`, `daysBetweenSnapshots`) y los
propaga al snapshot, que es más de lo que el Hunter guarda hoy (etiqueta +
`previous_active_ads`). Pero:

1. **No dice qué regla disparó.** Devuelve `{ status, score, components }`, nunca una razón. El scoring del Hunter sí construye `reasons[{factor, points, detail}]` («9,6 € frente a 7,77 € históricos»).
2. **El score no se deriva de nada:** 85/65/10/40 son literales (`momentum.ts:20-23`). `delta = +1` y `delta = +40` reciben el mismo 65, que luego pesa 0,14 del Opportunity Score y decide el lifecycle.
3. **No hay ventana temporal.** `daysBetweenSnapshots` se calcula y **no se usa en ninguna condición**; el «anterior» es el último snapshot sin filtro de antigüedad (`engine.ts:41`). Comparar con ayer o con hace seis meses da el mismo veredicto.
4. **Se corrompe al persistir:** `newAds7d = round(creativeVelocity/18)` con `creativeVelocity` topado en 100 → cualquier producto con más de 5 anuncios recientes se guarda como 6, y ese 6 alimenta el momentum del ciclo siguiente.

### `noise.ts`: todas las reglas con su literal

| # | Regla | Literal | Razón |
|---|---|---|---|
| 1 | Marca grande | igualdad exacta con `amazon, ikea, lidl, carrefour, decathlon, mediamarkt, el corte inglés, temu, aliexpress`; solo mira `ads[0].advertiserName` | `LARGE_ESTABLISHED_BRAND` |
| 2 | No físico | `/\b(ebook\|e-book\|infoproducto\|webinar\|masterclass\|membresía\|plantilla digital)\b/i` | `NON_PHYSICAL_PRODUCT` |
| 3 | App/digital | `/\b(app\|aplicación móvil\|software\|saas\|suscripción digital\|descarga digital)\b/i` | `APP` |
| 4 | Servicio | `/\b(consulta\|consultoría\|curso\|formación\|agencia\|seguro\|abogado\|clínica\|tratamiento presencial\|reserva cita)\b/i` | `SERVICE` |
| 5 | Señal insuficiente | no casa `/\b(compra\|precio\|oferta\|envío\|entrega\|producto\|corrector\|almohada\|cepillo\|limpiador\|soporte\|dispositivo\|pack\|unidad)\b/i` **y** ningún ad tiene `productName \|\| title \|\| landingUrl` | `INSUFFICIENT_PRODUCT_SIGNAL` |

Cero umbrales numéricos. Defectos: la regla 1 solo mira el primer anuncio y exige igualdad exacta («Amazon España» no casa); las reglas 2–4 llevan tildes en el regex pero el texto no se normaliza («consultoria» escapa); la regla 5 nunca dispara con datos de Meta porque `landingUrl` siempre se rellena con `ad_snapshot_url`. El Hunter normaliza antes de aplicar el regex y sí tiene un umbral numérico (audiencia ≥ 1 M).

## 3 · Números sin fuente en el PI Engine (ninguno lleva comentario de origen)

- `momentum.ts:20-23`: 5, 2, 2 y los scores 85/65/10/40.
- `clustering.ts:12`: 0,75 / 0,5; `:3-4` stopwords y alias.
- `config.ts:4-10`: 12 queries/run, profundidad 2, score mínimo 20, 5 hijos, 0,75, 3 vacíos seguidos, 0,9 duplicados, 5 queries iniciales, 2 páginas, 20 llamadas; `:12-21` los **10 pesos** (0,14/0,10/0,10/0,14/0,08/0,09/0,14/0,11/0,05/0,05); `:30-36` 3 páginas, 150 ads, 20 llamadas/ciclo, 100/hora, 15 s, 3 reintentos, 60 s.
- `scoring.ts:23-27` umbrales de lifecycle (75/12, 25/25, 70/60, 70/65, 50/5); `:32-34` 80/70/60/80, 65, 45.
- `engine.ts:39-56` todos los coeficientes de señal (×12, ×8, ×2, ×18, 80/50, 60, 65, 65, 25); `:74-75` 8, 10, 3, 4; `:96` 15, 8, 0,45, 35, 10; `:101` −20 por nivel; `:149` 70; `:156` los divisores /18 y /12.
- `diff-engine.ts:10-12` y `state.ts:29-31`: +3, +10, −10 (duplicados).
- `predictive.ts:63`: **6,48 € y 8,90 €** (el peor: sustituye la tabla de tramos confirmada); `:12` TTL 30 d y `:67` margen ≥ 8 € (el Hunter los tiene iguales, pero declarados como estimación interna).
- `providers/meta-ad-library-provider.ts:116,152,166-172`: 100, 3.600.000 ms, códigos 4/17/613, `1000·2^intento + rand(300)`, 10.000, `500·2^intento`.
- `persistence.ts:14-20`: 50 reintentos, 30 s, 10 ms; `repository.ts:16` y `pipeline-repository.ts:7`: 100; `pipeline.ts:62,71,87`: 1–90 (14), 150, 10.

## 4 · Dependencias y conflictos

- **npm:** ninguna nueva (solo builtins). Requiere portar `config/hunter-search-terms/casamable-60-plus-es.json` o `config.ts` no compila.
- **Env vars con colisión real:** `HUNTER_PREDICTIVE_SEARCH_SOURCE`, `HUNTER_PREDICTIVE_SEARCH_API_URL`, `HUNTER_PREDICTIVE_SEARCH_API_TOKEN`, `HUNTER_PREDICTIVE_PUBLIC_RESULT_LIMIT` (mismo nombre y valor: dos proveedores activos a la vez, peticiones duplicadas a AliExpress/1688/Alibaba con la **misma UA literal**, indistinguibles en logs). `META_AD_LIBRARY_ACCESS_TOKEN` compartido: la cuota del PI no ve las llamadas del Hunter, así que su límite de 100/hora es ficticio. `META_GRAPH_API_VERSION` obligatoria en el PI, opcional en el Hunter. 8 vars `META_AD_LIBRARY_*` nuevas + `PRODUCT_INTELLIGENCE_ENABLED` + `AUTO_HUNT_ENABLED`.
- **Base de datos:** el PI no usa SQLite: sin colisión de tablas ni de `user_version`, pero queda fuera del versionado, de la guarda de apertura, del `db:health` y del backup. Enumerados en conflicto: `DESCARTAR/INVESTIGAR/CANDIDATO_FUERTE` vs `descartar/investigar/candidato_fuerte` (con `CHECK`), `MomentumStatus` (5 valores) vs `Momentum` (4). Dos costes logísticos distintos para el mismo paquete (6,48 vs 5,90–6,10 €).
- **Superficie:** 27 ficheros referencian `product-intelligence` (2 rutas API, 1 panel, 4 scripts, 3 tests, ~7.100 líneas de docs). Los tests que cubren momentum y ruido son 6 asserts.

## 5 · Qué portar (cuatro PRs pequeños, cada uno con su test) y qué no

1. **`redaction.ts` entero** → aplicar a `ads_json` y `rate_limit_json` antes de escribir en `adlib_candidate_snapshots`. Cero riesgo, cero dependencias.
2. **Gobierno de cuota Meta** (presupuesto por hora/ciclo, backoff con jitter, `cooldownUntil` ante 429 y códigos 4/17/613) dentro de `discovery/client.ts`, que hoy pagina 20 páginas sin freno.
3. **Dos reglas de ruido** en `noiseOf`: marcas grandes (evaluando todo el grupo, no solo `ads[0]`, y por contención normalizada, no igualdad) e infoproductos.
4. **Delta de momentum como razón legible** («12 anuncios activos, +4 respecto al snapshot de hace 3 días») al estilo `ScoreReason`: `previous_active_ads` ya existe; falta exponerlo y, a diferencia del PI, usar la antigüedad del snapshot.

Precondición documental: `docs/HUNTER-VS-PI-ENGINE.md` § «Lo que no se solapa» afirma que el Hunter no puede producir momentum ni clustering; desde `hunter/discovery/` (esquema 21) sí los produce. Se anota en ese documento en este mismo commit.

**No portar:** Opportunity Score, lifecycle, recomendación, `engine.ts` (señales y BFS acoplado al score), `predictive.ts` (duplicado con peores números), scraping público (duplicado exacto), persistencia JSON, `creative-cache`, `diff-engine`, `export`, providers manual/fixture, tipos.

**Decisiones que quedan para Pedro:** si quiere una «watchlist» como estado adicional de `product_candidates`; si la expansión BFS de queries (pieza débil) merece reescribirse sobre señales del Hunter; y aprobar los cuatro PRs anteriores antes de que se escriban.
