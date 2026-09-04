# Hunter y Product Intelligence Engine — inventario

## Dónde existe

El Product Intelligence Engine existe en la rama
`pedro-atuomatizacion-research`, introducido por `b655cb3` y documentado en
`28b5a67`. Por una diferencia histórica en la raíz del repositorio, sus rutas
aparecen bajo `agente-ecommerce-main/` vistas desde la rama actual. No está
integrado en `feat/hunter-landing-studio`.

Incluye proveedor de Meta Ad Library, importación JSON, motor de investigación,
clustering, Opportunity Score, lifecycle, watchlist, snapshots, señales, diff,
cache de creatividades, persistencia atómica en
`data/product-intelligence*.json`, API, panel **Productos**, CLI y tests.

## Solapamiento

| Área | PI Engine | Hunter | Decisión propuesta |
|---|---|---|---|
| Catálogo de productos | `ProductFinding` y watchlist | `product_candidates` | El PI mantiene el catálogo de descubrimiento; Hunter conserva solo la ficha económica enlazada por id. |
| Score | Opportunity Score mezcla señales de Meta y economics 0–100 | Score de margen, CPA, transporte y operación | No sumarlos ni promediarlos. Mostrar ambos con nombres distintos. |
| UI | Panel Productos, sesiones y watchlist | Cazador/guardados y ficha | Una sola entrada **Productos**; economics de Hunter dentro del detalle del PI. |
| Persistencia | JSON separado con snapshots y señales | SQLite con candidatos y auditoría | PI conserva series de observación; SQLite conserva decisiones económicas auditables. |
| CLI | `product-intelligence` research/auto-hunt/export | `hunter:add`, `hunter:score` | PI descubre; Hunter completa hechos logísticos y recalcula economics. |

## Lo que no se solapa

Meta Ad Library, longevidad publicitaria, velocidad creativa, momentum,
saturación observada, clustering, snapshots, cambios y lifecycle pertenecen al
PI Engine. El Hunter no dispone de una fuente honesta para producir esas
señales y no debe recrearlas.

El tramo de Beeping, coste puesto en España, medidas del paquete, margen por
enviado, CPA máximo y break-even de entrega pertenecen al Hunter. El PI Engine
solo declara hoy un lector abstracto `ExistingEconomicsReader`; no implementa
estos cálculos ni conserva su evidencia.

## Reparto recomendado

La hipótesis encaja con una precisión: Hunter no debería desaparecer como
dominio ni como almacenamiento auditado, sino dejar de ser un segundo catálogo
de descubrimiento. PI descubre y vigila. Al pasar un producto a
`TEST_CANDIDATE`, crea o enlaza una ficha económica Hunter mediante un id
estable. Hunter decide si se puede invertir y devuelve resultado, desglose y
datos pendientes. PI puede usar el veredicto como puerta, nunca como una señal
numérica inventada dentro de Opportunity Score.

Antes de fusionar ambos hace falta acordar la identidad canónica del producto
(id de cluster del PI frente a URL única del Hunter) y migrar la rama del PI a
la raíz actual. Integrarlos ahora duplicaría UI y almacenamiento y haría
imposible saber qué score manda.
