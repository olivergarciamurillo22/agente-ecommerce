# Auditor de tiendas ganadoras (07-09-2026)

Dos modos sobre el mismo motor:

- **Modo A · una tienda.** Pegas la URL de una tienda y el sistema te dice qué
  vende (catálogo público si es Shopify), cuántos anuncios activos tiene en la
  Ad Library de Meta y desde cuándo, y qué ángulos usa **citando el texto real
  de cada anuncio** como evidencia.
- **Modo B · un nicho.** Escribes una palabra («barra de apoyo»), el buscador
  por palabra ya existente encuentra a los anunciantes, se eligen los que
  **destacan** por un criterio escrito, y a cada uno se le aplica el modo A en
  cadena, dentro del mismo presupuesto de quince minutos.

```
# Panel: pestaña Competencia → «Auditar una tienda» / «Buscar tiendas ganadoras» (con «auditar en cadena»)

npm run hunter:audit -- --tienda casamable.es
npm run hunter:audit -- --tienda tienda.es --facebook https://www.facebook.com/latienda
npm run hunter:audit -- --tienda tienda.es --solo-tienda        # solo portada + catálogo: NO toca Meta
npm run hunter:audit -- --nicho "barra de apoyo" --minutos 15
npm run hunter:audit -- ... --json informe.json
```

Módulos: `src/lib/hunter/audit/store.ts` (lector de tienda), `angles.ts`
(ángulos con cita), `store-audit.ts` (modo A), `winner-hunt.ts` (modo B);
cola `discovery/jobs.ts` con tipos `busqueda | auditoria | cadena` (migración
30, aditiva); vista `components/StoreAuditView.tsx`.

---

## Lo primero: qué se pudo hacer de verdad y qué no

| Promesa del encargo | Veredicto | Por qué |
|---|---|---|
| Leer **qué vende** la tienda | **VIABLE solo si es Shopify** | Shopify publica `/products.json?limit=250&page=N` sin autenticación. Se lee con un User-Agent propio e identificable, 8 s de timeout, tope de 4 páginas (1.000 productos: se marca `truncated`). Una tienda que no es Shopify (Prestashop, WooCommerce, a medida) devuelve 404 y se declara `no_shopify`: **no se inventa catálogo**. La moneda no viene en el JSON: los precios se enseñan como números, sin afirmar divisa |
| Resolver su **página de Facebook** | **PARCIAL: alias sí, page_id no** | De la portada salen enlaces `facebook.com/<alias>` (se descartan `sharer`, `plugins`, `login`, `tr`). El alias **no es el page_id numérico** que la Ad Library entiende. Convertirlo exige raspar Facebook (prohibido por las reglas del repo, y además pide login y JavaScript) o un token de página con permiso PPCA/PPMA que no tenemos. Alternativa honesta: el usuario pega la URL de la Ad Library de esa página (`view_all_page_id=123…`) o `facebook.com/profile.php?id=123…`; ese número sí se usa |
| Listar sus **anuncios activos** en la Ad Library | **PARCIAL** | Sin page_id, se busca por `search_terms` con el nombre de marca, el dominio sin TLD y el alias de Facebook (máximo 3 términos, 3 páginas cada uno). **`search_terms` busca en el texto del anuncio, no en el nombre del anunciante**: un anuncio de la marca que no la mencione en cuerpo, título o caption no aparecerá. Con page_id se consulta `search_page_ids`, que es exacto, pero **nunca se ha probado en vivo en este repo** (el token sigue caducado) |
| **Atribuir** un anuncio a la tienda | **VIABLE, por pruebas honestas** | Solo se atribuye si el anunciante se llama como la marca (`nombre_marca`), si el dominio declarado en `ad_creative_link_captions` es el de la tienda (`dominio_declarado`), si el alias de Facebook coincide con el nombre del anunciante (`alias_facebook`) o si el page_id casa (`page_id`). Un anuncio de **otra marca** que mencione «tienda uno» en su texto **no se atribuye** (hay test) |
| Los **ángulos** que usa | **VIABLE como heurística, con cita obligatoria** | Nueve reglas sobre el texto real (precio/oferta, urgencia/escasez, prueba social, dolor/beneficio, garantía/devolución, envío/pago, regalo/ocasión, autoridad/calidad, facilidad de uso). Cada ángulo lleva la **frase literal** del anuncio (≤180 caracteres), el id del anuncio y el campo. La etiqueta se marca `heuristica_sobre_texto_real`: la cita es el dato, la etiqueta es nuestra lectura. **No se analiza ninguna imagen ni vídeo** |
| **Gasto, ventas, CTR, tráfico** | **NO VIABLE** | La Ad Library no lo da para anuncios comerciales y el catálogo público no expone ventas. La ficha lo lista en «No disponible» para que nadie lo prometa aguas abajo |

