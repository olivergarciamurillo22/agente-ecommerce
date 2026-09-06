# Pedro — qué credenciales hace falta pedir para el AI Winner Radar

Documento **versionado**. Ninguna clave aparece aquí: solo qué es cada una,
dónde se saca y si de verdad hace falta.

## Resumen en una línea

**Solo hay que conseguir UNA cosa para empezar: la clave de WinningHunter.**
Todo lo demás o ya lo tenemos, o es opcional.

---

## 1 · WINNINGHUNTER_API_KEY

| | |
|---|---|
| **ENV_NAME** | `WINNINGHUNTER_API_KEY` |
| **PROVIDER** | WinningHunter |
| **REQUIRED/OPTIONAL** | **REQUERIDA** — sin ella no hay ninguna fuente de anuncios |
| **WHERE_PEDRO_GETS_IT** | Entrando en `app.winninghunter.com` → sección **API** → crear clave. Empieza por `wh_` |
| **WHAT_PERMISSION_IS_NEEDED** | Plan **Basic o superior**. La clave sirve para todo el API programático |
| **HOW_TO_VALIDATE** | `docker exec casamable-agent npm run hunter:doctor` → debe decir `WINNINGHUNTER CONNECTED` y el saldo de créditos |
| **DOES_IT_COST_MONEY** | **Sí.** Es una suscripción de pago y **cada llamada consume 1 crédito**. Basic trae 100 créditos; Standard, 20.000 |
| **CAN_V1_RUN_WITHOUT_IT** | No para buscar de verdad. La interfaz y el análisis funcionan, pero no hay de dónde sacar anuncios |

**Cuánto se gasta en la práctica:** una búsqueda lanza hasta 8 consultas y el
sistema tiene un tope duro de **24 llamadas por búsqueda**. Con el plan Basic
(100 créditos) salen unas 4-8 búsquedas al mes; si se va a usar en serio,
hace falta un plan mayor. El panel enseña el consumo del día antes de que
llegue la factura.

---

## 2 · META_AD_LIBRARY_ACCESS_TOKEN

| | |
|---|---|
| **ENV_NAME** | `META_AD_LIBRARY_ACCESS_TOKEN` |
| **PROVIDER** | Meta (Graph API — Ad Library) |
| **REQUIRED/OPTIONAL** | **OPCIONAL** — añade una segunda fuente y sube la confianza de los resultados |
| **WHERE_PEDRO_GETS_IT** | En la app de Meta que ya tenemos creada, generando un token de acceso para la Ad Library |
| **WHAT_PERMISSION_IS_NEEDED** | Acceso estándar a la Ad Library. **No** hace falta permiso especial para la UE |
| **HOW_TO_VALIDATE** | `npm run hunter:doctor` → `META_AD_LIBRARY CONNECTED` |
| **DOES_IT_COST_MONEY** | **No.** Es gratis. Límite de ~200 llamadas/hora |
| **CAN_V1_RUN_WITHOUT_IT** | Sí, perfectamente |

**Importante, y no es un detalle:** esta API solo devuelve anuncios
**comerciales** cuando se consulta la **UE o Reino Unido** — lo obliga la DSA,
no es una decisión de Meta. Fuera de ahí, la misma llamada responde
correctamente pero con anuncios **políticos** únicamente, sin avisar. El
radar **bloquea** esas consultas a propósito en vez de devolver datos que
parecen buenos y no lo son. España es UE, así que nuestro caso funciona.

**No reutilizar el token de WhatsApp ni el de Meta Ads.** Es a propósito: si
un día se revoca uno, los otros siguen vivos.

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
| Modelo de lenguaje | `OPENROUTER_API_KEY` | **ALREADY_CONFIGURED** — se reutiliza el que ya usa Casamable. No hace falta ninguna suscripción nueva |
| Datos de pedidos, entregas y rehúses | (ninguna) | **ALREADY_CONFIGURED** — salen de la propia base de datos |
| Tasas de entrega, envío y CPA | (ninguna) | **ALREADY_CONFIGURED** — del mismo sitio que la Calculadora COD |
| Costes de producto conocidos | (ninguna) | **ALREADY_CONFIGURED** — de `product_costs` |

Sin `OPENROUTER_API_KEY` el radar **sigue funcionando**: interpreta los
criterios con un analizador determinista y se queda sin los resúmenes y sin
la clasificación del producto. Nada se rompe.

---

## 5 · Dónde se ponen

En el `.env` del NAS, como todas las demás. **Nunca en el repositorio, nunca
por chat.** Después de añadirlas:

```bash
docker exec casamable-agent npm run hunter:doctor
docker exec casamable-agent npm run hunter:providers:test
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
