# Cazador · Nivel 2 «Deep dive» — verificación previa (09-09-2026)

Objetivo: para un candidato que el nivel 1 (cruce Dropea × Ad Library) marca
como posible, un análisis lento y caro, candidato a candidato, que confirme
si es un ganador real: tienda de destino, creatividad analizada con IA de
visión, precio real verificado y margen real. Nunca automático sobre todo el
catálogo.

Este documento recoge **lo que se ha podido verificar antes de escribir el
pipeline**, con qué medios, y lo que queda pendiente de una sonda que solo
puede correr donde está el token de la Ad Library (el NAS).

## Verificado desde el PC (sin token), 09-09-2026

| Comprobación | Resultado | Consecuencia |
|---|---|---|
| Campos que devuelve `/ads_archive` | La referencia oficial de Meta no tiene ningún campo de URL de destino (`link_url`, `website_url`…). Solo `ad_creative_link_captions` (el dominio **declarado** que se muestra bajo el anuncio) y `ad_snapshot_url` | La tienda no sale de la API; sale, si sale, de `render_ad` |
| Ficha pública `facebook.com/ads/library/?id=…` sin sesión | **HTTP 403 con desafío JavaScript** (`executeChallenge`) a cualquier petición automatizada, con UA de navegador, propio o curl. No es un muro de login: es protección anti-bot | **No se usa ni se esquiva** (decisión de Pedro: nada de bypass). En un navegador humano sí carga |
| `render_ad` sin token | HTTP 404 | Solo funciona con el token, como documenta Meta |
| «Claude vía API en este proyecto» | Es OpenRouter (`OPENROUTER_API_KEY`, modelo `anthropic/claude-haiku-4.5`), hoy solo texto (`completeText`) | La visión se hace por OpenRouter con un modelo Claude con visión; hay que añadir el contenido de imagen al cliente. Sin segunda clave |
| `ffmpeg` | No está en el PC; en el contenedor del NAS tampoco consta | Los frames de vídeo exigen añadir `ffmpeg` a la imagen Docker o quedarse en «vídeo no analizable» |

## Lo que solo se puede verificar en el NAS: la sonda

`npm run hunter:deep-dive:probe -- --termino "cojin gel silla" [--ad-id N] [--json /app/data/deep-dive-probe.json]`

Con UN anuncio real y 4–5 peticiones, sin persistir nada y con el token
recortado de toda la salida, responde a las cuatro preguntas del encargo:

1. **JSON crudo** de `/ads_archive` para ese anuncio, con la lista de campos
   devueltos y un veredicto explícito «¿trae URL de destino?».
2. **`render_ad` con token**, server-side: HTTP, bytes, si lo que llega es
   login o desafío, enlaces salientes decodificados (`l.facebook.com/l.php?u=…`),
   hosts de destino, número de imágenes y vídeos, texto visible.
3. **Ficha pública sin token**: se espera el 403 con desafío (constancia,
   no intento de saltarlo).
4. **Tienda de destino** (si el paso 2 dio enlace): portada con petición
   simple (`readStoreProfile`: bloqueos declarados, Shopify sí/no, marca),
   precio por `/products/<handle>.js` (JSON público de Shopify, sin browser)
   si la URL es una ficha de producto, y descarga de la primera imagen del
   anuncio para saber si `fbcdn` la sirve sin sesión.

El parser de `render_ad` (`src/lib/hunter/deep-dive/render-ad.ts`) está
probado con HTML sintético; lo que no se puede probar sin token es qué HTML
devuelve Meta de verdad. **Hasta tener la salida de la sonda no se escribe
el pipeline**: las cuatro decisiones de diseño (de dónde sale la tienda, si
la creatividad es descargable, si el precio se lee sin browser, si el vídeo
es viable) dependen de ella.

## Resultado de la sonda real (09-09, «cojin gel silla», NAS)

- `render_ad` con token carga, pero **no trae enlace de salida**
  (`outboundUrls: []`): la URL de destino del anuncio NO está disponible.
  Se descarta seguirla. Sí trae la imagen del anuncio en `fbcdn`, descargable
  sin sesión.
- `ad_creative_link_captions` (paso 1, ya en el nivel 1) trae el **dominio**
  de la tienda: `cloudcore.es`.
- `cloudcore.es/products.json` responde (Shopify, 2 productos): «Cojín
  Ergonómico de Gel CloudCore™» a **34,99 €**. Verificado desde el PC.
- `anthropic/claude-haiku-4.5` en OpenRouter declara `input_modalities:
  [text, image, file]` (consulta pública a `/api/v1/models`, 09-09): **hay
  modelo de visión bajo el mismo proveedor y la misma clave**. Sin OpenAI.

## Diseño final (implementado el 09-09)

```
npm run hunter:deep-dive -- --ids 12,45,78              # cruces concretos (id de hunter_cruces)
npm run hunter:deep-dive -- --min-score 60 --limite 5   # los N mejores con match, aún sin deep dive
npm run hunter:deep-dive -- --dominio cloudcore.es --palabras "cojin gel silla" --coste 9.5 --activos 2
npm run hunter:deep-dive -- --ver                       # lo persistido, sin red
opciones: --sin-vision · --sin-cuenta · --page-id N (manual) · --json informe.json
```

Nunca recorre el catálogo entero. Por candidato, en orden y cada paso con
su motivo si no se pudo (`src/lib/hunter/deep-dive/deep-dive.ts`):

