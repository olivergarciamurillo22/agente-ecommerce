# Pedro — qué credenciales hace falta pedir para el Winner Radar

Documento **versionado**. Ninguna clave aparece aquí: solo qué es cada una,
dónde se saca y si de verdad hace falta.

> **Cambio del 06-09-2026.** El radar ya NO depende de WinningHunter. La
> fuente principal es la **Biblioteca de Anuncios de Meta**, que es gratuita
> y son los anuncios de verdad, publicados por las marcas, con su fecha de
> arranque real. Un agregador de pago es esa misma información cobrada, con
> retraso y con estimaciones encima que no se pueden auditar — y el día que
> sube de precio o cierra, el radar deja de existir.

## Resumen en una línea

**Solo hay que conseguir UNA cosa: el token de la Biblioteca de Anuncios de
Meta. Es gratis.** Todo lo demás o ya lo tenemos, o es opcional.

---

## 1 · META_AD_LIBRARY_ACCESS_TOKEN — la única que hace falta

| | |
|---|---|
| **ENV_NAME** | `META_AD_LIBRARY_ACCESS_TOKEN` |
| **PROVIDER** | Meta (Graph API — Ad Library) |
| **REQUIRED/OPTIONAL** | **REQUERIDA.** Es la fuente principal: sin ella no hay de dónde sacar anuncios |
| **WHERE_PEDRO_GETS_IT** | En la app de Meta que ya tenemos creada, generando un token de acceso para la Ad Library |
| **WHAT_PERMISSION_IS_NEEDED** | Acceso estándar a la Ad Library. **No** hace falta permiso especial para la UE |
| **HOW_TO_VALIDATE** | `npm run hunter:doctor` → `META CONNECTED` y `PROVIDER meta` |
| **DOES_IT_COST_MONEY** | **No.** Es gratis. Límite de ~200 llamadas/hora |
| **CAN_V1_RUN_WITHOUT_IT** | No. El panel abre y explica qué falta, pero no puede buscar |

**Importante, y no es un detalle:** esta API solo devuelve anuncios
**comerciales** cuando se consulta la **UE o Reino Unido** — lo obliga la DSA,
no es una decisión de Meta. Fuera de ahí, la misma llamada responde
correctamente pero con anuncios **políticos** únicamente, sin avisar. El
radar **bloquea** esas consultas a propósito en vez de devolver datos que
parecen buenos y no lo son. España es UE, así que nuestro caso funciona.

**No reutilizar el token de WhatsApp ni el de Meta Ads.** Es a propósito: si
un día se revoca uno, los otros siguen vivos.

---

## 2 · WINNINGHUNTER_API_KEY — ya NO hace falta

| | |
|---|---|
| **ENV_NAME** | `WINNINGHUNTER_API_KEY` |
| **PROVIDER** | WinningHunter |
| **REQUIRED/OPTIONAL** | **OPCIONAL.** El radar funciona entero sin ella |
| **WHERE_PEDRO_GETS_IT** | Entrando en `app.winninghunter.com` → sección **API** → crear clave. Empieza por `wh_` |
| **WHAT_PERMISSION_IS_NEEDED** | Plan **Basic o superior**. La clave sirve para todo el API programático |
| **HOW_TO_VALIDATE** | `docker exec casamable-agent npm run hunter:doctor` → debe decir `WINNINGHUNTER CONNECTED` y el saldo de créditos |
| **DOES_IT_COST_MONEY** | **Sí.** Es una suscripción de pago y **cada llamada consume 1 crédito**. Basic trae 100 créditos; Standard, 20.000 |
| **CAN_V1_RUN_WITHOUT_IT** | Sí. Solo sirve para contrastar con una segunda fuente, y hay que activarla con `WINNER_RADAR_PROVIDER=wh` o `=all` |

**No la contrates para esto.** Se mantiene el soporte porque el código ya
estaba escrito y quitarlo no aporta nada, pero con Meta configurada no se
consulta. Si algún día quieres comparar las dos fuentes, se activa con
`WINNER_RADAR_PROVIDER=all` y el panel enseña el consumo de créditos del día
antes de que llegue la factura.