Todo lo que no se pudo completar en una auditoría concreta viaja en
`incomplete: [{ part, reason }]` y se pinta **arriba** de la ficha, no
escondido.

## Modo A, paso a paso

1. **Portada** (`GET /`): `og:site_name` → `og:title` → `<title>` como nombre
   de marca (se limpia: `Casamable™` → `casamable`; solo se quitan prefijos
   genéricos como «tienda online» o «www», nunca «Tienda» a secas porque
   «Tienda Uno» es un nombre). Pistas de Shopify: `cdn.shopify.com`, objeto
   `Shopify` en el HTML, rutas `/cdn/shop/`, cabecera `x-shopid`, «Powered by
   Shopify». Bloqueos (401/403/429, redirección a login, desafío anti-bot)
   se declaran; la palabra «captcha» sola no cuenta porque toda portada de
   Shopify carga `captcha-bootstrap`.
2. **Catálogo**: se intenta `/products.json` aunque no haya pistas de
   Shopify (hay temas que no las dejan). Una página con menos de 250
   productos termina la paginación.
3. **Facebook**: enlace de la web; si no hay, el que pegó el usuario (con
   nota de que viene del usuario). Si la URL trae un page_id numérico, se
   usa.
4. **Ad Library**: con page_id → `search_page_ids`; si devuelve algo, no se
   busca por texto. Sin page_id (o si no devolvió nada) → hasta 3 términos por
   texto. Presupuesto propio: 3 minutos y 60 peticiones. Los grupos del
   buscador («página + línea de producto») se **funden por página**: la
   unidad de una auditoría es la tienda, no cada producto.
   Un fallo de Meta (HTTP 400 por un campo rechazado, por ejemplo) se
   devuelve como `error` con el mensaje, **no** como «no anuncia».
5. **Ángulos** sobre los anuncios atribuidos.

## Modo B: criterio, presupuesto y tope

**Unidad**: la página anunciante. El buscador agrupa por «página + línea de
producto»; aquí se suman los grupos de una misma página (activos sumados,
días activo del grupo más veterano, variantes sumadas, momentum «fuerte» si
lo es en alguno). Sin esto, una tienda con dos productos distintos de un
anuncio cada uno nunca llegaría al mínimo.

**Criterio de «destaca»**, literal (`STANDOUT_CRITERION`, viaja en el
informe):

```
no ruido · anuncios activos ≥ 2 · (días activo ≥ 14 o textos distintos ≥ 2)
orden = activos×3 + min(días,90)/10 + variantes×2 + (momentum fuerte: +5)
```

Es una ordenación por señales indirectas y así se etiqueta en pantalla:
sugiere, no demuestra. Los países no entran: solo sabemos dónde lo hemos
buscado nosotros. Cada candidata lleva `score.why` con los números que la
metieron.

**Presupuesto, uno solo** (quince minutos por defecto, `budgetSplit` en el
informe):

| Fase | Tiempo | Peticiones a Meta |
|---|---|---|
| Búsqueda por palabra | 60 % | 70 % |
| Auditorías en cadena | el resto | **0**: reutilizan los anuncios ya bajados |

Cada auditoría del modo B gasta tiempo (portada + hasta 2 páginas de
catálogo) pero **ninguna petición a Meta**: los anuncios de cada página ya
están en mano (`adsByCandidate` del buscador, que no se persiste en la fila
de la cola). Se reservan 25 s por auditoría; cuando no quedan, la candidata
queda `sin_tiempo` y el informe para con `deadline`.

**Tope explícito**: `MAX_AUDITS_PER_RUN = 5` auditorías por corrida. Las
demás candidatas se listan con su puntuación y `no_seleccionada`. Una
candidata sin dominio declarado en sus anuncios queda `sin_tienda_resuelta`:
se le sacan los ángulos, pero no hay tienda que leer (y no se adivina).

**EMERGENCY_STOP** manda en todo: con la parada no se lee ninguna web ajena
(ni la portada), no se consulta Meta, no se encola ni se reclama ningún
trabajo, y `runStoreAudit` / `runWinnerHunt` lanzan `DiscoveryHaltedError`.
Hay test de «cero peticiones» para las dos partes.