| Paso | Fuente | Si falla |
|---|---|---|
| 0 · Cuenta | `search_page_ids=<page_id>`, `ad_active_status=ALL`, ≤ 5 páginas de 100 (ver «Paso 0») | «cuenta»: sin page_id, sin token o `--sin-cuenta`; el informe sigue |
| 1 · Dominio | `ad_creative_link_captions` del último snapshot del candidato (sin red) | «tienda no localizable»: la URL de destino no está en la API ni en render_ad |
| 2 · Catálogo | `readStore` (portada + `/products.json`, hasta 4 páginas, UA propio, bloqueos declarados) | «catálogo no accesible» (no Shopify, 404, anti-bot). Sin browser headless, sin bypass |
| 3 · Producto | palabras clave del cruce contra título + handle + tipo, por palabra ENTERA; «si» con cobertura ≥ 0,75 y ≥ 2 aciertos, si no «dudoso» | «producto no encontrado» |
| 4 · Precio y margen REALES | `variants[].price` mínimo del producto casado; margen = (precio − coste Dropea) / precio | sin coste → «margen no calculable»; nunca se estima |
| 5 · Ángulos | `extractAngles` sobre el texto del anuncio (cita literal) | — |
| 6 · Creatividad (opcional) | `render_ad` con token en memoria → primera imagen `fbcdn` → OpenRouter (`DEEP_DIVE_VISION_MODEL`, por defecto `anthropic/claude-haiku-4.5`), JSON: gancho, ángulo, dolor, deseo, avatar, precio visible | `sin_vision` (sin `OPENROUTER_API_KEY` o `--sin-vision`), `sin_token`, `sin_imagen`, `video_no_soportado` (sin ffmpeg; el informe sigue), `error` |
| 7 · Veredicto | reglas literales, guardadas con el informe | — |

```
ganador_probable = catálogo ok ∧ producto casado (cobertura ≥ 0,75) ∧ margen real ≥ 50 % ∧ activos ≥ 2 ∧ días ≥ 14
senal_debil      = producto casado ∧ margen real ≥ 30 % pero falla activos, días o el match es dudoso
descartar        = producto casado ∧ margen real < 30 %, o producto no disponible
no_verificable   = sin dominio, catálogo no accesible, producto no encontrado o sin coste
```

Persistencia: `hunter_deep_dives` (migración 32, aditiva): candidato,
dominio, catálogo, producto casado y URL, precio, coste, margen, ángulos,
análisis de la creatividad, activos y días, veredicto, razonamiento,
carencias, peticiones. El token nunca se persiste (hay test).

Coste por candidato: ≤ 5 peticiones a /ads_archive para la cuenta (paso 0, ver
abajo), 2–4 a la tienda, 1 a render_ad y 1–2 a OpenRouter solo con clave. `EMERGENCY_STOP` corta antes de cada candidato.

### Ejecución real desde el PC (09-09, modo manual, sin base del cruce)

```
npm run hunter:deep-dive -- --dominio cloudcore.es --palabras "cojin gel silla" --activos 2 --sin-vision
  Tienda: cloudcore.es (manual) · portada ok · Shopify · CloudCore
  Catálogo: ok · 2 productos
  Producto: «Cojín Ergonómico de Gel CloudCore™ | Alivio de coxis, lumbares y ciática» (match dudoso, cobertura 67 %)
  Precio real: 34.99 € · coste Dropea: — · margen real: —
  VEREDICTO: NO_VERIFICABLE — sin coste de Dropea no hay margen real
```

La cobertura del 67 % es honesta: el título no contiene «silla». Con el
coste real de Dropea (en el NAS) y los activos/días del cruce, el mismo
comando por `--ids` da el veredicto completo; con `--coste 9.5` de ejemplo
sale «senal_debil, margen real 73 %, falta: match dudoso, menos de 14 días».

## Paso 0 · Radiografía de la cuenta completa (añadido el 09-09, pedido de Pedro)

En cuanto un candidato tiene match, antes de mirar la tienda se pide a
`/ads_archive` **todo lo de esa página**: `search_page_ids=["<page_id>"]` en
vez de `search_terms`, con `ad_active_status=ALL` (activos **e** inactivos) y
una ventana de fechas amplia (`2018-01-01` → hoy). Cada anuncio trae
`ad_delivery_start_time` y, si está apagado, `ad_delivery_stop_time`.
Código: `src/lib/hunter/deep-dive/account.ts` (`readAccountXray`,
`xrayFromAds`); consolidación opcional del avatar en
`account-summary.ts`.

Lo que sale de ahí, y que no se ve mirando un solo anuncio:

| Campo | Cómo se calcula | Naturaleza |
|---|---|---|
| Antigüedad real de la tienda anunciando | fecha de inicio del anuncio **más antiguo de toda la cuenta**, esté activo o apagado (`firstAdStart`, `daysAdvertising`) | dato de la API |
| Total de anuncios / activos ahora / apagados | anuncios únicos por id; activo = sin `ad_delivery_stop_time` | dato de la API |
| Ángulos que repite y cuáles lleva más tiempo sin apagar (ganadores) | cada anuncio se clasifica con las mismas reglas de texto del auditor (`ANGLE_RULES`, cita literal); por ángulo: nº de anuncios, activos y el **activo más antiguo** (`longestActiveDays`). Orden: el de activo más longevo primero. Si no funcionaran, los habrían apagado | heurística sobre texto real, con cita |
| Target / avatar consolidado | `AVATAR_RULES` (mayores, madres, oficina, dolor articular, mascotas…) con cita por señal; con `OPENROUTER_API_KEY`, Claude (mismo modelo que la visión) redacta 2–4 frases SOLO a partir de los textos, marcado `summarySource: "claude"`; sin clave, resumen heurístico | heurística con cita / texto de Claude, marcado |

