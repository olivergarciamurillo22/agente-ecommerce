# Cazador de productos — backend interno: cómo se usa (08-09-2026)

Rama `feat/product-hunter-backend`. Plan e inventario: `PRODUCT-HUNTER-BACKEND-PLAN.md`.
El panel «Cazador de productos» (Buscar / Guardados / Comparar / Economics /
Landing Studio) funciona con `PRODUCT_HUNTER_SOURCE=internal`: no hay backend
externo, todo sale de datos que ya existen en este sistema.

## 1 · Activar en el NAS

En `repo-v3c/.env` (se hornea en la imagen: rebuild + recreate, como siempre):

```
PRODUCT_HUNTER_SOURCE=internal
```

`PRODUCT_HUNTER_API_URL` y `PRODUCT_HUNTER_API_TOKEN` no hacen falta (son del
modo `api`, el backend externo que nunca se construyó). Para que las fuentes
tengan datos:

| Fuente | Qué necesita | Cómo se alimenta |
|---|---|---|
| Ad Library (Competencia) | `META_AD_LIBRARY_ACCESS_TOKEN` (ya validado en el NAS) | las búsquedas de Crecimiento → Competencia dejan sus grupos en el discovery; el Cazador los lee |
| Catálogo de Dropea | `DROPEA_API_KEY` y `DROPEA_API_ENABLED=1` (ya en el `.env`) | `docker exec casamable-agent npm run hunter:dropea:sync` (solo lectura de Dropea) |
| Cruce Dropea × Ad Library | las dos anteriores | `docker exec casamable-agent npm run hunter:cruce-dropea -- --limite 20` |
| Candidatos locales | nada | `npm run hunter:add …` |

Ninguna de estas piezas corre sola: solo cuando alguien lanza el CLI o busca
desde el panel. `EMERGENCY_STOP=1` corta el cruce y las lecturas de Meta.

## 2 · Buscar (panel → Cazador → Buscar)

El selector **Fuente** decide dónde se busca:

- **Anuncios + locales** (default): grupos de anuncios ya descubiertos por
  Competencia (sin ruido, último snapshot) + candidatos de `hunter:add`.
  Cada anuncio trae `activeDays`, variaciones, dominio **declarado** en el
  caption, precio **detectado en el texto** si lo hay, enlace a la ficha en
  Meta y un score con las 4 señales que existen (antigüedad 40, variaciones
  25, anuncios del grupo 20, países vistos 15). Formato, CTA, gasto, ventas:
  no existen; se ven como «no disponible».
- **Ad Library (Competencia)**: solo lo anterior, sin locales.
- **Catálogo Dropea**: la copia local, paginada, con **coste mayorista real**
  y PVPR de Dropea. Sin peso ni medidas (Dropea no los expone). Deja las
  palabras vacías para paginar todo el catálogo.
- **Cruce Dropea × Ad Library**: los cruces persistidos, ordenados por Score
  de Oportunidad Validada (§4). Deja las palabras vacías para verlos todos.
- **Candidatos locales**: lo de `hunter:add`.

El panel no llama a Meta ni a Dropea al buscar: lee SQLite. Los ids llevan
prefijo (`adlib:`, `dropea:`, `cruce:`, `local:`) para saber de dónde viene
cada resultado.

## 3 · Guardar un candidato y completar sus hechos (Dropi/Dropea o a mano)

Al **guardar** un resultado de Dropea o de un cruce, el candidato ya trae el
coste real del catálogo (origen «dropea»). Lo que falta para que el motor
`hunter:score` puntúe son el PVP, el peso y las medidas del paquete:

- **Panel**: ficha → «Hechos del producto (motor hunter:score)» → rellena
  coste/PVP/peso/largo/ancho/alto → «Guardar hechos». El motor recalcula y la
  ficha enseña score, margen por enviado, CPA máximo y entrega mínima con sus
  motivos, o dice qué falta («faltan medidas del paquete de venta»).
- **CLI**, para productos que Pedro descubre por otra vía:

