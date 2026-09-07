# Auditoría de bugs del discovery de Hunter (07-09-2026)

Antes de desplegar nada del buscador de competencia, se auditó **todo** el
módulo existente (`src/lib/hunter/**` y sus scripts), no solo lo nuevo. Lo que
sigue son defectos **reproducidos**, cada uno con su fichero, su escenario de
fallo y su estado.

Los ocho primeros están **arreglados y con test**. Los cuatro últimos son
**decisiones o límites** que quedan anotados, no arreglados.

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

---

## Anotados, no arreglados (son decisiones)

### 9 · El discovery sale a Internet sin ningún gate
`src/lib/safety.ts` solo gobierna WhatsApp y las escrituras en Shopify. Una
búsqueda no pasa por `EMERGENCY_STOP` ni por modo seguro: un botón pulsable en
bucle multiplicaría las llamadas contra un token compartido. **Mitigado en
parte** por el presupuesto de la corrida, pero no hay interruptor de
emergencia. Decisión pendiente: añadir la búsqueda a los gates o darle su
propia llave, como se hizo con las llamadas de teléfono.

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

## Sobre los «puntos fijos» del PI Engine

La evaluación del 07-09 (`docs/HUNTER-PI-ENGINE-EVALUACION-07-09.md`) documentó
que el motor de la otra rama tenía una veintena de constantes inventadas y
puntuaciones literales. **Comprobado: ese patrón no se coló en el Hunter real.**
Las constantes de `src/lib/hunter/scoring.ts` llevan su fuente anotada, y las
del discovery son de mecánica (umbral de parecido 0,55, tope de páginas,
pausas), no puntuaciones de negocio. Las que no tenían justificación escrita se
anotaron en `docs/deploy/NUMEROS-SIN-FUENTE-v4.3.md`.
