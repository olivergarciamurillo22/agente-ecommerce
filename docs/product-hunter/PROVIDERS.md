# Fuentes del AI Winner Radar — documentación verificada

Fecha de verificación: **06-09-2026**. Lo que aquí figura como verificado se
leyó de la documentación oficial ese día; lo que figura como UNVERIFIED es
justo eso, y no se presenta como otra cosa.

## WinningHunter

Documentación: `https://app.winninghunter.com/docs` y `/docs/api`.

| Dato | Valor | Estado |
|---|---|---|
| Base | `https://app.winninghunter.com` | verificado |
| Auth | `X-API-Key: wh_...` (también Bearer y `?api_key=`) | verificado |
| Ritmo | 60 peticiones/minuto | verificado |
| Coste | 1 crédito por llamada medida | verificado |
| Paginación | token opaco `scroll`; `limit` por defecto 20, máx. 50 | verificado |

Endpoints usados: `GET /api/v1/credits`, `GET /api/v1/adlibrary`,
`POST /api/v1/tiktok-shop/products/explore`, `POST /api/v1/store-explorer`,
`POST /api/v1/trends/search`.

**Lo que NO está verificado:** el detalle por endpoint (nombres exactos de
parámetros y de campos de la respuesta) vive tras el login de la app y
devolvió 404 sin sesión. Por eso el mapeo prueba **varios nombres candidatos
por campo** y deja `null` lo que no encuentre, y las capacidades quedan en
`UNVERIFIED` hasta que `npm run hunter:providers:test` confirme la forma real
con una clave. Inventar esos nombres habría producido filas vacías con
aspecto de datos.

## Meta Ad Library

`GET https://graph.facebook.com/v21.0/ads_archive`

**La trampa que define la integración:** `ad_type=ALL` devuelve anuncios
**comerciales** solo cuando `ad_reached_countries` es un país de la **UE o
Reino Unido** — lo obliga la DSA. En cualquier otro país la misma llamada
responde 200 con anuncios **políticos** únicamente, sin error y sin aviso. Es
la misma clase de trampa que `read_all_orders` en Shopify. `assertCommercialScope()`
bloquea esas consultas en vez de devolver basura plausible.

Cuota: ~200 llamadas/hora en acceso estándar. Gratis.
Campos usados: solo los que la API entrega de verdad. Ni ventas, ni ROAS, ni
gasto, ni conversiones: no existen para anuncios comerciales.

## TikTok Research API

`https://open.tiktokapis.com/v2/research/adlib/ad/query/`, con token de
`client_credentials`. **Exige solicitud aprobada por TikTok.** Estado propio
`NOT_APPROVED`, distinto de `NOT_CONFIGURED`: no es lo mismo no tener
credenciales que tenerlas y que no te dejen entrar.

## Casamable (interno)

Sin credenciales. Lee de la propia base: tasas de entrega, envío y CPA por el
mismo camino que la Calculadora COD, y rendimiento histórico agregado. **Solo
agregados**: ni un teléfono, ni un correo, ni un pedido individual.

## Proveedores de suministro

**Solo lectura, y muy poco.** Dropea responde por PEDIDO, no por catálogo, así
que no hay "buscar producto por nombre". Dropi **no tiene API pública** y no se
ha implementado ningún cliente. Lo único que se puede afirmar hoy es el coste
de productos que ya vendemos (`product_costs`). Para un producto nuevo, el
coste lo mete Pedro a mano — y hasta que lo haga, la economía se muestra como
no disponible en vez de inventada.

Salvaguarda estructural: `providers/supplier.ts` no importa ni una función de
escritura, y hay un test que lee el fichero y falla si aparece alguna.