**Coste**: 1 petición por cada 100 anuncios de la cuenta (mismo endpoint y
mismo límite `limit=100` que la búsqueda por palabra), con tope
`ACCOUNT_MAX_PAGES = 5` (≤ 5 peticiones por candidato) y presupuesto
`DiscoveryBudget`. Si se alcanza el tope, el informe lo marca `truncated` y
antigüedad/volumen se declaran «cota inferior». Con `OPENROUTER_API_KEY`, +1
llamada de texto a OpenRouter. El test «DEEP DIVE · paso 0» comprueba con red
inyectada que la URL lleva `search_page_ids`, `ad_active_status=ALL`, no lleva
`search_terms`, y que 2 páginas = 2 peticiones.

**Confirmación en vivo (pendiente del NAS)**: la sonda tiene ahora un paso 5
que hace UNA petición por `search_page_ids` con `ad_active_status=ALL` y
reporta HTTP, milisegundos, cuántos anuncios devuelve, cuántos traen
`ad_delivery_stop_time`, el más antiguo y si hay `paging.next` (= más de 100,
cada 100 cuesta 1 petición más):

```
npm run hunter:deep-dive:probe -- --termino "cojin gel silla"     # pasos 1–5 (el 5 con el page_id del anuncio)
npm run hunter:deep-dive:probe -- --page-id 123456789012345       # solo el paso 5
```

Hasta tener esa salida, «search_page_ids se comporta como la búsqueda por
palabra» es lo que dice la documentación de Meta y lo que asume el cliente
(`AdLibraryClient.search` ya lo usaba para el auditor de tiendas), no un dato
observado con inactivos incluidos.

**Bug real del 09-09 (corregido)**: con el token renovado, el paso 5 de la
sonda devolvió HTTP 400, `code 100`, `error_subcode 2334029`: «The
ad_delivery_date_min is invalid. It must in [2018-05-07 - Today]». La
petición llevaba `ad_delivery_date_min=2018-01-01` (la constante
`ACCOUNT_SINCE`, repetida a mano en la sonda) y `ad_delivery_date_max=2026-09-09`
(fecha UTC del sistema). El máximo era correcto; el mínimo caía cuatro meses
antes de lo que Meta admite. Fix: `ACCOUNT_SINCE = "2018-05-07"` y una única
función `accountDateWindow(now)` que usan el paso 0 y la sonda; el máximo se
calcula con 8 h de margen porque el «Today» de Meta se evalúa en hora del
Pacífico (desde Madrid, entre las 00:00 y las 09:00 la fecha UTC va un día
por delante). Test «DEEP DIVE · BUG 09-09» con un validador que imita a Meta,
`page_id 1051601004698822` y el 09-09-2026 a cuatro horas distintas; el
mismo test falla si `ACCOUNT_SINCE` vuelve a 2018-01-01 (comprobado).

**En el informe**: sección «Cuenta completa» del CLI (antigüedad real,
total/activos/apagados, ángulos con el activo más antiguo y su cita, avatar
consolidado y su fuente), columna `account_json` en `hunter_deep_dives`
(aditiva, dentro de la migración 32 con `ALTER TABLE` guardado), y el
razonamiento del veredicto añade «· cuenta: anuncia desde … · N anuncios, M
activos · ángulos más longevos: …». **La cuenta informa; no cambia el
veredicto**: las reglas escritas siguen siendo las de arriba. Se omite con
`--sin-cuenta`, sin token de la Ad Library, o en modo manual sin `--page-id`;
en los tres casos queda declarado en «No se pudo completar».

## Pipeline completo (construido el 09-09, tras las cuatro verificaciones)

Objetivo: el informe que sustituye a «mirar el anuncio a mano 20 minutos».
Por candidato, en orden (`src/lib/hunter/deep-dive/deep-dive.ts`):