```
npm run hunter:add -- --url <ficha> --apply --coste-eur 7.9 --peso-gramos 420 --largo-cm 22 --ancho-cm 14 --alto-cm 8 --pvp-eur 29.99
npm run hunter:add -- --nombre "Barra de apoyo Dropi" --apply --coste-eur 6.2 --peso-gramos 300 --largo-cm 30 --ancho-cm 6 --alto-cm 6 --pvp-eur 24.99
npm run hunter:score -- --id <id>
```

Reglas: si el scraper sacó un valor y llega uno manual, **gana el manual** y
queda escrito en `nota_manual` y en `candidate_events` (`[manual AAAA-MM-DD]
coste_unitario_eur=… (sobrescribe dato previo: …)`). Sin coste no hay margen;
sin medidas no hay tramo; el sistema nunca inventa ninguno.

«Economía» (supuestos del contrato original) sigue existiendo: su coste y PVP
también alimentan al motor como dato manual, así el margen del panel y el
del motor salen de los mismos números.

## 4 · Cruce Dropea × Ad Library (`hunter:cruce-dropea`)

```
npm run hunter:dropea:sync                              # 1º: copia del catálogo
npm run hunter:cruce-dropea -- --limite 20              # 20 productos aún sin cruzar
npm run hunter:cruce-dropea -- --limite 50 --categoria "cocina" --pais ES --dias 30
npm run hunter:cruce-dropea -- --limite 10 --repetir    # vuelve a cruzar (momentum entre pasadas)
npm run hunter:cruce-dropea -- --ver                    # solo lista lo persistido, sin red
```

Por cada producto: 2–4 **palabras clave** del nombre de Dropea (sin marca ni
relleno, con la misma limpieza de títulos del Hunter) → **una** consulta a
`/ads_archive` (una página) → grupos por anunciante → el grupo con más
palabras clave en su texto es el match:

| `match` | Regla |
|---|---|
| `si` | ≥ 2 palabras clave presentes y cobertura ≥ 75 % |
| `dudoso` | al menos 1 palabra clave (baja confianza; la cobertura penaliza) |
| `no` | ninguna, o solo ruido (cursos, apps, marcas establecidas) |

Es una heurística de texto y así se enseña: puede casar un producto parecido
(falso positivo) y puede no encontrar a un anunciante que lo llame de otra
forma (falso negativo). Un cruce sin match se guarda como **sin validar** con
score bajo, no se descarta.

**Precio de competencia**: solo si está escrito en el anuncio («solo 29,99 €»,
«desde 19.99 EUR»). Se etiqueta «precio detectado en el anuncio» y se guarda
la frase. Con varios importes se prefiere el precedido de «solo/ahora/PVP» y,
si no, el más bajo. Sin precio: margen **no calculable**, nunca estimado. No se
visita la landing del competidor (mejora futura, no implementada).

**Momentum**: `computeMomentum` del discovery, comparando con el cruce
anterior del mismo producto; por eso `--repetir` sirve para medir si sube.

### Score de Oportunidad Validada (0–100)

```
validación de mercado (40) = min(1, días_activo/60)×20 + min(1, variantes/3)×10 + min(1, activos/5)×10
                             · match «dudoso»: ÷2 · sin match: 0
margen (40)                = clamp((pct − 0,30) / 0,40) × 40, con pct = (precio_detectado − coste_dropea) / precio_detectado
                             · 30 % → 0 puntos, 70 % → 40 · sin precio: 0 y «no calculable»
confianza del match (20)   = cobertura de palabras clave × 20
```

Los pesos son criterio de ingeniería, no dato de Pedro: 40/40 porque sin
demanda observada o sin margen la oportunidad no existe, y 20 para que un
match flojo no se cuele arriba. El 60/3/5 de la validación calca los umbrales
del discovery (momentum fuerte con ≥ 5 activos; «lleva tiempo» a partir de
semanas). El 30–70 % del margen es el rango en el que un COD con envío
(~3,8 €), picking (1,4 €), comisión (0,7 €) y rechazos deja de ser negativo
y empieza a aguantar CPA; el margen aquí es **bruto sobre precio**: el motor
`hunter:score` es el que descuenta envío y rechazos cuando hay medidas.

