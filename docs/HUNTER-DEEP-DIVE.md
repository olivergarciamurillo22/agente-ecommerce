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
