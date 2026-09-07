# Auditoría de bugs del discovery de Hunter (07-09-2026)

Antes de desplegar nada del buscador de competencia, se auditó **todo** el
módulo existente (`src/lib/hunter/**` y sus scripts), no solo lo nuevo. Lo que
sigue son defectos **reproducidos**, cada uno con su fichero, su escenario de
fallo y su estado.

Los **nueve primeros están arreglados y con test**. Los **tres últimos** son
decisiones que Pedro tiene que tomar: no se han resuelto a propósito, porque no
son criterio técnico.

---

## Arreglados

### 1 · Un error a mitad tiraba la corrida entera y no guardaba nada
**Gravedad: crítica.** `client.ts` lanzaba un `Error` genérico ante cualquier
respuesta no-2xx; ni `search()` ni el bucle de términos de `service.ts` lo
capturaban; y `saveRun` era la última sentencia, dentro de una sola
transacción. Escenario: 26 términos, un 429 en el término 17 tras catorce
minutos de trabajo. Resultado: **cero filas persistidas**, cuota quemada y
ningún rastro de por qué.

Ahora: los errores se clasifican (`errors.ts`), el rate limit se reintenta con
backoff, y lo obtenido **se guarda igualmente** con su motivo de parada.

### 2 · Un token caducado no paraba nada: seguía consultando hasta morir
**Gravedad: crítica.** `probeAdLibraryFields` se traga los errores campo a
campo (por diseño: un campo opcional rechazado no debe invalidar la consulta).
Con un token caducado fallan los **catorce**, `fields` se queda prácticamente
vacío y `runDiscovery` seguía adelante lanzando búsquedas condenadas.

Ahora: si fallan todos los sondeos, se para en seco con `stop_reason =
token_invalido`. El código 190 nunca se reintenta.

### 3 · Dos productos del mismo anunciante podían compartir clave y tumbar la corrida
**Gravedad: crítica (crece con el volumen).** La huella hasheaba **solo los 30
primeros tokens en orden alfabético** del primer anuncio del grupo. Dos grupos
del mismo anunciante que compartieran esos 30 producían el mismo
`candidate_key`, y el segundo `INSERT` violaba `UNIQUE(query_id, candidate_id)`:
**rollback de toda la corrida**. Justo lo que una búsqueda de quince minutos
hace más probable.

Ahora: la huella cubre **todo el vocabulario del grupo**, las claves se
desduplican antes de salir, y el `INSERT` lleva `ON CONFLICT DO UPDATE` como
cinturón. Test con dos grupos que antes colisionaban.

### 4 · El filtro de ruido tiraba justo los anuncios COD que se buscan
**Gravedad: alta.** El veto era por palabra suelta:
`/(app|software|curso|formacion|seguro|hipoteca|consultoria|servicio|webinar|suscripcion|empleo)/`.
Ejecutado contra la función real: **«Pago seguro contra reembolso» → ruido**,
«Envío seguro y rápido» → ruido, «Servicio de atención al cliente 24h» → ruido.
En una búsqueda en España, eso descarta el vocabulario del contra reembolso, se
persiste con `noise=1` y nadie lo revisa.

Ahora: patrones por **frase** con su motivo («seguro de coche» sí, «pago
seguro» no), más una lista de marcas grandes por nombre del anunciante.

### 5 · Sin `estimated_audience_size`, todas las marcas grandes colaban en silencio
**Gravedad: media.** `Math.max(0, ...ads.map(a => a.audience?.upperBound ?? 0))`
da `0` cuando Meta no devuelve el campo, así que el filtro decía «no es marca
grande» sin tener el dato. Ahora, si nadie trae audiencia, ese filtro **no
opina** (y el nombre del anunciante sí puede delatar la marca).

### 6 · El registro de la corrida mentía sobre los campos pedidos
**Gravedad: media (auditoría).** `service.ts` guardaba `ADLIB_FIELDS`, la
constante entera, en vez del array que sobrevivió al sondeo. Si Meta rechazaba
un campo, `adlib_queries.fields_json` afirmaba que se había pedido.