**Ejemplo numérico** (el del test, con Ad Library inyectada; el mismo
cálculo con datos reales cuando corra en el NAS):

| Dato | Valor |
|---|---|
| Producto Dropea | «Cortaúñas Eléctrico 3 en 1», coste 7,90 € |
| Palabras clave | cortaunas, electrico, mayores (del nombre del producto «Cortaúñas Eléctrico 3 en 1 para mayores»; la variante «Negro XL» no cuenta) |
| Match | «Gadgets Senior», 2 anuncios activos, el más antiguo desde el 30-07 (40 días), 2 textos distintos, cobertura 100 % |
| Precio detectado | «ahora solo 29,99 €» |
| Validación | 40/60×20 = 13,33 + 2/3×10 = 6,67 + 2/5×10 = 4 → **24,0** |
| Margen | (29,99 − 7,90) / 29,99 = 73,7 % → por encima del 70 % → **40** (margen bruto 22,09 €) |
| Confianza | 1,0 × 20 → **20** |
| **Score** | **84** |

El mismo producto sin precio en el anuncio: 24 + 0 + 20 = **44**, con «margen
no calculable — falta precio de competencia». Sin ningún anuncio que case:
**0**, «sin validar por el mercado».

Cada cruce guarda fecha, términos, match y confianza, grupo, precio y frase,
coste, margen y el desglose completo (`breakdown_json`): la ficha del panel
lo enseña en «Puntuación» (fórmula en el motivo, cada señal con lo
observado). Si alguien no puede reconstruir el score leyendo la ficha, la
ficha está mal.

**Volumen y límites**: un producto = una petición. El CLI usa el presupuesto
del discovery (tope de peticiones y tiempo), para con motivo
(`presupuesto_peticiones`, `rate_limit`, `deadline`) y persiste producto a
producto: lo hecho no se pierde. Con 4.142 productos, cruzar todo el
catálogo son ~42 lotes de 100 en días distintos; empieza por `--categoria`.

## 5 · Comparar, economics y Landing Studio

- **Comparar**: 2–4 candidatos, vivos o guardados, con los mismos campos
  que la ficha (incluidos `facts` y `hunterScore` si los tienen).
- **Economics** (pestaña): sigue leyendo `product_candidates`; los candidatos
  guardados desde el panel con hechos aparecen ahí porque el pipeline crea
  su fila (`source_url = hunter://<id>`).
- **Landing Studio**: el selector carga `op=candidates`, que ahora devuelve
  los guardados del pipeline real. El compositor no cambia.

## 6 · Lo que el contrato original pedía y NO se hace (y por qué)

- `format`, `cta`: la Ad Library no los da → `null`.
- `saturation`, `risks`: sin dato honesto → `null` / `[]`.
- Precio de competencia **confirmado**: solo «detectado en el anuncio».
- Peso y medidas de Dropea: no están en su contrato → manuales.
- Búsqueda por texto en la API de Dropea: no existe → copia local.
- Backend `api` externo: el contrato sigue ahí, sin implementación.

## 7 · Comandos nuevos

| Comando | Qué hace |
|---|---|
| `npm run hunter:dropea:sync` | copia local del catálogo de Dropea |
| `npm run hunter:cruce-dropea -- --limite N [--categoria X] [--pais ES] [--dias 30] [--repetir] [--ver] [--json f]` | cruce por lotes / listado |
| `npm run hunter:add -- … --coste-eur --pvp-eur --peso-gramos --largo-cm --ancho-cm --alto-cm` / `--nombre` | hechos manuales |

Migración de esquema: **31** (`migrateProductHunterInternal`: `dropea_catalog`,
`hunter_pipeline`, `hunter_cruce_runs`, `hunter_cruces`), aditiva.