| Paso | Qué hace | Fuente / coste | Si falla |
|---|---|---|---|
| 0a · Búsqueda por palabra | Repite la búsqueda del nivel 1 (últimos 30 días, 1 página): anuncios frescos del candidato (el cruce NO guarda los anuncios, solo la clave y el score), el `page_id` si faltaba y la **saturación cruzada**: cuántas OTRAS páginas casan con las mismas palabras clave (`competitors`, con nombre, activos, cobertura y enlace) | 1 petición a `/ads_archive` | «competencia» no medida; el resto sigue |
| 0b · Cuenta | `search_page_ids`, activos e inactivos: antigüedad real, total/activos/apagados, ángulos con el activo más antiguo (cita), avatar (heurística + Claude opcional) | ≤ 5 peticiones | «cuenta» con motivo |
| 0b · Madurez (nuevo) | **Dos números separados a propósito**: `testing` = ritmo de testeo de la cuenta (anuncios NUEVOS en 30 días, por semana: alto ≥ 5, medio ≥ 1,5, bajo) y `winner` = madurez del ángulo ganador (días que lleva ACTIVO sin interrupción el anuncio más antiguo de ese ángulo, con cita y enlace). Una cuenta que estrena decenas de anuncios está probando; un anuncio que lleva 200 días encendido es el que ya ganó | sin peticiones extra | — |
| 0b · Minería (nuevo) | Los anuncios ACTIVOS de la cuenta se agrupan por **producto físico** (palabras de producto, no de ángulo: fuera «envío gratis», «oferta», «garantía»…; dos anuncios son el mismo producto si comparten ≥ 3 palabras o ≥ 50 % de las del más corto). Por producto: etiqueta, palabras, nº de anuncios, días del más antiguo, enlace, y si es el original. Los demás se buscan en el catálogo LOCAL de Dropea por sus 3 palabras más frecuentes (`otherProducts[].dropea`) | sin peticiones extra (búsqueda local) | lista vacía |
| 1 · Dominio | `ad_creative_link_captions` | — | «tienda» |
| 2 · Catálogo | portada + `/products.json` | 2–4 peticiones | «catálogo» (no Shopify, 404, anti-bot: no se fuerza) |
| 3 · Producto | palabras clave contra título/handle/tipo | — | «producto» |
| 4 · Precio y margen REALES | `variants[].price` mínimo; margen contra coste de Dropea | — | «margen»: nunca se estima |
| 4 · Coherencia (nuevo) | Todos los importes del TEXTO del anuncio (`detectPricesInText`) contra el rango del catálogo (±2 %): `coincide`, `difiere` (**ALERTA** explícita: oferta solo por anuncio, pack distinto o matching equivocado), `sin_precio_en_anuncio`, `sin_catalogo` | — | — |
| 5 · Ángulos | `extractAngles` (cita literal) | — | — |
| 6 · Imagen | render_ad → imagen fbcdn → visión por OpenRouter | 1 + 1 peticiones, 1 OpenRouter | `sin_vision`, `sin_imagen`, `video_no_soportado`… |
| 6 · Vídeo (nuevo) | Si render_ad trae `<video>`: descarga de fbcdn y **transcripción con OpenAI** (`/audio/transcriptions`, whisper-1, el mp4 tal cual). De ahí: guion, gancho (lo dicho antes del segundo 5), duración, palabras/min; Claude (OpenRouter) interpreta gancho/ángulo/dolor/deseo/avatar/CTA/ritmo | 1 petición fbcdn, 1 OpenAI, 1 OpenRouter | `sin_openai_key`, `tope_diario`, `video_no_descargable`, `video_demasiado_grande` (> 25 MB), `sin_audio`, `error`: siempre «vídeo detectado, análisis no disponible», nunca se finge |
| 7 · Veredicto | mismas reglas escritas + **recomendación con motivo** (`contactar_dropea_muestra` / `verificar_manual` / `descartar`, reglas literales en `RECOMMENDATION_RULES`) + **texto claro** (`summary`) + enlace público `facebook.com/ads/library/?id=<ad_id>` | — | — |

Persistencia: columnas aditivas en `hunter_deep_dives` (ALTER guardado dentro
de la migración 32): `ad_link`, `recommendation`, `recommendation_reason`,
`competitors`, `other_products`, `video_status`, `price_coherence`, `summary`
y `report_json` (el informe entero). `--ver-id N` lo reimprime sin red.

```
npm run hunter:deep-dive -- --ids 12,45          # cruces concretos
npm run hunter:deep-dive -- --min-score 60 --limite 3
opciones: --sin-vision · --sin-video · --sin-cuenta · --sin-busqueda · --json x.json · --ver · --ver-id N
```

Coste por candidato: 1 búsqueda + ≤ 5 de cuenta a la Ad Library, 2–4 a la
tienda, 1 render_ad, 0–1 imagen, 0–1 vídeo, 0–2 OpenRouter, 0–1 OpenAI.

### Vídeo/audio con OpenAI: qué se verificó y qué queda para el NAS

Decisión de Pedro (09-09): usar la API de OpenAI (la `OPENAI_API_KEY` que ya
existe para direcciones e intención) **solo** para el vídeo del anuncio; todo
lo demás sigue en Claude por OpenRouter.

Comprobado contra el SDK instalado (`openai` 6.38.0, `node_modules/openai/resources`):

- **La API no acepta vídeo como entrada del modelo.** Ni Chat Completions ni
  Responses tienen una parte `video`; la entrada de audio de chat
  (`input_audio`) solo admite `wav`/`mp3` en base64. La premisa «GPT-4o
  entiende vídeo de forma nativa por API» no se cumple hoy.
- **`/audio/transcriptions` sí acepta el archivo tal cual**: «flac, mp3, mp4,
  mpeg, mpga, m4a, ogg, wav, or webm», máximo 25 MB. `whisper-1` con
  `verbose_json` devuelve segmentos con tiempos (de ahí el gancho de los
  primeros 5 s y las palabras por minuto); `gpt-4o-transcribe` solo texto.

Por eso el pipeline manda el mp4 entero a transcripciones, sin ffmpeg y sin
extraer nada, y **lo visual (movimiento, planos, texto en pantalla) no se
analiza**; el informe lo declara siempre (`video.limits`). Lo que solo se
puede confirmar en el NAS (paso 6 de la sonda, `--max-render 6`): que
`render_ad` trae `<video>` en un anuncio real y que fbcdn sirve el mp4 sin
sesión (como la imagen), y que OpenAI lo acepta con ese `content-type`.
Si no es descargable, el pipeline cae a imagen + texto para esos casos con
«vídeo detectado, análisis de audio/movimiento no disponible».

```
npm run hunter:deep-dive:probe -- --termino "cojin gel silla" --max-render 6
```

### Estado real de ejecución (09-09)

- Desde el PC (sin token de Meta ni clave de OpenAI en este entorno): modo
  manual contra `cloudcore.es` real → catálogo, precio real, margen,
  coherencia, recomendación y texto claro; cuenta, competencia y vídeo
  declarados como no disponibles (ver «Ejecución real» arriba).
- Con red inyectada (test «DEEP DIVE · pipeline completo»): los 7 pasos, con
  saturación (2 competidores), ritmo medio, ángulo ganador 200 días, alerta de
  precio (34,99 en el anuncio vs 39,99 en el catálogo), vídeo transcrito,
  almohada cervical encontrada en Dropea, `verificar_manual` con motivo.
