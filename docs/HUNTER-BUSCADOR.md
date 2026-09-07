# Buscador de competencia por una palabra (07-09-2026)

Escribes una palabra («organizador cocina») y el motor busca en profundidad
durante un presupuesto de tiempo, agrupa lo encontrado **por competidor** y
enseña, de cada uno, señales de por qué **parece** que le funciona.

```
npm run hunter:search -- --palabra "organizador cocina"
npm run hunter:search -- --palabra "almohada" --minutos 15 --pais ES --dias 30
npm run hunter:search -- --palabra "..." --solo-terminos      # no sale a la red
npm run hunter:search -- --palabra "..." --json informe.json
```

---

## Lo primero: qué NO da esta API, y por qué no se enseña

La Ad Library de Meta **no expone gasto, impresiones ni CTR** de anuncios
comerciales normales. Esos datos solo existen para anuncios de temática social,
electoral o política, que no es nuestro caso. Cualquier pantalla que enseñe
«este anuncio gasta X al día» estaría inventándoselo.

Por eso cada señal que devuelve este buscador viene etiquetada:

| Etiqueta | Qué significa |
|---|---|
| `dato` | campo devuelto por la API, sin interpretar |
| `señal` | calculada por nosotros a partir de campos de la API; **sugiere**, no demuestra |
| `declarado` | texto que escribió el anunciante; no se ha verificado |

Y el propio comando imprime al final la lista de lo que no puede dar
(`NOT_AVAILABLE_FROM_AD_LIBRARY`), para que nadie lo prometa aguas abajo.

## Viabilidad real de las cuatro promesas del encargo

| Promesa | Veredicto | Por qué |
|---|---|---|
| Ver el **creativo real** (imagen o vídeo) | **NO VIABLE** | La API no devuelve ningún campo de media: solo `ad_snapshot_url`, que es el enlace a la **ficha del anuncio** en Facebook. Sacar los píxeles exigiría raspar una página con login y JavaScript, y este repo tiene regla escrita en contra. **Lo que sí se hace**: enlazar a la ficha, que es la evidencia trazable |
| **Dominio de la tienda** de destino | **PARCIAL** | Se extrae de `ad_creative_link_captions`, que Meta suele rellenar con el dominio de visualización del enlace, y **ya se pedía**. Coste: cero peticiones extra. Límite: es lo que **declara** el anunciante, puede ser una marca en vez del dominio real, y no se visita nada |
| **Días activo, variantes, países** | **PARCIAL, en tres partes** | *Días activo*: viable, derivado de `ad_delivery_start_time` del anuncio activo más antiguo. *Variantes creativas*: viable, textos distintos a la vez. *Países*: **no** como alcance real — cada consulta pide UN país, así que solo se puede decir en cuáles **lo hemos encontrado nosotros** |
| **15 minutos de paginación agresiva** | **VIABLE, tras la auditoría** | Requería los arreglos de `docs/HUNTER-DISCOVERY-AUDITORIA.md`: sin ellos, un 429 en el minuto 14 tiraba la corrida entera sin guardar nada |

## Cómo funciona

### 1 · Expansión determinista de la palabra

`expandSearchTerm` convierte la semilla en una batería de términos, y **cada
término dice de dónde sale**:

| Origen | Ejemplo con «organizador cocina» |
|---|---|
| `semilla` | organizador cocina |
| `sinonimo` | organizador hogar, organizador casa |
| `variante` | organizador cocinas (plural), sin acentos |
| `ingles` | organizador kitchen |
| `modificador` | comprar organizador cocina, organizador cocina barato, … contra reembolso |

**Nada lo inventa un modelo.** Los sinónimos y las traducciones viven en
`config/hunter-expansion.json`, que Pedro puede ampliar sin desplegar (se relee
por fecha de modificación). Lo que no esté ahí, no se busca. La misma palabra
produce siempre la misma batería, así que dos búsquedas son comparables.

### 2 · Presupuesto de la corrida

Tres frenos, y los tres dicen por qué pararon (`stop_reason`, guardado en
`adlib_queries`):

| Freno | Default | Qué es |
|---|---:|---|
| fecha límite | 15 min | tiempo de pared; no se empieza ninguna petición pasada la hora |
| tope de peticiones | 400 | peticiones HTTP contra la Graph API, **incluido el sondeo de campos** |
| cuota de Meta | 85 % | la cabecera `x-app-usage`, que antes se leía y se archivaba sin usar |

