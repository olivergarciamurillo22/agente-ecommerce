# Cazador de productos — contrato del backend (para Pedro)

**Estado:** UI y adaptadores implementados; **sin backend real conectado**.
Fuente: `src/lib/product-hunter/{types,adapter}.ts`. La UI nunca inventa
ventas, ROAS, gasto ni beneficio: lo que la fuente no sabe se muestra como
"No disponible".

## Activación

| Variable | Valores | Efecto |
|---|---|---|
| `PRODUCT_HUNTER_SOURCE` | `off` (default) · `api` · `mock` | `off` = módulo visible pero "no conectado"; `mock` = datos de ejemplo, **rechazado con `NODE_ENV=production`**; `api` = backend real |
| `PRODUCT_HUNTER_API_URL` | URL base sin barra final | obligatoria con `api` |
| `PRODUCT_HUNTER_API_TOKEN` | secreto | opcional; se envía como `Authorization: Bearer …` solo desde el servidor |

## Endpoints (JSON UTF-8)

| Método y ruta | Uso |
|---|---|
| `GET /search?q&country&status&media&minDays&sort&…` | Búsqueda en la Biblioteca de anuncios (resultados `AdLibraryResult`) |
| `GET /candidates?status&country&minScore&saturation` | Candidatos guardados (`WinningProductCandidate[]`) |
| `GET /candidates/{id}` | Detalle (404 → "no encontrado", no error) |
| `POST /candidates` | Guardar un resultado como candidato |
| `POST /candidates/{id}/status` `{status, note?}` | Mover en el pipeline |
| `POST /candidates/{id}/notes` `{text}` | Añadir nota |
| `POST /candidates/{id}/economics` `{…}` | Guardar supuestos de precio/coste (la UI calcula el margen de forma determinista) |
| `POST /compare` `{ids: string[]}` | Comparador 2–4 candidatos |

## Winner Score

Lo calcula el backend y lo entrega **con su desglose** (`scoreBreakdown`);
la UI solo lo explica, nunca lo recalcula ni lo rellena. Claves de métricas
prohibidas en la respuesta (la UI las descarta): ventas, ingresos, ROAS,
gasto, beneficio.

## Frontend

`GET/POST /api/product-hunter?op=…` (`src/app/api/product-hunter/route.ts`)
es el único punto de entrada del navegador; con la fuente en `off` responde
`200 {ok:false, code:"NOT_CONFIGURED"}` y la UI enseña un estado vacío honesto.

La vista **Landing Studio** consume los candidatos guardados a través de este
mismo contrato. No amplía ni acopla el backend de Pedro: crea un
`LandingBlueprint` v1 en el navegador y conserva `candidateId` + `sourceAd.id`
para trazabilidad. Contrato y límites: `docs/LANDING-STUDIO.md`.