- **Pendiente en el NAS**: `--ids` de «Cojín gel silla» y «Tapas de silicona
  6X» (los de más señal del lote de 300) con token y `OPENAI_API_KEY`. Es la
  primera vez que el modo `--ids` corre con datos: el cruce no guarda anuncios,
  así que el dominio y el `page_id` salen de la búsqueda del paso 0a.

## Búsqueda 2 · validados fuera de España, sin competencia en España (09-09)

Objetivo de Pedro: productos de Dropea con evidencia fuerte en OTRO país
(mismo veredicto de siempre) que **no tengan competencia activa en España
ahora mismo**, con buen margen real. La pieza que da valor es la
comprobación de España, y es obligatoria: sin ella no se puede afirmar
«sin competencia».

```
npm run hunter:cruce-dropea -- --limite 20 --pais IT          # una corrida por país; también --pais IT,PT,FR,DE
npm run hunter:cruce-dropea -- --limite 20 --pais IT --sin-traducir
npm run hunter:deep-dive -- --ids <ids de esos cruces>       # el país viene del cruce; comprueba España solo
npm run hunter:deep-dive -- --dominio x.it --palabras "cuscino gel sedia" --palabras-es "cojin gel silla" --pais IT --page-id N
```

Qué cambia respecto al pipeline de arriba (todo lo demás, igual):

| Pieza | Cómo | Constancia en el informe |
|---|---|---|
| País en el cruce | `ad_reached_countries=[<ISO>]` (ya existía `--pais`; ahora admite lista y una corrida por país). «Ya cruzado» se cuenta **por país**: un cruce en ES no tapa el de IT | `hunter_cruces.country` |
| Palabras en el idioma del mercado | Las palabras salen del nombre en Dropea (español). Con `OPENROUTER_API_KEY`, Claude las traduce (`translate.ts`, mapa país→idioma: IT, PT, FR, DE, NL, GB…; MX/AR/CO/CL/PE no se traducen). Sin clave o con `--sin-traducir`, se buscan en español y el cruce lo dice: un «no» así no significa que no se anuncie | `breakdown.keywords` (buscadas), `breakdown.keywordsOriginal` (español), `breakdown.keywordsNote` |
| **Comprobación de España (obligatoria, paso 0c)** | Con país ≠ ES, el deep dive repite la misma búsqueda por palabra, **en español** y con `ad_reached_countries=["ES"]` (1 petición más por candidato; la función de búsqueda no se toca). Cuenta los anuncios ACTIVOS de las páginas cuyo texto casa (match si o dudoso) | `spainCheck` (activos, páginas con enlace, palabras, base, verificado sí/no), `opportunity`, columnas `country`, `spain_active_ads` (solo si se verificó), `opportunity` |
| Regla dura | `1+` activos con match en España → `opportunity = ya_en_espana` y **recomendación `descartar`** aunque el veredicto sea ganador. España no comprobada (sin token, error de Meta) → `no_verificado`: nunca «contactar», como mucho `verificar_manual`. `0` verificado → `sin_competencia_es` | Línea «COMPETENCIA EN ESPAÑA: N anuncios activos (verificado)» y en el texto claro |
| Radiografía y minería | Sobre el `page_id` de la cuenta extranjera; los «otros productos» se buscan en Dropea por sus palabras (en el idioma del anuncio: a veces no casan) | igual |

Límites conocidos, dichos aquí para no descubrirlos tarde:

- **Cobertura de la Ad Library por país**: con `ad_type=ALL` Meta archiva
  todos los anuncios solo en la UE (y algún país más); fuera (México, EE. UU.)
  solo los políticos/sociales. Un «0 anuncios» en MX no significa nada. Por
  eso la lista sugerida empieza por **IT, PT, FR, DE**; México queda como
  país abierto en el flag, pero no como fuente fiable hasta que la sonda diga
  lo contrario.
- **Ángulos y avatar** (`ANGLE_RULES`, `AVATAR_RULES`) son reglas en español:
  en italiano o francés clasifican menos. La cita literal sigue siendo válida;
  la etiqueta puede faltar.
- **Coste por candidato**: +1 petición (España). Nunca sobre el catálogo
  entero: `--limite` en el cruce, `--ids`/`--min-score --limite` en el deep dive.

### Verificación de `ad_reached_countries` ≠ ES (pendiente del NAS)

No se asume que otro país se comporte igual: la sonda tiene un modo que hace
la MISMA búsqueda en varios países, lado a lado, y compara HTTP, número de
anuncios, campos devueltos y error (1 petición por país):

```
npm run hunter:deep-dive:probe -- --termino "cuscino gel sedia" --comparar-paises ES,IT,PT,FR,DE,MX
```

Acepta si IT/PT/FR/DE dan HTTP 200 con los mismos campos que ES y anuncios
> 0 para un término del idioma. Si algún país devuelve error de permiso o
campos distintos, se anota y ese país se saca de la lista. Hasta esa salida,
lo de arriba está probado con red inyectada (test «BÚSQUEDA 2»), no en vivo.

### Ejemplo (red inyectada, misma forma que el informe real)

```
VEREDICTO: GANADOR_PROBABLE — «Cuscino in Gel per Sedia» a 29.9 € en casabella.it (match si, cobertura 100 %) · coste 9.5 € · margen real 68 % · 2 activos · 140 días → cumple las cuatro condiciones · cuenta: anuncia desde 2025-11-13 (300 días) · 5 anuncios, 4 activos · ángulos más longevos: precio y oferta 140 días
RECOMENDACIÓN: CONTACTAR_DROPEA_MUESTRA — … pedir muestra a Dropea; 0 anuncios activos en España (verificado)
COMPETENCIA EN ESPAÑA: 0 anuncios activos (verificado) · oportunidad: SIN_COMPETENCIA_ES · búsqueda «cojin gel silla» con ad_reached_countries=ES, últimos 30 días, 1 página (1 anuncios, 1 páginas)
País de la búsqueda: IT
Competencia en IT: 1 (ErgoItalia) · Coherencia de precio: COINCIDE · Otros productos: «Cuscino cervicale…» 80 días → en Dropea: Almohada cervical viscoelástica
```

