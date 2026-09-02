# CASAMABLE PRODUCT INTELLIGENCE ENGINE — PROJECT HANDOFF

**Estado del documento:** handoff técnico completo  
**Fecha de referencia:** 2026-09-02  
**Proyecto:** Casamable Agent / Ecommerce Agent  
**Objetivo:** dejar documentado todo lo construido, lo que ha fallado, por qué ha fallado, qué falta y cuál debe ser el orden exacto de los siguientes pasos.

---

# 0. RESUMEN EJECUTIVO

Se ha diseñado e implementado un nuevo subsistema independiente dentro del agente de Casamable denominado conceptualmente:

`Winning Product Intelligence Engine`

Su objetivo es convertir el product research manual de Meta Ad Library en un sistema propio de inteligencia de producto capaz de:

- buscar productos;
- investigar keywords;
- generar nuevas keywords;
- analizar anunciantes;
- agrupar anuncios por producto;
- medir longevidad;
- medir velocidad creativa;
- medir saturación;
- detectar momentum;
- analizar hooks, pains, ángulos y audiencias;
- consumir economics existentes;
- asignar un Opportunity Score;
- clasificar lifecycle;
- mantener watchlist;
- generar señales;
- crear dossiers;
- operar en modo Manual Research;
- operar en modo Auto Hunt;
- persistir estado;
- recuperarse de fallos;
- funcionar 24/7 en el NAS;
- y, en el futuro, aprender de los resultados reales de Casamable.

El sistema está técnicamente:

`READY WITH BLOCKER`

El único blocker funcional actual es:

`META AD LIBRARY AUTHORIZATION`

El código ya está preparado para conectarse a `/ads_archive`, pero Meta rechaza actualmente la operación con:

`Application does not have permission for this action`

La identidad del usuario está en proceso de verificación por Meta.

NO se debe intentar rodear esta limitación mediante scraping, endpoints privados o métodos alternativos.

---

# 1. REGLA PRINCIPAL DEL PROYECTO

## NO ROMPER NI MODIFICAR FUNCIONALIDAD EXISTENTE

Todo el Product Intelligence Engine se ha diseñado con una regla absoluta:

> añadir capacidades sin interferir con lo ya creado.

El agente existente ya dispone de:

- Meta Ads de cuenta;
- lectura de gasto;
- lectura de estadísticas;
- campaigns/adsets/ads;
- economics;
- calculadora;
- estimaciones;
- WhatsApp;
- pedidos;
- otras automatizaciones;
- dashboard;
- ejecución 24/7 en NAS.

El nuevo módulo NO debe alterar esas capacidades.

Principios:

```text
ADD > MODIFY
ADAPTER > REWRITE
READ ONLY > MUTATION
NEW MODULE > REFACTOR
FEATURE FLAG > FORCED ENABLE
DRY RUN > DIRECT EXECUTION
NEW DATA > ALTER EXISTING DATA
ISOLATION > COUPLING
DETERMINISTIC METRIC > LLM GUESS
REAL ZERO RESULTS > INVENTED RESULTS
```

---

# 2. VISIÓN DEL SISTEMA

La visión completa es:

```text
META AD LIBRARY / AD SOURCES
          ↓
DISCOVERY
          ↓
QUERY ENGINE
          ↓
NORMALIZATION
          ↓
PRODUCT CLUSTERING
          ↓
ADVERTISER INTELLIGENCE
          ↓
CREATIVE INTELLIGENCE
          ↓
LONGEVITY
          ↓
CREATIVE VELOCITY
          ↓
SATURATION
          ↓
MOMENTUM
          ↓
ECONOMICS
          ↓
CASAMABLE FIT
          ↓
OPPORTUNITY SCORE
          ↓
LIFECYCLE
          ↓
WATCHLIST
          ↓
SIGNALS
          ↓
PRODUCT DOSSIER
          ↓
HUMAN APPROVAL
          ↓
PRODUCT TEST
```

Futuro:

```text
PRODUCT TEST
     ↓
REAL META PERFORMANCE
     ↓
CPA / CVR / ROAS / RETURNS
     ↓
OUTCOME DATABASE
     ↓
SCORING CALIBRATION
     ↓
BETTER PRODUCT RESEARCH
```

---

# 3. PERFIL DE PRODUCTO CASAMABLE

El sistema se ha diseñado inicialmente para priorizar productos coherentes con Casamable.

Hipótesis inicial:

```text
problema fuerte
solución clara
demostración visual
before/after
mercado amplio
especialmente 40+
COD friendly
PVP aproximado 25–50 €
coste bajo
margen alto
producto pequeño
fácil envío
sin tallas
bajo riesgo de rotura
bajo riesgo de devolución
explicación sencilla
múltiples hooks
```

Familias de producto de interés inicial:

```text
dolor
movilidad
pies
uñas
juanetes
cervical
postura
descanso
limpieza
hogar
mascotas
comodidad
personas mayores
```

Esto es un PRIOR, no una restricción absoluta.

---

# 4. MODOS DE RESEARCH

El sistema tiene dos puntos de entrada obligatorios.

## 4.1 MANUAL SEED RESEARCH

El usuario escribe una palabra.

Ejemplo:

`almohada cervical`

La regla es absoluta:

> La primera búsqueda real enviada al provider debe ser EXACTAMENTE la palabra introducida por el usuario.

Flujo:

```text
USER INPUT
   ↓
SEARCH EXACT USER QUERY
   ↓
ANALYZE RESULTS
   ↓
STORE ROOT FINDINGS
   ↓
GENERATE DERIVED QUERIES
   ↓
EXPAND
   ↓
PRIORITIZE
   ↓
CONTINUE RESEARCH
```

No se debe:

- traducir primero;
- generar sinónimos primero;
- sustituir la query;
- reinterpretar antes del primer request.

Ejemplo correcto:

```text
Input:
almohada cervical

First provider call:
almohada cervical
```

Después pueden aparecer:

```text
almohada ortopédica cervical
dolor cervical
cervical pillow
almohada viscoelástica cervical
```