## Cómo se verificó

**Con red inyectada** (`npm test`, bloque `AUDITOR ·`): una tienda Shopify
falsa con 262 productos en dos páginas, una no-Shopify, una bloqueada por
anti-bot y una Ad Library falsa que responde por `search_terms` y por
`search_page_ids`. Cubre: lectura y paginación con UA propio, no visitar
Facebook, ángulos con cita, atribución honesta (la marca ajena que menciona
el nombre no se atribuye), `incomplete`, error de Meta ≠ sin resultados,
page_id pegado, EMERGENCY_STOP con cero peticiones, criterio y suma por
página, reparto del presupuesto, tope por corrida, `sin_tiempo`,
`sin_tienda_resuelta`, cola por tipos, vigilante, ruta y migración 30.

**Contra tiendas reales, SOLO la lectura pública de la tienda**
(`--solo-tienda`, sin tocar Meta; el token de la Ad Library sigue sin renovar
y no se ha hecho ninguna llamada real):

| Tienda | Shopify | Marca (fuente) | Facebook en la web | Catálogo |
|---|---|---|---|---|
| casamable.es | sí | Casamable™ (og:site_name) | no | 12 productos, 29,99–54,99 |
| bienestarsenior.com | sí | Bienestar Senior (og:site_name) | facebook.com/bienestarsenior | 1.000+ (truncado a 4 páginas) |
| dortomedical.com | sí | Dortomedical (og:site_name) | facebook.com/dortomedical | 1.000+ (truncado) |
| ortoprime.es | sí | (og:site_name) | no | 250+ |
| latiendadelabuelito.es | no | título largo con keywords | facebook.com/latiendadelabuelito.es | `no_shopify` (404 en /products.json) |
| lacasadelenfermo.es, asister.es | — | — | — | portada HTTP 404 → `no_accesible` |
| grupolasmimosas.com, ayudasdiarias.com | no | — | — | `no_shopify` |

Conclusión honesta: el catálogo se obtiene de verdad en las tiendas Shopify
del nicho; en el resto se declara. El enlace a Facebook aparece en la mitad
de las portadas. Ninguna de esas lecturas permite llegar al page_id.

## Ejemplo de principio a fin (red inyectada)

`runWinnerHunt({ seed: "barra de apoyo" })` con una Ad Library simulada de
tres anunciantes: «Tienda Uno» (2 anuncios distintos desde julio, dominio
declarado tiendauno.es), «Tienda Dos» (1 anuncio) y «Academia» (curso online).

1. Búsqueda: 3 términos («barra de apoyo», «barra de apoyos», «comprar
   barra de apoyo»), 4 anuncios únicos, 18 peticiones (15 de la sonda de
   campos + 3 de búsqueda) → 2 páginas anunciantes (Academia descartada
   como ruido: «formación o infoproducto»).
2. Criterio: Tienda Uno destaca (`2 activos, 68 días activa, 2 textos
   distintos`, señal 2×3 + 68/10 + 2×2 = 16,8); Tienda Dos no (1 activo).
3. Auditoría de tiendauno.es sin volver a Meta: portada Shopify, 262
   productos (19,90–…), tipos «Movilidad» y «Baño», Facebook
   `facebook.com/tiendauno`; anuncios atribuidos por `page_id` (ya venían
   del buscador); ángulos: *envío/pago* («Envío gratis y pago contra
   reembolso»), *prueba social* («Más de 2.000 clientes satisfechos»),
   *precio/oferta* y *urgencia* («Solo hoy: 30% de descuento… Últimas
   unidades»).
4. Peticiones a Meta: 18, exactamente las de la búsqueda (la auditoría no
   añadió ninguna). Parada `completado`. `incomplete` vacío.
   `notAvailable`: gasto, creativo, page_id desde la web, ventas.

Con la Ad Library real el paso 1 depende del token (caducado) y el paso 3
de que el anunciante declare su dominio en el caption; si no lo declara, la
candidata sale `sin_tienda_resuelta` con sus ángulos y sin tienda.

## Pendiente que exige a Pedro

- Renovar `META_AD_LIBRARY_ACCESS_TOKEN` y correr `hunter:discovery:doctor`:
  confirma los 15 campos (incluido `ad_creative_link_descriptions`, nuevo) y
  permite probar `search_page_ids` por primera vez.
- Decidir si el modo A debe sondear campos antes de buscar (hoy no: cuesta
  15 peticiones; el fallo se declara como `error`, no se enmascara).