Con 2 anuncios activos de «SillaConfort» en España, el mismo candidato sale
`ya_en_espana` y `DESCARTAR — ya se anuncia en España: 2 anuncio(s) activo(s)
con match; no es una oportunidad «aún no vendida aquí» aunque esté validado en IT`.

## Gate de producto y diversidad del catálogo (10-09, tras 20 candidatos reales)

**Problema visto en producción** (09-09): con cobertura del 33–50 % el
producto que casa en `/products.json` casi siempre es OTRO («Peine piojos» →
«PEINE PUA ESPECIAL CARBONO», margen −196 %; «Purificador de aire ozono» →
«Detector de calidad del aire 6 en 1»; «Botella reutilizable» → «Botella
Soluto Champú», margen −57 %; «Ventilador doble» → cuenta de mini-PCs), y el
pipeline gastaba igualmente radiografía, España, minería, render_ad y vídeo.

**Orden nuevo**: 0a búsqueda → 1 dominio → 2 catálogo → 3 producto →
**3b gate** → (solo si pasa) 0c España → 0b cuenta → minería → 4 precio y
coherencia → 5 ángulos → 6 creatividad → 7 veredicto.

Gate (`product-gate.ts`, reglas literales en `GATE_RULE`), solo cuando SÍ hay
catálogo (sin catálogo no hay nada que comparar y sigue `no_verificable`):

1. cobertura ≥ 0,6 por raíz («cojines» cuenta como «cojín»): 2 palabras, las
   dos; 3, al menos 2; 4, al menos 3;
2. la palabra principal del nombre (la primera: «peine», «purificador»,
   «botella») tiene que estar;
3. al menos una palabra específica presente: «aire», «digital», «plástico»,
   «soporte»… son genéricas (`GENERIC_PRODUCT_WORDS`) y no prueban nada;
4. si el catálogo declara `product_type` y no comparte raíz con ninguna
   palabra clave, contradice: solo se tolera con cobertura ≥ 0,75;
5. catálogo accesible y ningún producto que case → también corta.