## 4.2 AUTO HUNT

El segundo modo no necesita palabra del usuario.

Concepto:

`AUTO HUNT`

Flujo:

```text
Casamable profile
    ↓
Seed Generator
    ↓
Priority Query Queue
    ↓
Search
    ↓
Analyze
    ↓
Find Products
    ↓
Find Advertisers
    ↓
Generate More Queries
    ↓
Score Queries
    ↓
Prioritize
    ↓
Repeat
```

Actualmente:

`AUTO HUNT 24/7 = OFF`

Y debe permanecer OFF hasta validar datos reales de Meta.

Existe/preparado un:

`AUTO HUNT SAFE MODE`

para hacer pruebas limitadas.

---

# 5. ADAPTIVE QUERY EXPLORATION ENGINE

El sistema NO utiliza una lista estática de keywords como única fuente.

Las keywords iniciales son semillas.

Puede generar nuevas queries desde:

```text
productos
aliases
copies
hooks
pain points
audiencias
landing pages
competidores
catálogos
categorías
productos relacionados
queries anteriores exitosas
histórico futuro de productos ganadores
```

---

# 6. EJEMPLO DE EXPANSIÓN

```text
dolor pies
│
├── durezas
│   ├── limador eléctrico
│   ├── callus remover
│   └── electric foot file
│
├── juanetes
│   ├── hallux valgus
│   ├── férula hallux
│   └── corrector nocturno
│
└── talones
    ├── talones agrietados
    └── foot care
```

Las ramas con mejores resultados reciben más prioridad.

Las ramas agotadas se detienen.

---

# 7. QUERY QUEUE

Existe/preparada una cola persistente de queries.

Conceptualmente:

```text
query_id
query
normalized_query
root_query_id
parent_query_id
source
depth
priority
status
created_at
last_run_at
times_run
results_count
new_products_found
new_advertisers_found
qualified_products_found
query_score
```

Estados:

```text
PENDING
RUNNING
COMPLETED
LOW_VALUE
PAUSED
EXHAUSTED
FAILED
```

---

# 8. QUERY SOURCES

Una query puede venir de:

```text
USER
SEED
PRODUCT_NAME
PRODUCT_ALIAS
AD_COPY
HOOK
PAIN_POINT
AUDIENCE
LANDING_PAGE
COMPETITOR
RELATED_PRODUCT
LLM_EXPANSION
SUCCESSFUL_QUERY
HISTORICAL_WINNER
```

El origen debe guardarse.

---

# 9. QUERY SCORING

Cada query puede recibir score basado en:

```text
unique_products_found
unique_advertisers_found
qualified_product_rate
average_opportunity_score
duplicate_rate
empty_result_rate
novelty
Casamable fit
```

Ejemplo:

```text
Query:
limador eléctrico durezas

Results:
43

New products:
7

New advertisers:
5

Qualified products:
2

query_score:
91/100
```

---

# 10. PROTECCIONES DEL QUERY ENGINE

Implementadas/preparadas:

- deduplicación;
- normalización;
- loop detection;
- branch pruning;
- max depth;
- max children per query;
- max provider calls;
- max pages;
- query budget;
- diminishing returns;
- duplicate-rate protection.

Ejemplo de loop a impedir:

```text
A → B
B → C
C → A
```

También:

```text
A español
→ A inglés
→ A español
```

---

# 11. STOPPING ENGINE

Una rama puede marcarse:

`EXHAUSTED`

si:

```text
N queries sin nuevos productos
duplicate rate demasiado alto
query score demasiado bajo
cero qualified products durante N iteraciones
```

---

# 12. SEARCH UNTIL TARGET

El sistema está diseñado para poder recibir objetivos.

Ejemplo:

```text
find:
5 products

with:
Opportunity Score >= 80
Casamable Fit >= 80
Economics >= 70
Advertisers <= 5
Oldest active ad >= 20d
```

El motor puede seguir explorando hasta:

`qualified_products >= target`

o hasta alcanzar el budget.

---

# 13. PRODUCT INTELLIGENCE CORE

Métricas y análisis diseñados:

- Ad Longevity
- Active Ratio
- Creative Velocity
- Creative Acceleration
- Advertiser Growth
- Saturation
- Casamable Fit
- Economics
- Momentum
- Opportunity Score
- Lifecycle
- Confidence
- Recommendation

---

# 14. AD LONGEVITY

Buckets iniciales:

```text
0–2 días      probable testing
3–7 días      weak signal
8–14 días     interesting
15–30 días    strong
30–60 días    very strong
60+ días      validated
```

Importante:

> ad largo NO equivale automáticamente a rentable.

Es una señal probabilística.

Métricas:

```text
ad_age_days
median_ad_age
mean_ad_age
max_ad_age
active_ads
inactive_ads
active_ratio
oldest_active_ad
```

---

# 15. CREATIVE VELOCITY

Ventanas:

```text
24h
3d
7d
14d
30d
```

Señal importante:

```text
OLD ADS STILL ACTIVE
+
NEW CREATIVES APPEARING
```

Puede indicar:

- scaling;
- iteration;
- aggressive testing.

Por eso siempre se combina con otras señales.

---

# 16. PRODUCT CLUSTERING

Objetivo:

No tratar como productos distintos:

```text
Corrector Hallux
Corrector de juanetes
Férula Hallux Valgus
Férula correctora
```

El clustering utiliza conceptualmente:

```text
nombre
copy
landing title
description
URL
domain
media
visual similarity
semantic similarity
```

Se ha endurecido para ser conservador.

Confidence:

```text
HIGH
MEDIUM
LOW
```

No debe fusionar agresivamente sin evidencia.

---

# 17. ADVERTISER DEDUPLICATION

Prioridad:

```text
page_id
```

Después:

```text
normalized name
domain
landing domain
```

---

# 18. CREATIVE INTELLIGENCE

Campos estructurados:

```text
hook
pain_point
audience
persona
angle
format
ugc
demonstration
before_after
social_proof
offer
discount
cod
cta
duration
product_visibility
problem_visibility
```

LLM puede ayudar en:

```text
hooks
pains
audience
angles
semantic classification
explanations
query generation
```

LLM NO debe inventar:

```text
ad age
advertiser count
price
margin
growth
score
velocity
```

Estas métricas deben ser deterministas.

---

# 19. ANGLE INTELLIGENCE

Concepto:

```text
Product: Juanetes

Angle                     Ads    Avg Age

Dolor al caminar           14      39d
Estética                     4       8d
Dormir con corrector         9      27d
Regalo para madre            6      31d
```

Permite detectar qué mensajes sobreviven.

---

# 20. SATURATION ENGINE

No usar:

`muchos anuncios = saturado`

Debe considerar:

```text
unique_advertisers
ads_per_advertiser
new_advertisers_7d
new_advertisers_14d
new_advertisers_30d
advertiser_growth
advertiser_concentration
market_age
ad_volume
creative_volume
```

Diferenciar:

```text
40 ads / 2 advertisers
```

de:

```text
40 ads / 27 advertisers
```

---

# 21. CASAMABLE FIT SCORE

Pesos iniciales conceptuales:

```text
Pain severity                 12
Audience 40+                  10
Visual demonstration          10
Impulse purchase               8
COD compatibility              8
Spain market                   8
Creative scalability          10
Margin                        12
Low return probability         7
Low logistics complexity       5
Ad validation                 10
```

Todo debe ser configurable.

---

# 22. PENALIZACIONES

Ejemplos:

```text
tallas                          -15
producto frágil                 -15
regulación compleja             -20
alto riesgo devolución          -20
coste > 40% PVP                 -15
difícil de explicar             -10
muy disponible retail           -10
logística compleja              -10
```

No aplicar claims regulatorios automáticamente sin reglas claras.

---

# 23. ECONOMICS

El agente ya dispone de calculadora/economics.

Regla:

> Product Intelligence consume economics mediante adapter READ ONLY.

No crear un sistema económico paralelo salvo necesidad real.

Campos esperables:

```text
observed_price
supplier_cost
shipping_cost
fulfillment_cost
cod_cost
gross_margin
contribution_margin
break_even_cpa
target_cpa
break_even_roas
```

Si no hay datos:

`unknown`

No inventar.

---

# 24. OPPORTUNITY SCORE

Score final:

`0–100`

Componentes:

```text
meta_validation_score
longevity_score
creative_velocity_score
momentum_score
pain_score
creative_potential_score
casamable_fit_score
economics_score
saturation_score
logistics_score
risk_penalties
```

Debe ser explicable.

---

# 25. EXPLICABILIDAD

Ejemplo:

```text
Opportunity Score: 84

Meta Validation      +13.4
Longevity             +8.2
Creative Velocity     +8.8
Momentum             +12.1
Casamable Fit        +13.7
Economics            +12.4
Saturation            +3.1
Logistics             +4.3
Penalties             -2.0
```

El total debe coincidir matemáticamente.

---

# 26. CONFIDENCE

Confidence independiente del Opportunity Score.

Ejemplo:

```text
Opportunity:
91

Confidence:
LOW
```

si solo hay:

```text
1 advertiser
2 ads
economics incompletos
```

Valores:

```text
LOW
MEDIUM
HIGH
```

---

# 27. WINNING MOMENTUM SCORE

Objetivo:

detectar aceleración.

Usa conceptualmente:

```text
longevity
creative_velocity
advertiser_growth
active_ratio
casamable_fit
score_delta
```

Histórico:

```text
current_score
score_1d_ago
score_7d_ago
score_14d_ago
delta_1d
delta_7d
delta_14d
```

Ejemplo:

```text
82 ahora
61 hace 7 días

Delta:
+21
```

---

# 28. LIFECYCLE

Estados:

```text
EMERGING
SCALING
VALIDATED
SATURATING
DECLINING
UNKNOWN
```

No deben cambiar de forma arbitraria.

Se han preparado tests para cada lifecycle.

---

# 29. RECOMMENDATION ENGINE

Estados:

```text
TEST_NOW
WATCHLIST
RESEARCH_MORE
REJECT
```

No se basa solo en thresholds.

Puede haber blockers.

---

# 30. WATCHLIST

Estados:

```text
NEW
MONITORING
TEST_CANDIDATE
TESTED
REJECTED
ARCHIVED
```

Operaciones:

```text
ADD
REMOVE
PAUSE MONITORING
```

---

# 31. SNAPSHOTS

El sistema guarda snapshots temporales.

Conceptualmente:

```text
snapshot_time
product_id
active_ads
total_ads
advertisers
new_ads_7d
median_ad_age
max_ad_age
creative_velocity
saturation
opportunity_score
momentum_score
```

No sobrescribir históricos.

---

# 32. DIFF ENGINE

Comparaciones:

```text
T
vs
T-1
vs
T-7d
vs
T-14d
vs
T-30d
```

Eventos:

```text
NEW_AD
REMOVED_AD
NEW_ADVERTISER
CREATIVE_SPIKE
SCORE_SPIKE
SCORE_DROP
LIFECYCLE_CHANGE
```

---

# 33. SIGNAL ENGINE

Ejemplos:

```text
PRODUCT_SCORE_SPIKE
PRODUCT_SCORE_DROP
CREATIVE_VELOCITY_SPIKE
NEW_COMPETITOR
COMPETITOR_SURGE
OLD_AD_STILL_ACTIVE
PRODUCT_ENTERED_SCALING
PRODUCT_ENTERED_SATURATING
PRODUCT_PROMOTED_TO_TEST
```

Existe deduplicación de señales.

No repetir el mismo evento cada run si no ha cambiado el estado.

---

# 34. SIGNAL INBOX

Dashboard preparado para señales:

```text
🔥 Product entered SCALING
⬆ Opportunity Score +14
🆕 New advertiser
⚠ Saturation increasing
🏆 Product promoted to TEST_NOW
```