El más estricto gana. Si el presupuesto corta a mitad, **lo encontrado se
guarda igualmente** y el informe lo dice.

### 3 · Agrupación por competidor

Por `page_id` y parecido de los creativos (Jaccard ≥ 0,55). De cada competidor
se guardan sus anuncios, cuántos siguen activos y desde cuándo. El histórico
permite el momentum: cuántos anuncios activos tenía la última vez que miramos.

### 4 · Señales por competidor

| Señal | Etiqueta | Límite declarado |
|---|---|---|
| Días activo del anuncio más antiguo | señal | solo cuenta anuncios ACTIVOS: quien pausa y relanza se lee más joven |
| Anuncios activos | **dato** | — |
| Textos creativos distintos a la vez | señal | cuenta copy, no piezas de vídeo o imagen |
| Momentum | señal | dice contra cuántos anuncios se compara |
| Países en los que lo hemos encontrado | señal | una consulta = un país; no es alcance real |
| Dominio que declara el anuncio | declarado | no se visita ni se resuelve |

El **análisis cualitativo del creativo por IA** (qué gancho usa, si es UGC) NO
está implementado, y no es un olvido: `docs/HUNTER-DISCOVERY.md` dice hoy que el
texto creativo «nunca se reenvía a un modelo». Antes de escribir ese código
hace falta que Pedro derogue esa frase, y además habría que meter ese tipo de
llamada en el tope de gasto de IA (`docs/COSTE-IA.md`). Queda como decisión.

## Progreso en vivo

El comando imprime una línea por término conforme avanza, con anuncios
acumulados, peticiones gastadas y minutos restantes. Es legible en un log; no
es una barra que parpadea.

```
  [ 3/11] "organizador cocinas" · 47 anuncios · 21 peticiones · quedan 13 min
```

## En el panel: pestaña «Competencia»

Ya está construida (Crecimiento → Competencia). Cómo está montada, y por qué:

- **El panel solo ENCOLA.** `POST /api/hunter/competencia` crea una fila en
  `discovery_jobs` (migración 29) y devuelve. La búsqueda la ejecuta el
  **proceso del bot** (`startDiscoveryWorker`, junto al resto de trabajos
  largos). Una ruta de Next moriría en cada redespliegue y bloquearía su hilo
  durante la agrupación.
- **El progreso vive en la fila**, no en memoria: si el bot se reinicia a
  mitad no se pierde el rastro, y un trabajo colgado se marca como fallido en
  vez de bloquear la cola para siempre.
- **Una búsqueda a la vez.** Encolar una segunda se rechaza con motivo: dos
  partirían la cuota del mismo token.
- **Polling cada 4 s**, como el resto del panel. No hay ni un precedente de
  SSE ni WebSocket en este repo.
- **La parada de emergencia se ve ARRIBA**, en rojo, y el botón queda
  bloqueado. Lo mismo si falta el token. Nadie llega a lanzar una búsqueda que
  iba a fallar sin explicación.
- **Cada señal lleva su etiqueta** (`dato` / `señal` / `declarado`) y su
  límite al pasar el ratón. El dominio va marcado como declarado por el
  anunciante y sin verificar. Nunca se escribe «disponible en X países»: solo
  «países en los que lo hemos encontrado».
- **Sin análisis del creativo por IA**: desactivado, y así se dice en la
  propia pantalla.

## Lo que hace falta para usarlo de verdad

`META_AD_LIBRARY_ACCESS_TOKEN` (o `META_ADS_ACCESS_TOKEN`) en el entorno. Sin
token el comando **no inventa nada**: dice que falta y sale con código 2.

Estado del token a día de hoy: `docs/ADLIB-CAMPOS.md` registra que el 05-09 los
catorce campos devolvieron el mismo error de token caducado. Hasta renovarlo,
todo lo de aquí está probado con red inyectada, pero **no se ha ejecutado una
búsqueda real**. Son dos bloqueos distintos y renovar el token solo resuelve el
primero: (1) el token caducado, y (2) que la app tenga acceso concedido a
`/ads_archive`. `npm run hunter:discovery:doctor` distingue uno de otro.