Calibrado con los casos reales: cortan Peine piojos (50 %), Purificador
(33 %, falta «purificador», solo «aire»), Botella (33 %), Ventilador doble
(nada casa); pasan SOPORTE PARA ABDOMINALES (100 %), Tapas de silicona
(100 %), Cojín gel silla (67 %, el #255 real). Test «GATE DE PRODUCTO».

**Resultado del corte**: `verdict = skip_no_match`, `recommendation =
skip_no_match`, `earlyExit = { stage: "gate_producto", reason, skipped[] }`;
se persiste (columna `early_exit`; por la `CHECK` de la tabla el veredicto se
guarda como `no_verificable` y se reconstruye al leer). Cuenta como hecho
para `--min-score`. El CLI imprime un bloque corto y distinto (tienda,
buscaba, encontró, cobertura, motivo, qué no se ejecutó, peticiones).

**Ahorro por candidato cortado**: a Meta se gasta 1 petición (la búsqueda por
palabra) en vez de 3–8 (búsqueda + cuenta 1–5 + render_ad + España si país
≠ ES): **2–7 peticiones a Meta menos**, más 0–2 descargas de fbcdn y 0–3
llamadas de IA (visión, vídeo, avatar). La tienda cuesta igual (2–4).

**Segundo problema**: «Mini plancha pelo» casó bien con ghd (marca global,
catálogo bloqueado, 25 competidores): producto correcto, oportunidad falsa.
Señal barata sobre la minería ya hecha (`catalogDiversity`, regla en
`DIVERSITY_RULE`): con ≥ 3 productos minados, si una raíz de palabra (fuera
marca/página/dominio) aparece en ≥ 70 % de ellos o el solape medio de
palabras es ≥ 0,25, el catálogo es «concentrado» → «posible marca propia, no
dropshipper — catálogo poco disperso» y la recomendación baja de
`contactar_dropea_muestra` a `verificar_manual`. Disperso (Takuyi:
purificador, báscula, luces LED, gafas) no cambia nada. Test «DIVERSIDAD DEL
CATÁLOGO» con ambos casos (ghd reconstruido de memoria: planchas y un
secador; el JSON real está en el NAS).

## Búsqueda 3 · caza directa de tiendas COD por «pago contra reembolso» (10-09)

Inversa de las búsquedas 1 y 2: parte de la Ad Library, busca quien habla de
pago contra reembolso (la señal más fuerte de operación COD como Casamable),
agrupa por tienda, prioriza barato y audita a fondo solo el lote que decide
Pedro. Captura ganadores cuyo nombre en el anuncio nunca coincidiría con el
de Dropea. Código: `src/lib/hunter/deep-dive/cod-hunt.ts`, CLI
`scripts/hunter-busqueda-cod.ts`, tablas `hunter_cod_sweeps` y
`hunter_cod_stores` (aditivas, migración 32).

```
npm run hunter:busqueda-cod                                     # FASE 1: 4 frases × ≤ 5 páginas, ES, 180 días (≤ 20 peticiones)
npm run hunter:busqueda-cod -- --frases "pago contra reembolso|paga al recibir" --paginas 3 --dias 90 --json barrido.json
npm run hunter:busqueda-cod -- --ver                            # último barrido, sin red
npm run hunter:busqueda-cod -- --auditar --ids 1051601004698822 # FASE 2: lote explícito
npm run hunter:busqueda-cod -- --auditar --top 3                # los 3 primeros del barrido aún no auditados (máx. 10)
npm run hunter:busqueda-cod -- --ver-tiendas · --ver-tienda <id>
```

**Fase 1 (barata, no audita)**: por frase (`COD_PHRASES_DEFAULT`: «pago
contra reembolso», «paga al recibir», «pago en efectivo al recibir»,
«contrareembolso»), `search_terms` con `ad_active_status=ALL` y
`ad_reached_countries=ES`, hasta `--paginas` (5) páginas de 100. Agrupación
en memoria por `page_id`: anuncios encontrados, activos, **anuncios que dicen
de verdad la frase** (`COD_EVIDENCE`; Meta devuelve «parecidos» y esas
páginas quedan fuera, contadas aparte), activo más antiguo y sus días,
dominios declarados, cita literal y enlace. Prioridad barata (`SWEEP_FORMULA`,
0–100, **no es veredicto**): `min(activos, 10) × 5 + min(días, 180) / 180 × 50`.
Se persiste entera (`hunter_cod_sweeps`) para que `--top` no repita tiendas.

**Fase 2 (cara, siempre lote explícito)**, por tienda:

| Paso | Qué | Coste |
|---|---|---|
| Radiografía | `readAccountXray` tal cual (antigüedad real, activos/inactivos, ángulos con madurez, avatar, ritmo de testeo), con la marca/dominio excluidos de la dispersión | ≤ 5 |
| Minería + diversidad | los mismos `products` y `diversity` del pipeline; «concentrado» = posible marca propia | 0 |
| Producto → Dropea | por producto minado (hasta `--max-productos`, 4): palabras del título + una del grupo (`productSearchKeywords`), búsqueda LOCAL en Dropea y **gate estricto** contra el nombre de Dropea (`matchDropea`: mismas reglas que el gate del catálogo; «báscula digital de baño» ≠ «báscula de cocina digital») | 0 |
| Si está en Dropea | `runDeepDive` completo con la radiografía ya hecha (`accountPrecomputed`, no se vuelve a pedir la cuenta): precio real, margen, coherencia, competencia, veredicto, recomendación. Se guarda también en `hunter_deep_dives` | 1 búsqueda + 2–4 tienda + creatividad |
| Si NO está | **fuerza de la señal** (`SIGNAL_RULES`): `senal_fuerte_sin_proveedor` = activo más antiguo ≥ 30 días ∧ ≥ 2 activos ∧ catálogo no concentrado; si no, `senal_debil_sin_proveedor`. Sin margen, sin «contactar a Dropea»: «requiere sourcing alternativo (AliExpress u otro proveedor)». Recomendación `testear` / `no_testear` con sourcing `alternativo` | 0 |
| Veredicto por tienda | texto claro con la tabla de productos: cuáles en Dropea y cuáles no, recomendación y motivo de cada uno | — |

**Verificación pendiente en el NAS (antes de calibrar frases)**: la fase 1
real. El comando de arriba con `--paginas 3` cuesta ≤ 12 peticiones; la
tabla dice cuántas tiendas distintas salen y cuántas páginas devolvió Meta
«por parecido» sin decir la frase. Con eso Pedro decide si el volumen es
manejable o hay que afinar `--frases`. La fase 2 está construida y probada con
red inyectada (test «BÚSQUEDA 3»: Takuyi con purificador y gafas en Dropea,
cepillo de vapor fuerte sin proveedor, báscula débil y rechazada por el gate).

Ejemplo (red inyectada, misma forma que el informe real):

```
FASE 1 · 4 peticiones · 4 anuncios únicos · 2 tiendas con la frase
 page_id  tienda   activos  con frase  dias  prioridad  dominio     evidencia
 8002     ghd      1        1          400   55         ghd.com     ghd Platinum+ plancha: pago contra reembolso dispo
 8001     Takuyi   3        3          120   48.3       takuyi.es   Pago contra reembolso, envío 24h.

■ «Purificador de aire ozono» · 2 activos · 120 días
  EN DROPEA: «Purificador de aire ozono portátil» (14.2 €) · DEEP DIVE: GANADOR_PROBABLE — … margen real 64 % → CONTACTAR_DROPEA_MUESTRA
■ «Cepillo de vapor» · 2 activos · 70 días
  NO EN DROPEA (buscado «cepillo vapor ropa»: 0 candidatos) · SEÑAL: SENAL_FUERTE_SIN_PROVEEDOR → TESTEAR (sourcing alternativo): la decisión de sourcing es de Pedro; sin margen calculable
■ «Báscula digital» · 1 activo · 20 días
  NO EN DROPEA (mejor «Báscula de cocina digital 5 kg»: faltan palabras específicas: «bano») · SENAL_DEBIL_SIN_PROVEEDOR → NO_TESTEAR
```

### Ampliación (10-09, tras 15 auditorías reales): frases, vídeo, informe consolidado, tandas

- **Frases**: la lista por defecto pasa de 4 a 13 («pago contra reembolso»,
  «contrareembolso», «envío contra reembolso», «paga al recibir», «pago en
  efectivo al recibir», «pago cuando recibas», «paga cuando lo recibas», «paga
  cuando llegue», «paga en casa», «paga en tu domicilio», «pago en la puerta»,
  «pago al momento de la entrega», «sin pago por adelantado»). La evidencia
  (`COD_EVIDENCE`) reconoce todas. Coste de la fase 1: ≤ 13 × `--paginas`
  peticiones (65 con las 5 por defecto; 39 con `--paginas 3`). Una tienda que
  sale en varias frases cuenta una vez (dedupe por id de anuncio y por
  `page_id`). Al terminar, la fase 1 dice cuántas tiendas son **nuevas**
  respecto al barrido anterior persistido.
- **Vídeo en la fase 2**: por producto minado se pide `render_ad` de hasta 3
  de sus anuncios activos (1 petición cada uno; `--sin-probar-video` para no
  gastar) y se anota `tiene_video: sí (N de M comprobados) / no / no
  comprobado (motivo)`. Si hay vídeo, ese anuncio pasa a ser el enlace
  principal del producto y el primero que mira el deep dive (así la
  transcripción, si hay clave de OpenAI, cae sobre él). Solo presencia: no se
  descarga ni se analiza aquí.
- **Informe consolidado** (`--informe --min-dias 20 --max-dias 90`, 0
  peticiones): lee todas las auditorías persistidas (la última por tienda) y
  saca una fila por producto con `senal_fuerte_sin_proveedor` o en Dropea con
  `ganador_probable` (con su margen), cuya madurez (días del anuncio activo
  más antiguo del producto) esté en el rango; ordenado de más maduro a menos.
  Columnas: tienda, dominio, producto, vídeo, días, activos, en Dropea (sí con
  margen / no), catálogo, fecha de auditoría, id; debajo, un enlace por fila
  (el del vídeo si lo hay). `--json` para guardarlo. Regla literal en
  `CONSOLIDATED_RULE`.
- **Tandas**: `--auditar --top N` admite hasta 30 por tanda y salta
  automáticamente las tiendas ya persistidas (`pickNextBatch`); imprime
  «X tiendas en el barrido, Y ya auditadas (se saltan), Z en esta tanda». Una
  cuenta que no se pudo leer (token, permisos, error) **no se persiste** y
  vuelve a entrar en la siguiente tanda; si el motivo es token/permisos, la
  tanda se para.

Ejemplo del informe consolidado (base local sembrada con red inyectada):

```
──── INFORME CONSOLIDADO · 2 tienda(s) auditada(s) · madurez del ángulo entre 20 y 90 días · 2 producto(s) · 0 peticiones ────
 tienda   dominio     producto                   video  dias  activos  en Dropea          catalogo   auditoria    #
 Takuyi   takuyi.es   Cepillo de vapor           no     70    2        no                 disperso   2026-09-09   1
 Takuyi   takuyi.es   Gafas de sol polarizadas   no     60    2        sí (margen 82 %)   disperso   2026-09-09   1
  Takuyi · «Cepillo de vapor» · 70 días · https://www.facebook.com/ads/library/?id=t5
  Takuyi · «Gafas de sol polarizadas» · 60 días · https://www.facebook.com/ads/library/?id=t4
```

## Diseño original previsto (superado por la sonda)

- Tabla `hunter_deep_dives` (migración 32, aditiva): candidato (`variant_id`
  + `adlib_candidate_key` + `ad_id`), tienda detectada o «no localizable»,
  URL de producto, precio verificado y su vía, margen real contra
  `dropea_catalog.cost_eur`, análisis de la creatividad (gancho, ángulo,
  dolor, deseo, avatar, precio visible; modelo y fecha), anuncios activos y
  antigüedad (del nivel 1), conclusión `ganador_probable | senal_debil |
  descartar` con razonamiento, y las partes no verificables con su motivo.
- CLI `hunter:deep-dive -- --ids 12,45 | --min-score 80 --limite 5`, nunca
  sin filtro explícito; imprime el informe y lo persiste. Presupuesto por
  candidato (peticiones y tiempo), `EMERGENCY_STOP` y `OPENAI_DAILY_CALL_LIMIT`
  equivalente para OpenRouter.
- Visión por OpenRouter con un modelo Claude con imágenes; el prompt pide
  gancho, ángulo, dolor, deseo, avatar y precio visible, y devuelve JSON
  validado. La imagen se descarga desde `fbcdn` solo si la sonda confirma que
  se sirve sin sesión; si no, «creatividad no analizable automáticamente».
- Vídeo: solo si `ffmpeg` entra en la imagen Docker; si no, frames no.
- Tienda: petición simple + `/products/<handle>.js` para Shopify; no Shopify
  o bloqueo (Cloudflare, login) → «precio no verificable automáticamente».
  Sin técnicas de evasión.

## Estimación honesta (a confirmar con la sonda)

De los ~170 candidatos con match del lote de 300, lo que decide la tasa de
éxito es el paso 2. Tres escenarios:

| Si la sonda dice… | Informe completo | Se quedan en «no verificable» |
|---|---|---|
| `render_ad` con token devuelve el anuncio con enlace `l.php` e imagen descargable | 50–70 %: los que enlazan a una ficha Shopify accesible. El resto: tiendas no Shopify, bloqueadas, enlaces a Instagram/WhatsApp/formularios, vídeo sin `ffmpeg` | 30–50 % |
| `render_ad` devuelve el anuncio pero sin enlace saliente legible (solo iframe/JS) | ~0 % automático: tienda «no localizable», creatividad quizá sí (si la imagen aparece) | ~100 % en tienda/precio; análisis de creatividad parcial |
| `render_ad` devuelve login o desafío también con token | 0 %: el nivel 2 automático no es viable; queda revisión manual del snapshot por Pedro | 100 % |

El margen «real» solo se puede afirmar en el primer escenario y solo para
tiendas Shopify con la ficha pública accesible.