Mientras no existan datos reales:

NO generar señales falsas.

---

# 35. PRODUCT DOSSIER

Salida esperada:

```text
Product
Opportunity Score
Momentum
Lifecycle
Recommendation
Confidence

Ads
Advertisers
Ad Longevity
Creative Velocity
Saturation

Pain
Audience
Creative Angles
Hooks

Economics
Risks

Why Test
Why Not Test

Discovery Path

Missing Data
```

También exportable a JSON.

---

# 36. META ADS EXISTENTE VS META AD LIBRARY

MUY IMPORTANTE:

Son sistemas separados.

## Meta Ads existente

Pertenece a Casamable:

```text
spend
campaigns
adsets
ads
CPA
performance
```

## Meta Ad Library

Pertenece al research competitivo:

```text
competitor ads
advertisers
creative
start dates
activity
```

No mezclar responsabilidades.

---

# 37. META AD LIBRARY PROVIDER

Se implementó provider independiente:

`meta-ad-library-provider.ts`

Características implementadas:

- solo lectura;
- paginación;
- normalización;
- raw payload sanitizado;
- retry;
- exponential backoff;
- rate-limit handling;
- cooldown;
- provider call budget;
- country configurable;
- `search_page_ids`;
- health state;
- token redaction.

---

# 38. META PROVIDER STATES

Estados preparados:

```text
META_NOT_CONFIGURED
META_CONFIGURED_UNAUTHORIZED
META_CONNECTED
META_RATE_LIMITED
META_ERROR
```

Estado actual real:

```text
Configured: yes
API: v26.0
Token loaded: yes
Authorization: pending
Provider health: configured_unauthorized
Research available: no
```

---

# 39. QUÉ FALLÓ EXACTAMENTE

Se generó un access token y se configuró:

```text
META_AD_LIBRARY_ACCESS_TOKEN
META_GRAPH_API_VERSION=v26.0
```

La query real llegó a Meta.

Prueba:

```text
Query: almohada cervical
Country: ES
API: v26.0
Provider available: true
```

Respuesta Meta:

```text
Application does not have permission for this action
```

Conclusión:

- el token se carga;
- la request llega;
- el provider funciona;
- la app existe;
- la API version es aceptada;
- el problema NO es el código del provider;
- el problema es autorización de Meta para `/ads_archive`.

---

# 40. ERROR PREVIO EN LA INTERPRETACIÓN DE PERMISOS

Inicialmente se asumió que `ads_read` podría ser suficiente.

Eso resultó incorrecto para esta operación.

Se comprobó que:

`ads_read` por sí solo NO habilita `/ads_archive`.

No se deben añadir permisos al azar como:

```text
pages_show_list
pages_read_engagement
ads_management
business_management
```

porque no solucionan necesariamente la autorización específica de Ad Library.

---

# 41. VERIFICACIÓN DE IDENTIDAD META

Se inició el flujo de Meta requerido para usar Ad Library API en la UE.

Meta mostró explícitamente que la verificación es necesaria para usar la API de la Biblioteca de anuncios para ver anuncios en la UE.

Se inició la confirmación de identidad.

Estado actual:

```text
Confirmación de identidad en curso
```

Meta indica normalmente revisión en aproximadamente 48 horas.

Por tanto:

`META AUTHORIZATION = PENDING`

---

# 42. IMPORTANTE: TOKEN EXPUESTO EN CAPTURA

Durante el proceso, un access token apareció visible en una captura de pantalla.

Por seguridad:

> NO reutilizar ese token a largo plazo.

Cuando Meta apruebe la identidad:

1. generar token NUEVO;
2. reemplazar el actual;
3. no compartirlo en chats;
4. no incluirlo en screenshots;
5. no meterlo en Git;
6. guardarlo solo en variables de entorno/secrets.

---

# 43. VARIABLES DE ENTORNO

Principales:

```text
PRODUCT_INTELLIGENCE_ENABLED
AUTO_HUNT_ENABLED
META_AD_LIBRARY_ACCESS_TOKEN
META_GRAPH_API_VERSION
```

Defaults seguros:

```text
PRODUCT_INTELLIGENCE_ENABLED=true
AUTO_HUNT_ENABLED=false
META_GRAPH_API_VERSION=v26.0
```

El token no debe existir en:

```text
.env.example
Git
docs
logs
screenshots
```

---

# 44. DASHBOARD PRODUCTOS

Se añadió apartado:

`Productos`

Incluye/prepara:

- estado del provider;
- estado Meta;
- research manual;
- Auto Hunt;
- query state;
- products;
- watchlist;
- signals;
- scores;
- health info.

Mientras Meta esté pendiente:

```text
Authorization:
PENDING

Research available:
NO

Auto Hunt:
OFF
```

No se muestran datos falsos.

---

# 45. META HEALTH CHECK

Se implementó endpoint/comando de health.

Debe poder devolver:

```text
Configured: yes
API: v26.0
Token loaded: yes
Authorization: pending
Provider health: configured_unauthorized
Research available: no
```

Cuando Meta autorice:

```text
Authorization: connected
Provider health: healthy
Research available: yes
```

---

# 46. SMOKE TEST

Existe/preparado smoke test.

Root query obligatoria usada:

`almohada cervical`

Actualmente se detiene correctamente tras health check debido a autorización pendiente.

Resultado actual:

```text
Authorization: PENDING
Ads Found: 0
Products Found: 0
Persistence: false
```

Esto es correcto.

No debe generar resultados falsos.

---

# 47. AUTO HUNT SAFE MODE

Preparado con presupuesto limitado.

Conceptualmente:

```text
max_initial_queries = 5
max_pages_per_query = 2
max_depth = 2
max_provider_calls = 20
dry_run = true
```

No debe ejecutarse contra Meta hasta:

`META_CONNECTED`

---

# 48. AUTO HUNT 24/7

Estado actual:

`OFF`

Debe seguir OFF.

No crear todavía:

- cron;
- scheduler recurrente;
- loop permanente;
- research automático continuo.