### 7 · El momentum podía compararse contra sí mismo
**Gravedad: media.** La consulta del snapshot anterior no excluía la corrida en
curso. Al guardar por lotes, el candidato se comparaba con su propia fila y el
momentum salía siempre `debil`. Ahora se excluye `query_id`.

### 8 · La agrupación bloqueaba el proceso con un anunciante grande
**Gravedad: media.** Los tokens de cada anuncio se recalculaban **dentro** del
bucle de comparación, y se comparaba contra los grupos de **todos** los
anunciantes. Medido: 1.000 anuncios de un mismo `page_id` ≈ 6,5 s; 3.000 ≈ 65 s
de CPU síncrona, con SQLite síncrono al lado. Ahora se tokeniza una vez por
anuncio y se compara solo dentro del mismo anunciante.

### 9 · El discovery salía a Internet sin ningún interruptor de parada
**Gravedad: alta. Arreglado el 07-09 (aprobado por Pedro).** `safety.ts` solo
gobernaba WhatsApp y las escrituras en Shopify: `EMERGENCY_STOP` paraba el bot
pero el Cazador seguía llamando a Meta, con su cuota y su token.

Ahora hay `canRunDiscovery()` en `safety.ts`, junto a los demás gates, y se
comprueba en cuatro sitios: la búsqueda por palabra, la corrida de discovery,
el sondeo de campos y **cada petición suelta** del cliente, para que ningún
camino nuevo lo esquive. Con la parada activa no se ejecuta, no se reintenta y
no se encola: lanza `DiscoveryHaltedError` con el motivo y cómo levantarla.
A diferencia de WhatsApp, **no** exige `APP_MODE=production` ni allowlist:
investigar competencia debe funcionar en local. Ojo con la semántica heredada
del repo: la variable sin poner cuenta como PARADA (solo `EMERGENCY_STOP=0`
abre el paso).

---

## Anotados, no arreglados (son decisiones)

### 10 · `META_AD_LIBRARY_ACCESS_TOKEN` no está en el catálogo de variables
`env:doctor` y `readiness` no saben que el discovery la necesita. Se puede
declarar en `env-schema.ts` sin tocar el veredicto del perfil local.

### 11 · El momentum sigue siendo una etiqueta, no una traza
La regla (`activeAds ≥ 5` y `+2` sobre el snapshot anterior) está bien, pero se
guarda como palabra. Falta exponer el delta y la antigüedad del snapshot
anterior como razón legible, al estilo de las razones del scoring.

### 12 · Un anuncio pausado y relanzado se lee como nuevo
`ad_active_status=ACTIVE` está fijo y la antigüedad se calcula sobre los
anuncios activos. Un anunciante que pausa y relanza aparece más «joven» de lo
que es. Es un límite de la señal, no un bug: hay que decirlo al enseñarla.

---

## Las tres decisiones que quedan para Pedro

Ninguna es un bug ni criterio técnico mío: las tres cambian **qué promete el
producto** o **qué se considera parte de producción**, y eso no lo decide quien
escribe el código. Están sin resolver a propósito.

### Decisión 1 · ¿El Cazador es parte de producción o una herramienta aparte?

**Qué es.** `META_AD_LIBRARY_ACCESS_TOKEN` no está declarada en
`src/lib/config/env-schema.ts`, que es la fuente única de verdad sobre
variables. Consecuencia: `npm run env:doctor`, `npm run readiness` y
`npm run deploy:precheck` **no saben** que el discovery la necesita. Para esos
tres comandos, el Cazador no existe.

**Por qué lo decides tú.** Declararla obliga a elegir su `requiredFor`, y eso
es una declaración de intenciones, no un detalle:

| Opción | Qué significa | Efecto |
|---|---|---|
| No declararla (hoy) | el Cazador es una herramienta de investigación, fuera del sistema de producción | el despliegue nunca se bloquea por el Cazador; tampoco avisa de que le falta el token |
| Declararla sin `requiredFor` | existe y está documentada, pero es opcional | `env:doctor` la lista y dice si falta; ningún veredicto cambia |
| Declararla como requerida en `nas-production` | el Cazador es parte del producto desplegado | **un despliegue con el token caducado saldría BLOQUEADO** en `deploy:precheck` |

**Qué pasa si se deja como está.** El token puede caducar (como ya pasó el
02-09) y nadie se entera hasta que alguien lanza una búsqueda y no encuentra
nada. La comprobación pre-despliegue dará verde con el Cazador roto. Mi
recomendación, si sirve: la opción intermedia, declararla sin `requiredFor`.
Pero elegir entre las tres es tuyo.

### Decisión 2 · ¿El momentum se enseña como etiqueta o como cuenta?

**Qué es.** Hoy el momentum de un competidor se guarda como una palabra:
`fuerte`, `debil`, `sin_historico` o `sin_datos`. La regla que hay detrás
(cinco anuncios activos o más, y al menos dos más que la última vez) está en el
código, pero **no viaja con el dato**. En pantalla se lee «fuerte» y hay que
creérselo.

**Por qué lo decides tú.** No es cómo se calcula, es **qué se le enseña a
quien mira**. Convertirlo en una razón legible («12 anuncios activos, cuatro
más que hace tres días») significa exponer también la antigüedad del snapshot
anterior, y ahí aparece la parte incómoda: si la comparación es contra una
corrida de hace dos meses, «fuerte» dice muy poco. Enseñar la traza es
enseñar cuándo la señal es floja. Es la misma decisión que ya tomamos en el
scoring del Hunter, donde cada punto lleva su razón, pero aquí no la he tomado
por ti.

**Qué pasa si se deja como está.** El buscador enseña una etiqueta que parece
un veredicto y es una comparación con una fecha que no se ve. Riesgo real:
tomar una decisión de producto sobre un «fuerte» calculado contra un dato
viejo. No es incorrecto, es opaco.

### Decisión 3 · ¿Qué es «lleva X días activo» cuando el anunciante pausa y relanza?

**Qué es.** Las consultas piden `ad_active_status=ACTIVE`, fijo, y la
antigüedad se calcula sobre la fecha de inicio del anuncio activo más antiguo.
Un competidor que pausa una campaña y la relanza aparece **más joven de lo que
es**: su anuncio «nuevo» empezó ayer, aunque lleve meses vendiendo ese
producto.

**Por qué lo decides tú.** Arreglarlo no es un cambio de código pequeño ni
gratis: exige consultar también los anuncios inactivos (`ALL` en vez de
`ACTIVE`), lo que **multiplica los resultados y el consumo de cuota** dentro de
un presupuesto de quince minutos, y obliga a decidir qué se cuenta: ¿la fecha
del primer anuncio que le vimos alguna vez, aunque estuviera parado tres meses?
Eso ya no es «lleva X días activo», es otra métrica distinta. La pregunta de
negocio, que no es mía, es cuál de las dos te sirve para decidir si testear un
producto.

**Qué pasa si se deja como está.** La señal subestima a los competidores que
rotan creativos, que suelen ser precisamente los más profesionales. Hoy está
mitigado diciéndolo: la señal lleva escrito su límite y se marca como señal, no
como dato. Pero un número que subestima sigue siendo un número que subestima.

---

## Sobre los «puntos fijos» del PI Engine

La evaluación del 07-09 (`docs/HUNTER-PI-ENGINE-EVALUACION-07-09.md`) documentó
que el motor de la otra rama tenía una veintena de constantes inventadas y
puntuaciones literales. **Comprobado: ese patrón no se coló en el Hunter real.**
Las constantes de `src/lib/hunter/scoring.ts` llevan su fuente anotada, y las
del discovery son de mecánica (umbral de parecido 0,55, tope de páginas,
pausas), no puntuaciones de negocio. Las que no tenían justificación escrita se
anotaron en `docs/deploy/NUMEROS-SIN-FUENTE-v4.3.md`.