---

## 3 · TIKTOK_RESEARCH_CLIENT_KEY y TIKTOK_RESEARCH_CLIENT_SECRET

| | |
|---|---|
| **ENV_NAME** | `TIKTOK_RESEARCH_CLIENT_KEY`, `TIKTOK_RESEARCH_CLIENT_SECRET` |
| **PROVIDER** | TikTok Research API |
| **REQUIRED/OPTIONAL** | **OPCIONAL**, y para más adelante |
| **WHERE_PEDRO_GETS_IT** | `developers.tiktok.com` → solicitar acceso a la **Research API** |
| **WHAT_PERMISSION_IS_NEEDED** | **Solicitud APROBADA por TikTok.** No basta con registrarse; revisan caso por caso y tardan |
| **HOW_TO_VALIDATE** | `npm run hunter:doctor` → `TIKTOK_RESEARCH CONNECTED`. Si dice `NOT_APPROVED`, las credenciales están pero TikTok aún no ha dado acceso |
| **DOES_IT_COST_MONEY** | No, pero la aprobación no está garantizada |
| **CAN_V1_RUN_WITHOUT_IT** | Sí. No lo pidas todavía |

El `client_secret` solo se usa en el servidor para pedir un token temporal y
**nunca se guarda en la base de datos**.

---

## 4 · Lo que YA TENEMOS y NO hay que pedir

| Qué | ENV | Estado |
|---|---|---|
| Modelo de lenguaje | `OPENAI_API_KEY` *o* `OPENROUTER_API_KEY` | **OPCIONAL.** Si hay clave de OpenAI se usa esa; si no, la de OpenRouter que Casamable ya tiene. No hace falta ninguna suscripción nueva |
| Datos de pedidos, entregas y rehúses | (ninguna) | **ALREADY_CONFIGURED** — salen de la propia base de datos |
| Tasas de entrega, envío y CPA | (ninguna) | **ALREADY_CONFIGURED** — del mismo sitio que la Calculadora COD |
| Costes de producto conocidos | (ninguna) | **ALREADY_CONFIGURED** — de `product_costs` |

Sin ninguna de las dos el radar **sigue funcionando**: interpreta los
criterios con un analizador determinista y se queda sin los resúmenes y sin
la clasificación del producto. Nada se rompe.

**Cuánto cuesta el modelo:** el trabajo en volumen (clasificar treinta o
cuarenta productos) va con el modelo barato, y el capaz se usa una o dos
veces por búsqueda — planificar las consultas y redactar el informe. Mandarlo
todo al caro multiplicaría la factura por diez sin mejorar nada.

---

## 5 · Dónde se ponen

En el `.env` del NAS, como todas las demás. **Nunca en el repositorio, nunca
por chat.** Después de añadirlas:

```bash
docker exec casamable-agent npm run hunter:doctor
docker exec casamable-agent npm run hunter:providers:test
```

Lo que tiene que salir con todo bien:

```
● PROVIDER      meta
● META          CONNECTED
● OPENAI        CONNECTED      (o OPENROUTER, o ◐ si no hay ninguna: no bloquea)
● JOBS          READY
◐ HISTORY       SIN_DATOS      (normal hasta la primera búsqueda terminada)
● SE PUEDE BUSCAR
```

El segundo hace la consulta más barata posible de cada fuente y enseña **qué
campos ha entendido** de la respuesta real. Es el que confirma que la
integración funciona de verdad: hasta que no se ve un anuncio con su
anunciante y su nombre, las capacidades quedan marcadas como `UNVERIFIED`.

---

## 6 · Qué NO hace falta pedir a nadie

- No hace falta ninguna cuenta nueva de Shopify, Dropea, Dropi ni Beeping.
- No hace falta acceso de escritura a ningún sitio: el radar **solo lee**.
- No hace falta n8n ni ninguna herramienta intermedia.