Solo después de validar datos reales.

---

# 49. PERSISTENCIA

Actualmente:

`data/product-intelligence.json`

También existe estado asociado de Product Intelligence.

Se endureció la persistencia con:

- lock;
- backup;
- fsync;
- temp file;
- atomic rename;
- corruption recovery;
- checkpointing.

---

# 50. RECUPERACIÓN DE CORRUPCIÓN

Si JSON está corrupto:

NO sobrescribir silenciosamente.

Conservar como:

```text
product-intelligence.corrupt.TIMESTAMP.json
```

y recuperar backup o iniciar storage seguro según lógica implementada.

---

# 51. IDEMPOTENCY

Repetir la misma investigación con mismos datos:

NO debe duplicar:

```text
ads
advertisers
products
queries
signals
```

---

# 52. SESSION RECOVERY

Auto Hunt puede:

```text
START
PAUSE
RESUME
STOP
```

Stop no borra estado.

Pause no pierde cola.

Resume continúa.

Si el proceso muere:

- processed queries se conservan;
- pending queries continúan;
- no repetir trabajo innecesariamente.

---

# 53. KILL SWITCH

Existen dos niveles:

```text
PRODUCT_INTELLIGENCE_ENABLED=false
```

desactiva Product Intelligence.

Y:

```text
AUTO_HUNT_ENABLED=false
```

desactiva Auto Hunt sin desactivar Manual Research.

---

# 54. FEATURE OFF

Con:

```text
PRODUCT_INTELLIGENCE_ENABLED=false
```

el agente no debe:

- ejecutar providers;
- crear sesiones;
- generar queries;
- escribir snapshots;
- iniciar jobs.

El resto del agente debe comportarse como antes.

Validado:

`PASS`

---

# 55. FAILURE ISOLATION

Probados/preparados escenarios:

```text
timeout
401
403
429
500
corrupt JSON
write failure
query exception
scoring exception
```

Product Intelligence falla de forma controlada.

El agente principal debe seguir funcionando.

Validado:

`PASS`

---

# 56. SECRET REDACTION

No imprimir:

```text
META_AD_LIBRARY_ACCESS_TOKEN
Authorization headers
cookies
app secret
```

Validado:

`PASS`

---

# 57. CACHE CREATIVA

Se preparó cache basada en:

```text
creativeHash
analysisVersion
```

Mismo creativo no debe analizarse repetidamente.

Si cambia analyzer version, puede recalcularse.

---

# 58. DATA SOURCES

Cada dato/producto debe saber su origen:

```text
META_AD_LIBRARY
JSON_IMPORT
TEST_FIXTURE
```

Los fixtures nunca deben mezclarse con producción.

---

# 59. TEST FIXTURES

Existen fixtures sanitizados para probar:

```text
one page
pagination
zero results
rate limit
invalid authorization
missing fields
duplicate ads
```

Deben estar marcados:

`TEST_FIXTURE`

---

# 60. RESET TEST DATA

Existe/preparado mecanismo para borrar exclusivamente:

`TEST_FIXTURE`

sin borrar:

- research real;
- watchlist;
- manual imports.

---

# 61. EXPORTS

Preparados exports READ ONLY:

```text
Product dossier → JSON
Watchlist → JSON
Daily report → JSON
```

No PDF/Excel todavía.

---

# 62. HARDENING COMPLETADO

Resultado:

```text
ISOLATION AUDIT                 PASS
FEATURE FLAG OFF                PASS
FAILURE ISOLATION               PASS
ATOMIC PERSISTENCE              PASS
RECOVERY                        PASS
IDEMPOTENCY                     PASS
DEDUPLICATION                   PASS
LOOP PROTECTION                 PASS
SCORING INVARIANTS              PASS
SIGNAL DEDUP                    PASS
SESSION RECOVERY                PASS
PERFORMANCE                     PASS
SECURITY / SECRET REDACTION     PASS
NODE ENVIRONMENT DOCUMENTED     PASS
```

---

# 63. TESTS

Estado reportado:

```text
Product Intelligence tests: 36 PASS
Random scoring invariants:   500 PASS
TypeScript:                  PASS
Next.js production build:    PASS
```

---

# 64. PERFORMANCE

Benchmark sintético:

```text
Ads:            10,000
Advertisers:       500
Products:        1,000
Queries:         5,000
Total:          6.93 s
Heap delta:       30 MB
```

Cuello detectado:

`clustering conservador`

Aceptable actualmente.

No optimizar todavía sin datos reales.

---

# 65. NODE VERSION

El repositorio define:

`Node 22`

mediante:

`.nvmrc`

El entorno local usado durante parte del desarrollo estaba en Node 24.

Problema observado:

`tsx/thread-stream`

Regla:

> respetar Node 22.

NO actualizar dependencias arbitrariamente para esconder el problema.

---

# 66. NAS

El agente real corre 24/7 en NAS.

Arquitectura detectada en rehearsal:

```text
Runtime NAS:       Docker Compose
Base:              node:22-bookworm-slim
Working directory: /app
Startup:           npm run start:all
Restart policy:    unless-stopped
Health check:      /api/health/live
Log rotation:      3 × 10 MB
```

---

# 67. PERSISTENCIA EN NAS

Diseño:

```text
HOST:
${PERSIST_DIR}/data

CONTAINER:
/app/data

BACKUP:
${PERSIST_DIR}/backups/product-intelligence
```

Esto debe confirmarse en el NAS real.

---

# 68. BACKUP PRODUCT INTELLIGENCE

Se añadió:

`backup-product-intelligence.ts`

Comando:

`npm run backup:product-intelligence`

Resultado rehearsal:

```text
Backup rehearsal: PASS
Files backed up: 2
Retention: 14 days
```

---

# 69. PERSISTENCE HEALTH

Comando:

```text
npm run product-intelligence -- persistence-health
```

Resultado local:

`PASS`

---

# 70. NAS DEPLOYMENT REHEARSAL

Se creó:

`docs/product-intelligence/NAS_DEPLOYMENT.md`

Incluye:

```text
PRE-DEPLOY
DEPLOY
POST-DEPLOY
ROLLBACK
AFTER META APPROVAL
```

El NAS real NO fue modificado.

Estado:

`NOT EXECUTED`

---

# 71. ARCHIVOS/DOCUMENTOS CREADOS DURANTE EL PROYECTO

Entre otros:

```text
docs/CODEX_PRODUCT_INTELLIGENCE_ENGINE.md

docs/product-intelligence/
├── META_AD_LIBRARY_CAPABILITY.md
├── AFTER_META_APPROVAL.md
├── ISOLATION_AUDIT.md
├── PERFORMANCE.md
├── DEV_ENVIRONMENT.md
├── TEST_MATRIX.md
├── PRODUCTION_READINESS.md
└── NAS_DEPLOYMENT.md
```

Además de módulos TypeScript, API, UI, tests, fixtures, scripts y configuración.

---

# 72. PRODUCTION READINESS

Estado reportado:

`READY WITH BLOCKER`

Blocker:

`META AD LIBRARY AUTHORIZATION`

---

# 73. CONFIRMACIÓN DE NO INTERFERENCIA

Reportado:

```text
Existing Meta Ads:   UNCHANGED
Economics:           UNCHANGED
Campaigns:           UNCHANGED
WhatsApp:            UNCHANGED
Orders:              UNCHANGED
```

Esta regla debe seguir vigente.

---

# 74. QUÉ NO DEBEMOS HACER AHORA

No continuar añadiendo grandes features mientras Meta no autorice.

NO implementar:

```text
ML complejo
vector DB
Postgres
Redis
microservices
supplier automation
Shopify automation
campaign automation
Auto Hunt 24/7
```

No optimizar algoritmos sin datos reales.

---

# 75. POR QUÉ HAY QUE PARAR EL DESARROLLO FUNCIONAL

Hasta ahora el sistema se ha validado con:

- mocks;
- fixtures;
- importación JSON;
- synthetic benchmarks.

Pero todavía NO hemos visto el comportamiento real de los datos de Meta Ad Library.

Podrían existir diferencias importantes:

- campos ausentes;
- creativos incompletos;
- URLs no disponibles;
- variaciones por país;
- pagination distinta;
- advertisers difíciles de resolver;
- formatos inesperados;
- resultados muy amplios;
- metadata que no coincide con nuestras hipótesis.

Por eso el siguiente desarrollo útil debe basarse en datos reales.

---

# 76. SIGUIENTE EVENTO: META APPROVAL

Esperar notificación de Meta.

Estado actual:

`IDENTITY CONFIRMATION IN PROGRESS`

Cuando Meta apruebe:

NO activar Auto Hunt directamente.

Seguir el orden exacto de las siguientes secciones.

---

# 77. AFTER META APPROVAL — PASO 1

## GENERAR TOKEN NUEVO

NO reutilizar el token expuesto anteriormente.

Generar access token NUEVO para la app autorizada.

No compartirlo en chats.

No mostrarlo en screenshots.

---

# 78. AFTER META APPROVAL — PASO 2

Actualizar secret:

```text
META_AD_LIBRARY_ACCESS_TOKEN
```

Mantener:

```text
META_GRAPH_API_VERSION=v26.0
```

o revisar versión si Meta ha cambiado el contexto.

---

# 79. AFTER META APPROVAL — PASO 3

Reiniciar el proceso/contenedor de forma controlada.

No activar Auto Hunt.

---

# 80. AFTER META APPROVAL — PASO 4

Ejecutar health:

```text
product-intelligence meta-health
```

Expected:

```text
Configured: yes
Token loaded: yes
Authorization: connected
Provider health: healthy
Research available: yes
```

Si sigue:

`configured_unauthorized`

DETENER.

No cambiar permisos al azar.

Diagnosticar autorización.

---

# 81. AFTER META APPROVAL — PASO 5

Primera query real:

`almohada cervical`

Debe verificarse que:

```text
First real query = "almohada cervical"
Country = ES
Provider = META_AD_LIBRARY
```

No expansion antes de root.

---

# 82. AFTER META APPROVAL — PASO 6

Usar smoke test limitado:

```text
max_pages = 2
max_provider_calls = low
Auto Hunt = OFF
```

Guardar:

- raw sanitized payload;
- normalized ads;
- advertisers;
- products/clusters;
- derived queries.

---

# 83. AFTER META APPROVAL — PASO 7

Inspeccionar manualmente datos reales.

Objetivo:

ver entre 100 y 500 anuncios reales antes de confiar en el scoring.

Analizar:

```text
field availability
ad start dates
page ids
page names
creative body
media
landing URLs
active status
duplicates
pagination
country filtering
```

---

# 84. AFTER META APPROVAL — PASO 8

Validar clustering con productos reales.

Preguntas:

- ¿fusiona demasiado?
- ¿separa demasiado?
- ¿identifica aliases?
- ¿page_id ayuda?
- ¿landing URL ayuda?
- ¿media hash es suficiente?

No tocar clustering hasta ver evidencia.

---

# 85. AFTER META APPROVAL — PASO 9

Validar Opportunity Score.

Buscar casos:

```text
obviamente malos
obviamente interesantes
maduros
emergentes
saturados
```

Comparar score vs intuición/realidad observable.

---

# 86. AFTER META APPROVAL — PASO 10

Validar Creative Velocity.

Necesitamos comprobar:

- qué fechas devuelve Meta;
- si los ads siguen visibles;
- cómo distinguir creación vs supervivencia;
- qué se puede medir realmente.

---

# 87. AFTER META APPROVAL — PASO 11

Crear primer snapshot real.

Después repetir días después.

Solo con histórico real podremos medir correctamente:

```text
new ads
removed ads
still active
new advertisers
momentum
velocity
```

---

# 88. AFTER META APPROVAL — PASO 12

Ejecutar:

`AUTO HUNT SAFE MODE`

Configuración inicial:

```text
5 seeds máximo
1–2 pages/query
max depth 2
budget pequeño
dry-run
```

No 24/7.

---

# 89. AFTER META APPROVAL — PASO 13

Inspeccionar Auto Hunt Safe.

Revisar:

```text
seed quality
query quality
query expansion
duplicates
branches
products found
advertisers found
Opportunity Scores
watchlist promotions
```

---

# 90. AFTER META APPROVAL — PASO 14

Ajustar únicamente aquello que los datos reales demuestren que necesita cambios.

Prioridad:

```text
provider normalization
clustering
query scoring
branch pruning
Opportunity Score
Casamable Fit
```

No reescribir todo.

---

# 91. AFTER META APPROVAL — PASO 15

Realizar varios Safe Tests.

No activar 24/7 tras una sola ejecución.

Idealmente:

- varios nichos;
- varias root queries;
- distintos tipos de producto;
- varios advertisers;
- España primero.

---

# 92. ROOT QUERIES PARA VALIDACIÓN

Ejemplos útiles:

```text
almohada cervical
juanetes
durezas pies
limador eléctrico
personas mayores
pelos de mascota
limpieza baño
```

Siempre buscar exact query primero.

---

# 93. CUÁNDO ACTIVAR AUTO HUNT 24/7

Solo cuando:

```text
Meta provider stable
rate limits understood
normalization stable
clustering acceptable
query engine useful
snapshot works
scoring calibrated
watchlist useful
persistence stable
NAS stable
no regressions
```

---

# 94. AUTO HUNT 24/7 — PRIMERA ACTIVACIÓN

No empezar ilimitado.

Usar budget.

Ejemplo:

```text
N queries por cycle
N calls por hour
max pages/query
max depth
cooldown
```

Ciclo:

```text
RUN
SAVE STATE
SLEEP
RUN
SAVE STATE
```

No mantener un loop infinito en RAM.

---

# 95. AUTO HUNT 24/7 — OBJECTIVE

El objetivo no es hacer máximas búsquedas.

El objetivo es encontrar:

`productos con señal suficiente para merecer dinero de test`

Priorizar calidad sobre volumen.

---

# 96. DAILY REPORT FUTURO

Ejemplo:

```text
CASAMABLE PRODUCT INTELLIGENCE

TEST NOW
1. Product X 91 ↑7
2. Product Y 87 ↑14

EMERGING
3. Product Z 78 ↑21

SATURATING
4. Product A 81 ↓4

DISCOVERY
Queries: 100
Ads: 2,500
Products: 83
Qualified: 5
```

---

# 97. FUTURE REAL PERFORMANCE LOOP

Después de que Product Intelligence funcione:

Relacionar cada producto testeado con:

```text
research score
discovery query
advertisers
angles
lifecycle
```

y posteriormente:

```text
CPA
CVR
ROAS
orders
returns
refund rate
```

---

# 98. POR QUÉ ESTE FEEDBACK LOOP ES IMPORTANTE

Podremos descubrir qué señales previas correlacionan realmente con ganadores de Casamable.

Ejemplo futuro:

```text
target 45+
pain > 8
PVP 29–39 €
COGS < 8 €
3 advertisers
ad age > 25d
creative velocity high
```

si históricamente produce buenos CPA:

subir peso de ese patrón.

---

# 99. NO USAR ML COMPLEJO AL PRINCIPIO

Primero:

- estadísticas;
- historical outcomes;
- deterministic weighting;
- correlations.

Después evaluar ML.

---

# 100. FUTURE COMPETITOR GRAPH

Objetivo:

```text
Product X
├── Store A
├── Store B
└── Store C

Store B
├── Product X
├── Product Y
└── Product Z
```

Buenos advertisers se convierten en fuentes de discovery.

---

# 101. FUTURE SUPPLIER INTELLIGENCE

No implementado todavía.

Futuro:

```text
Winning Product
↓
Supplier Search
↓
Cost
↓
Shipping
↓
COD/Fulfillment
↓
Contribution Margin
↓
Target CPA
```

Pero primero Product Intelligence real.

---

# 102. FUTURE CREATIVE PACKAGE

Después de Human Approval:

```text
top hooks
top angles
audience
pain
offer
creative briefs
landing structure
Meta test plan
```

No implementar todavía.

---

# 103. NAS DEPLOYMENT REAL — TODAVÍA NO EJECUTADO

El rehearsal está listo.

Antes del deploy real:

- confirmar NAS healthy;
- backup;
- revisar PERSIST_DIR;
- confirmar Node 22;
- confirmar volumes;
- mantener Auto Hunt OFF.

---

# 104. PRIMER DEPLOY NAS RECOMENDADO

Defaults:

```text
PRODUCT_INTELLIGENCE_ENABLED=true
AUTO_HUNT_ENABLED=false
META_GRAPH_API_VERSION=v26.0
```

El provider puede aparecer pendiente.

No research automático.

---

# 105. RESTART TEST NAS

Tras deploy:

```text
restart container
```

Verificar:

```text
agent healthy
Product Intelligence loaded
Auto Hunt OFF
persistent state preserved
```

---

# 106. ROLLBACK NAS

Primer kill:

```text
PRODUCT_INTELLIGENCE_ENABLED=false
AUTO_HUNT_ENABLED=false
```

Reiniciar.

Si persiste problema:

rollback code.

NO borrar Product Intelligence data.

---

# 107. BACKUP NAS

Usar:

`npm run backup:product-intelligence`

Backup en:

`${PERSIST_DIR}/backups/product-intelligence`

---

# 108. CHECKLIST CUANDO SE RETOME EL PROYECTO

## A. META

- [ ] comprobar si identidad ha sido aprobada;
- [ ] generar token NUEVO;
- [ ] no reutilizar token expuesto;
- [ ] actualizar secret;
- [ ] reiniciar;
- [ ] meta-health;
- [ ] confirmar CONNECTED.

## B. REAL DATA

- [ ] ejecutar `almohada cervical`;
- [ ] comprobar query exacta;
- [ ] revisar 1–2 páginas;
- [ ] inspeccionar raw;
- [ ] inspeccionar normalized;
- [ ] revisar advertisers;
- [ ] revisar clustering;
- [ ] revisar scores.

## C. SAFE AUTO HUNT

- [ ] ejecutar 5 seeds;
- [ ] budget pequeño;
- [ ] max depth 2;
- [ ] analizar resultados;
- [ ] no dejar recurrente.

## D. CALIBRATION

- [ ] clustering;
- [ ] query score;
- [ ] lifecycle;
- [ ] saturation;
- [ ] momentum;
- [ ] Opportunity Score.

## E. NAS

- [ ] deploy real;
- [ ] backup;
- [ ] persistence;
- [ ] restart test;
- [ ] health;
- [ ] Auto Hunt OFF.

---

# 109. NO TOCAR ESTO SIN NECESIDAD

```text
Meta Ads existing integration
Economics
Campaign logic
WhatsApp
Orders
Existing DB structures
Existing scheduler
Global logger
```

---

# 110. IMPORTANTE PARA CODEX

Antes de modificar un archivo existente:

preguntar conceptualmente:

> ¿Puedo conseguir lo mismo creando una extensión/adaptor/nuevo módulo?

Si sí:

NO modificar el archivo existente.

---

# 111. IMPORTANTE PARA FUTUROS AGENTES

Nunca afirmar:

```text
ad active 30d = profitable
```

Correcto:

```text
ad active 30d = positive validation signal
```

Nunca afirmar:

```text
many creatives = scaling
```

Correcto:

```text
many creatives + old ads alive + growth = stronger scaling signal
```

---

# 112. OBSERVED / DERIVED / INFERRED

Separar siempre:

```text
OBSERVED
DERIVED
INFERRED
```

Ejemplo:

```text
Observed:
ad_start_date

Derived:
ad_age_days

Inferred:
likely_scaling
```

---

# 113. NO HALLUCINATIONS

Si dato no existe:

`unknown`

Si es estimación:

```text
value
method
confidence
```

No inventar.

---

# 114. ESTADO FINAL A FECHA DE ESTE HANDOFF

```text
ENGINE                    ✅
MANUAL RESEARCH           ✅
AUTO HUNT                 ✅
ADAPTIVE QUERY ENGINE     ✅
SCORING                   ✅
CLUSTERING                ✅
WATCHLIST                 ✅
SNAPSHOTS                 ✅
DIFF ENGINE               ✅
SIGNALS                   ✅
PERSISTENCE               ✅
RECOVERY                  ✅
SECURITY                  ✅
PERFORMANCE               ✅
TESTING                   ✅
NAS REHEARSAL             ✅
META PROVIDER             ✅
META CONFIGURATION        ✅
META AUTHORIZATION        ⏳
REAL DATA                 🔒
CALIBRATION               🔒
AUTO HUNT 24/7            🔒
```

---

# 115. BLOQUEADOR ACTUAL

ÚNICO BLOCKER:

`META AD LIBRARY AUTHORIZATION`

Meta está revisando la identidad.

No hay evidencia actual de que el provider esté roto.

La request real llegó a Meta.

El token fue leído.

El error fue autorización.

---

# 116. SIGUIENTE DECISIÓN CUANDO META RESPONDA

## SI META APRUEBA

Seguir:

```text
NEW TOKEN
↓
ENV
↓
RESTART
↓
META HEALTH
↓
CONNECTED
↓
"almohada cervical"
↓
REAL DATA INSPECTION
↓
SAFE AUTO HUNT
```

## SI META RECHAZA

No cambiar código.

Diagnosticar primero:

- motivo de rechazo;
- identidad;
- país;
- app authorization;
- eligibility;
- Meta developer state.

No añadir permisos al azar.

---

# 117. OBJETIVO FINAL DEL PROYECTO

Construir un sistema propietario de research que pueda funcionar así:

```text
24/7

discover
↓
analyze
↓
score
↓
watch
↓
detect momentum
↓
surface opportunities
↓
human approves
↓
test
↓
real performance
↓
learn
```

El objetivo NO es generar miles de productos.

El objetivo es:

> detectar antes y con mejor señal productos que merecen capital de test.

---

# 118. DEFINICIÓN DE ÉXITO

El proyecto será exitoso cuando pueda:

1. descubrir productos reales;
2. justificar por qué son interesantes;
3. demostrar qué señales observa;
4. mostrar riesgos;
5. evitar saturados evidentes;
6. detectar momentum;
7. encontrar oportunidades con poca intervención;
8. no inventar datos;
9. operar 24/7;
10. no interferir con el agente principal;
11. relacionar research con resultados reales;
12. mejorar con el histórico de Casamable.

---

# 119. REGLA DE ORO

No automatizar por automatizar.

Primero:

`datos reales`

Después:

`calibración`

Después:

`automatización recurrente`

Nunca al revés.

---

# 120. MENSAJE FINAL PARA CODEX / FUTURO AGENTE

El Product Intelligence Engine ya está construido y endurecido.

NO lo reconstruyas.

NO añadas grandes funcionalidades hasta disponer de datos reales de Meta Ad Library.

Actualmente:

`READY WITH BLOCKER`

Blocker:

`META AD LIBRARY AUTHORIZATION`

Cuando desaparezca el blocker:

1. generar token nuevo;
2. actualizar secret;
3. ejecutar health;
4. verificar CONNECTED;
5. buscar exactamente `almohada cervical`;
6. inspeccionar datos reales;
7. validar clustering;
8. validar scoring;
9. ejecutar Auto Hunt Safe;
10. calibrar;
11. desplegar/validar NAS;
12. solo entonces estudiar Auto Hunt 24/7.

Mantener siempre:

```text
Existing Meta Ads: UNCHANGED
Economics:         UNCHANGED
Campaigns:         UNCHANGED
WhatsApp:          UNCHANGED
Orders:            UNCHANGED
```

Fin del handoff.
