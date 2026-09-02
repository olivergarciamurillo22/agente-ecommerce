# CODEX BRIEF — CASAMABLE WINNING PRODUCT INTELLIGENCE ENGINE

## 0. MISIÓN PRINCIPAL

Construir dentro del agente existente de Casamable un nuevo módulo autónomo llamado, de forma provisional:

`Winning Product Intelligence Engine`

Su objetivo es detectar, analizar, puntuar, monitorizar y priorizar productos con potencial para ser testeados en ecommerce mediante señales obtenidas de Meta Ad Library, actividad publicitaria, competencia, creatividad, economics y evolución temporal.

Este módulo debe convertir el product research manual en un sistema de inteligencia de producto capaz de:

1. Descubrir candidatos.
2. Detectar productos y anunciantes repetidos.
3. Medir señales de validación publicitaria.
4. Analizar longevidad, velocidad creativa y momentum.
5. Agrupar anuncios que pertenecen al mismo producto.
6. Evaluar saturación.
7. Analizar creatividades y ángulos.
8. Incorporar economics.
9. Calcular un Opportunity Score.
10. Clasificar productos por fase.
11. Mantener una watchlist.
12. Generar reportes periódicos.
13. Detectar cambios importantes.
14. Proponer qué productos deberían pasar a test.
15. Dejar preparada la arquitectura para que, en el futuro, los resultados reales de Casamable retroalimenten el sistema.

---

# 1. REGLA CRÍTICA DE INTEGRACIÓN

## NO MODIFICAR LO EXISTENTE

Este requisito tiene prioridad absoluta sobre cualquier otro.

El agente ya está operativo y corre 24/7 en un NAS utilizado como servidor.

Actualmente ya existen módulos funcionales que incluyen, entre otras capacidades:

- acceso a Meta Ads;
- consulta de gasto publicitario;
- consulta de estadísticas de campañas;
- cálculos económicos;
- estimaciones;
- lógica ya implementada en otras partes del agente.

### REGLA OBLIGATORIA

El nuevo Product Intelligence Engine debe construirse como una ampliación independiente.

NO se debe:

- modificar lógica existente;
- reescribir módulos existentes;
- alterar interfaces existentes;
- cambiar nombres de clases, funciones o rutas existentes;
- modificar esquemas de base de datos existentes sin una necesidad estrictamente justificada;
- alterar procesos de Meta Ads ya operativos;
- modificar cálculos económicos ya existentes;
- tocar automatizaciones existentes;
- cambiar cron jobs actuales;
- cambiar comportamiento del agente actual;
- introducir dependencias que rompan otros módulos;
- modificar variables de entorno ya utilizadas;
- reutilizar tablas existentes de forma que exista riesgo de corrupción;
- introducir side effects en funciones ya creadas;
- afectar el rendimiento o la estabilidad del agente principal.

## PRINCIPIO DE AISLAMIENTO

Todo lo nuevo debe vivir en una sección, paquete o namespace nuevo.

Ejemplo recomendado:

```text
modules/
└── product_intelligence/
```

Si la estructura real del repositorio utiliza otra convención, adaptarse a ella manteniendo el mismo principio:

> NUEVAS CAPACIDADES = NUEVOS ARCHIVOS / NUEVOS MÓDULOS.

### Integración con funciones existentes

Cuando sea necesario utilizar datos que ya existen, crear adapters.

Ejemplo conceptual:

```python
class ExistingMetaAdsAdapter:
    def get_available_account_stats(self):
        ...
```

El adapter debe consumir la interfaz pública ya existente.

NO debe alterar su implementación.

Aplicar exactamente el mismo principio a:

- estadísticas;
- gasto;
- economics;
- estimaciones;
- configuración;
- logging;
- scheduler;
- almacenamiento.

## MODO READ-ONLY POR DEFECTO

Cualquier integración con módulos ya existentes debe considerarse de solo lectura salvo que una operación de escritura sea imprescindible y esté contenida exclusivamente dentro del nuevo módulo.

---

# 2. PRINCIPIO DE DESARROLLO

Antes de escribir código:

1. inspeccionar el repositorio;
2. entender la arquitectura actual;
3. identificar módulos que ya cubren funcionalidades reutilizables;
4. documentar qué módulos existentes serán consumidos;
5. diseñar adapters;
6. evitar duplicar código útil;
7. no refactorizar nada fuera del nuevo dominio.

NO realizar refactors oportunistas.

Aunque Codex encuentre código mejorable fuera de este proyecto:

> NO TOCARLO.

---

# 3. RESULTADO FINAL ESPERADO

El sistema debe ser capaz de producir resultados como:

```text
PRODUCT: Electric Callus Remover

Opportunity Score: 86/100

Meta Validation:        92
Pain Strength:          89
Creative Potential:     95
Casamable Fit:          91
Economics:              84
Saturation:             68
Logistics:              93
Momentum:               88

Lifecycle:
SCALING

Recommendation:
TEST NOW

Signals:

+ 4 advertisers mantienen anuncios con más de 30 días.
+ El advertiser principal lanzó 8 creativos nuevos esta semana.
+ Se detectan anuncios antiguos todavía activos.
+ Alta presencia de demostración visual.
+ El target dominante parece ser 45+.
+ Producto pequeño y fácil de enviar.
+ PVP observado compatible con margen.
+ Economics compatibles con test.

Risks:

- Competencia creciendo.
- Nuevos advertisers entrando.
```

---

# 4. ARQUITECTURA PROPUESTA

Crear un módulo conceptualmente equivalente a:

```text
modules/
└── product_intelligence/
    │
    ├── __init__.py
    │
    ├── config/
    │   ├── settings.py
    │   └── scoring_weights.py
    │
    ├── discovery/
    │   ├── keyword_engine.py
    │   ├── query_generator.py
    │   ├── competitor_discovery.py
    │   └── advertiser_discovery.py
    │
    ├── providers/
    │   ├── base.py
    │   ├── meta_ad_library.py
    │   ├── existing_meta_adapter.py
    │   ├── manual_import.py
    │   └── external_provider.py
    │
    ├── normalization/
    │   ├── ad_normalizer.py
    │   ├── advertiser_normalizer.py
    │   └── product_normalizer.py
    │
    ├── clustering/
    │   ├── product_clusterer.py
    │   ├── text_similarity.py
    │   ├── visual_similarity.py
    │   └── canonicalizer.py
    │
    ├── analysis/
    │   ├── ad_age.py
    │   ├── advertiser_analysis.py
    │   ├── creative_velocity.py
    │   ├── creative_analyzer.py
    │   ├── angle_analyzer.py
    │   ├── saturation.py
    │   ├── momentum.py
    │   ├── casamable_fit.py
    │   └── economics_adapter.py
    │
    ├── scoring/
    │   ├── opportunity_score.py
    │   ├── lifecycle.py
    │   ├── penalties.py
    │   └── recommendation.py
    │
    ├── monitoring/
    │   ├── snapshots.py
    │   ├── diff_engine.py
    │   ├── watchlist.py
    │   └── signal_detector.py
    │
    ├── reports/
    │   ├── daily_report.py
    │   ├── product_report.py
    │   ├── watchlist_report.py
    │   └── serialization.py
    │
    ├── storage/
    │   ├── repository.py
    │   ├── models.py
    │   └── migrations/
    │
    ├── jobs/
    │   ├── discovery_job.py
    │   ├── monitoring_job.py
    │   └── reporting_job.py
    │
    ├── cli/
    │   └── commands.py
    │
    ├── api/
    │   └── service.py
    │
    └── tests/
```

No copiar esta estructura de forma ciega.

Primero inspeccionar el repositorio y adaptar nombres, estilo, patrones de arquitectura y convenciones.

---

# 5. ABSTRACCIÓN DE FUENTES DE DATOS

Crear una interfaz desacoplada para las fuentes de anuncios.

Ejemplo:

```python
from typing import Protocol

class AdSource(Protocol):

    def search_ads(self, query, **filters):
        ...

    def get_advertiser_ads(self, advertiser_id, **filters):
        ...

    def get_ad_details(self, ad_id):
        ...
```

Implementaciones posibles:

```text
MetaAdLibraryProvider
ExistingMetaProvider
ManualImportProvider
ExternalProvider
```

## Objetivo

El cerebro del sistema nunca debe depender directamente de un único método de obtención de datos.

Si cambia una fuente:

> cambiar provider, no el sistema entero.

---

# 6. DESCUBRIMIENTO DE PRODUCTOS

Construir un Discovery Engine.

Debe soportar:

## 6.1 Keywords comerciales

Ejemplos iniciales para España:

```text
pago contra reembolso
paga al recibirlo
contra reembolso
envío gratis
envío 24/48h
envío 24 horas
envío 48 horas
oferta limitada
últimas unidades
2x1
segunda unidad
descuento
50% descuento
oferta especial
solo hoy
```

## 6.2 Keywords basadas en problemas

Ejemplos:

```text
dolor cervical
dolor de espalda
juanetes
hallux valgus
durezas
talones
uñas
movilidad
ronquidos
limpieza baño
limpieza cocina
pelos de mascota
mascotas
pie
postura
descanso
```

## 6.3 Buyer language

Ejemplos:

```text
mi madre
mi padre
mis padres
abuelos
personas mayores
mayores de 40
mayores de 50
regalo para padres
```

## 6.4 Query expansion

Cuando aparezca un producto interesante, generar nuevas queries relacionadas.

Ejemplo:

```text
corrector de juanetes
hallux valgus
férula hallux
férula para juanetes
corrector nocturno
separador de dedos
dolor de juanetes
```

Esta expansión puede utilizar reglas, embeddings o LLM.

Guardar siempre:

- query original;
- query derivada;
- fecha de creación;
- fuente;
- último uso;
- rendimiento de la query;
- número de candidatos encontrados.

---

# 7. COMPETITOR GRAPH

Construir relaciones entre:

```text
Advertiser
Product
Ad
Landing Page
Store
```

Ejemplo:

```text
Product X
├── Store A
├── Store B
└── Store C
```

Si Store B vende también Product Y y Product Z:

```text
Store B
├── Product X
├── Product Y
└── Product Z
```

El sistema debe utilizar buenos advertisers como nuevas fuentes de descubrimiento.

Guardar relaciones para crear un grafo simple o estructura equivalente.

---

# 8. LONGEVIDAD DE ANUNCIOS

Calcular edad de cada anuncio.

Buckets orientativos:

```text
0–2 días      = probable testing
3–7 días      = weak signal
8–14 días     = interesting
15–30 días    = strong
30–60 días    = very strong
60+ días      = validated
```

Estas reglas deben estar configuradas y no hardcodeadas.

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

Crear:

```text
longevity_score: 0–100
```

No considerar la longevidad como prueba definitiva de rentabilidad.

Es una señal probabilística.

---

# 9. CREATIVE VELOCITY

Medir la cantidad y ritmo de nuevos anuncios/creativos asociados al mismo producto.

Ventanas mínimas:

```text
24h
3d
7d
14d
30d
```

Ejemplo:

```text
new_ads_7d
new_ads_14d
new_ads_30d
creative_velocity_7d
creative_acceleration
```

Señal importante:

```text
anuncios antiguos siguen activos
+
nuevos creativos aparecen
```

Esto debe aumentar el scoring.

Ejemplo:

```text
old_winners_alive = True
new_creatives_7d = 8
creative_velocity = HIGH
```

---

# 10. PRODUCT CLUSTERING

Evitar tratar como productos diferentes:

```text
Corrector Hallux
Corrector de juanetes
Férula Hallux Valgus
Férula correctora
```

Implementar una capa de clustering.

Fuentes posibles:

```text
nombre
copy
landing title
descripción
imagen
thumbnail
dominio
URL
embedding
similaridad visual
```

Resultado:

```text
product_cluster_id
canonical_product_name
aliases
```

El Product Score debe calcularse principalmente a nivel de cluster.

---

# 11. CREATIVE INTELLIGENCE

Analizar anuncios de forma estructurada.

Extraer:

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

Ejemplo:

```json
{
  "hook": "¿Te duelen los pies al caminar?",
  "audience": "45+",
  "pain_point": "juanetes",
  "angle": "pain_relief",
  "format": "UGC",
  "demonstration": true,
  "before_after": true,
  "offer": "2x1",
  "cod": true
}
```

## Separar LLM de métricas deterministas

LLM puede utilizarse para:

```text
clasificación semántica
hooks
pains
persona
ángulos
descripción
similaridad conceptual
explicación de resultados
```

NO usar LLM para inventar métricas.

Estos campos deben calcularse mediante código:

```text
ad_age
advertiser_count
new_ads_7d
active_ratio
prices detectados
margin
score
delta
growth
```

---

# 12. ANGLE INTELLIGENCE

Agrupar anuncios por ángulo.

Ejemplo:

```text
PRODUCT: Juanetes

Angle                        Ads   Avg Age

Dolor al caminar             14     39d
Estética del pie              4      8d
Dormir con corrector          9     27d
Regalo para madre             6     31d
Evitar cirugía                2      4d
```

Esto permitirá detectar qué mensajes sobreviven más tiempo.

Crear:

```text
angle_score
angle_longevity
angle_frequency
angle_velocity
```

---

# 13. SATURATION ENGINE

No usar:

```text
muchos anuncios = saturado
```

Calcular:

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

Crear:

```text
saturation_score
```

0 puede representar baja saturación y 100 saturación extrema, o el sentido inverso, pero documentarlo claramente.

---

# 14. CASAMABLE FIT SCORE

Crear scoring específico de encaje con Casamable.

## Perfil ideal inicial

Priorizar productos con:

```text
problema fuerte
target amplio
especialmente 40+
demostración visual
efecto before/after
producto pequeño
fácil de enviar
sin tallas
bajo riesgo de rotura
bajo riesgo de devolución
explicación sencilla
compra impulsiva
PVP compatible con ecommerce
buen margen
apto para COD
varios hooks posibles
```

## Pesos iniciales sugeridos

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

Total:

```text
100
```

Todo debe quedar configurable.

---

# 15. PENALIZACIONES

Crear penalizaciones configurables.

Ejemplo:

```text
tallas                          -15
producto frágil                 -15
regulación compleja             -20
alto riesgo devolución          -20
coste > 40% PVP                 -15
difícil de explicar             -10
ampliamente disponible retail   -10
logística compleja              -10
```

No aplicar automáticamente penalizaciones regulatorias sin una regla definida.

Permitir flags:

```text
regulatory_risk
medical_claim_risk
fragile
sizing_required
high_return_risk
```

---

# 16. ECONOMICS

El agente YA cuenta con calculadora y estimación económica.

NO crear una calculadora paralela sin necesidad.

Crear un adapter:

```python
class ExistingEconomicsAdapter:

    def estimate_product_economics(self, ...):
        ...
```

Consumir la capacidad actual.

Datos deseables:

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

Si algunos datos no están disponibles:

```text
confidence = LOW / MEDIUM / HIGH
```

No inventarlos.

---

# 17. META ADS EXISTENTE

El agente ya cuenta con acceso a Meta Ads y puede consultar gasto y estadísticas.

NO modificar esa integración.

Crear adapter de solo lectura.

Posibles usos futuros:

- validar si un producto testeado por Casamable tuvo buen CPA;
- comparar research score vs performance real;
- detectar patrones;
- entrenar pesos internos.

Para la primera versión:

> el Product Intelligence Engine NO necesita alterar campañas ni crear campañas.

SOLO research.

---

# 18. OPPORTUNITY SCORE

Crear score final de:

```text
0–100
```

Componentes iniciales:

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

Fórmula:

```text
weighted_score
-
penalties
=
opportunity_score
```

Los pesos deben vivir en configuración.

Ejemplo:

```yaml
weights:
  meta_validation: 0.15
  longevity: 0.10
  creative_velocity: 0.10
  momentum: 0.15
  casamable_fit: 0.15
  creative_potential: 0.10
  economics: 0.15
  saturation: 0.05
  logistics: 0.05
```

No asumir esta fórmula como definitiva.

Crear el sistema de forma que pueda ajustarse sin tocar lógica.

---

# 19. WINNING MOMENTUM SCORE

Crear métrica específica:

`WMS`

Objetivo:

detectar productos cuya señal está aumentando rápidamente.

Usar variables como:

```text
longevity
creative_velocity
advertiser_growth
active_ratio
casamable_fit
score_delta
```

Ejemplo conceptual:

```text
WMS = normalized(
    longevity_factor
    * creative_velocity_factor
    * advertiser_growth_factor
    * active_ratio_factor
    * casamable_fit_factor
)
```

Evitar multiplicaciones que provoquen resultados inestables.

Normalizar.

Guardar histórico:

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
Score actual: 82
Score hace 7 días: 61

Delta:
+21
```

Esto debe poder convertirse en una señal.

---

# 20. PRODUCT LIFECYCLE

Clasificar:

```text
EMERGING
SCALING
VALIDATED
SATURATING
DECLINING
UNKNOWN
```

Ejemplo:

### EMERGING

- pocos advertisers;
- crecimiento fuerte;
- anuncios relativamente recientes;
- velocity alta.

### SCALING

- anuncios antiguos vivos;
- nuevos creativos;
- advertiser principal aumentando actividad;
- momentum alto.

### VALIDATED

- larga longevidad;
- estabilidad;
- volumen suficiente;
- no necesariamente creciendo rápido.

### SATURATING

- demasiados advertisers;
- crecimiento excesivo de competencia;
- menor diferenciación.

### DECLINING

- caída de actividad;
- retirada de anuncios;
- menor velocity;
- score descendente.

Estas reglas deben ser explícitas y configurables.

---

# 21. RECOMMENDATION ENGINE

Producir:

```text
TEST_NOW
WATCHLIST
RESEARCH_MORE
REJECT
```

Ejemplo inicial:

```text
90–100 = TEST_NOW
80–89  = TEST_NOW or WATCHLIST depending risk
65–79  = WATCHLIST
50–64  = RESEARCH_MORE
<50    = REJECT
```

No basarse únicamente en thresholds.

Permitir reglas bloqueantes.

Ejemplo:

```text
if regulatory_risk == CRITICAL:
    REJECT
```

---

# 22. WATCHLIST

Guardar productos interesantes.

Campos:

```text
product_id
cluster_id
canonical_name
status
created_at
updated_at
reason_added
current_score
previous_score
lifecycle
risk
priority
```

Estados:

```text
NEW
MONITORING
TEST_CANDIDATE
TESTED
REJECTED
ARCHIVED
```

---

# 23. SNAPSHOTS TEMPORALES

La capacidad clave del sistema será comparar el mercado a lo largo del tiempo.

Crear snapshots.

Ejemplo:

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

NO sobrescribir históricos.

Guardar series temporales.

---

# 24. DIFF ENGINE

Comparar:

```text
T
vs
T-1
vs
T-7d
vs
T-14d
```

Detectar:

```text
new_advertiser
advertiser_removed
large_score_increase
large_score_drop
creative_spike
longevity_threshold_crossed
watchlist_promotion
saturation_risk
```

---

# 25. SIGNAL ENGINE

Crear eventos estructurados.

Ejemplo:

```json
{
  "type": "PRODUCT_SCORE_SPIKE",
  "product_id": "P912",
  "old_score": 72,
  "new_score": 84,
  "delta": 12,
  "severity": "HIGH"
}
```

Posibles señales:

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

---

# 26. REPORTES

## Daily Product Intelligence Report

Ejemplo:

```text
CASAMABLE PRODUCT INTELLIGENCE
DATE

TEST NOW

1. Product X   91 ↑7
2. Product Y   87 ↑14
3. Product Z   84 ↑3

EMERGING

4. Product A   78 ↑21
5. Product B   74 ↑16

SATURATING

6. Product C   81 ↓4

NEW DISCOVERIES

Products scanned: 43
Shortlisted: 7
Watchlist: 3
Strong candidates: 2
```

---

# 27. PRODUCT DOSSIER

Implementar comando o función conceptual:

```text
research product_id
```

Salida:

```text
PRODUCT
Canonical name

Opportunity Score
Momentum
Lifecycle
Recommendation

Meta Validation
Advertisers
Active ads
Median ad age
Oldest ad
Creative velocity

Top advertisers

Top hooks

Top angles

Pain points

Audience

Offers

Price observations

Economics

Saturation

Risks

Why test

Why not test

Recommended creative angles

Confidence
```

---

# 28. CONFIDENCE SCORE

Cada recomendación debe incluir confianza.

Ejemplo:

```text
HIGH
MEDIUM
LOW
```

Basado en:

```text
cantidad de anuncios
calidad de datos
cantidad de advertisers
economics disponibles
calidad del clustering
duración observada
```

Nunca presentar una predicción débil como certeza.

---

# 29. ALMACENAMIENTO

Preferencia:

crear tablas o colecciones NUEVAS.

Ejemplo:

```text
pi_ads
pi_ad_snapshots
pi_advertisers
pi_products
pi_product_aliases
pi_product_clusters
pi_creatives
pi_angles
pi_queries
pi_product_scores
pi_product_signals
pi_watchlist
pi_reports
pi_provider_runs
```

Prefijo recomendado:

`pi_`

para minimizar colisiones con esquemas existentes.

No modificar tablas existentes salvo necesidad extrema.

---

# 30. MODELOS DE DATOS MÍNIMOS

## Product

```python
Product(
    id,
    canonical_name,
    aliases,
    category,
    pain_points,
    audience,
    first_seen,
    last_seen
)
```

## Advertiser

```python
Advertiser(
    id,
    name,
    page_id,
    domain,
    first_seen,
    last_seen
)
```

## Ad

```python
Ad(
    id,
    advertiser_id,
    product_id,
    start_date,
    end_date,
    is_active,
    copy,
    landing_url,
    media_type
)
```

## ProductScore

```python
ProductScore(
    product_id,
    timestamp,
    opportunity_score,
    momentum_score,
    saturation_score,
    economics_score,
    casamable_fit_score,
    recommendation
)
```

---

# 31. JOBS 24/7 EN NAS

El agente corre permanentemente.

Construir jobs que sean:

```text
idempotentes
resumibles
tolerantes a fallos
rate-limit aware
observables
```

Ejemplo lógico:

```text
Discovery Job
Monitoring Job
Scoring Job
Reporting Job
```

Frecuencias deben quedar configurables.

NO imponer cron directamente si el proyecto ya tiene scheduler.

Utilizar scheduler existente mediante una integración no invasiva.

Si no existe una forma segura:

crear jobs ejecutables manualmente y documentar cómo conectarlos.

---

# 32. ESTABILIDAD

Debido a que corre 24/7:

implementar:

```text
timeouts
retries
exponential backoff
circuit breaker cuando aplique
rate limit handling
graceful failure
checkpointing
```

Un fallo del Product Intelligence Engine NO puede tirar el agente principal.

Envolver ejecución:

```python
try:
    ...
except Exception:
    log_exception(...)
```

Nunca silenciar errores.

---

# 33. LOGGING

Usar el sistema de logging existente si existe.

Crear namespace:

```text
product_intelligence
```

Ejemplo:

```text
INFO
product_intelligence.discovery

INFO
product_intelligence.scoring

WARNING
product_intelligence.provider

ERROR
product_intelligence.job
```

No modificar configuración global del logger si puede afectar al agente.

---

# 34. OBSERVABILIDAD

Registrar:

```text
run_id
provider
queries_executed
ads_scanned
advertisers_scanned
products_detected
clusters_created
scores_updated
signals_generated
duration
errors
```

Esto debe permitir saber si el motor realmente está funcionando.

---

# 35. FEATURE FLAG

Crear flag:

```text
PRODUCT_INTELLIGENCE_ENABLED=false
```

Por defecto en desarrollo:

```text
false
```

Activación explícita.

También:

```text
PRODUCT_INTELLIGENCE_DRY_RUN=true
```

Dry run debe:

- permitir discovery;
- permitir análisis;
- permitir scoring;
- no disparar acciones externas;
- no modificar funcionalidades existentes.

---

# 36. CONFIGURACIÓN

No hardcodear:

```text
thresholds
weights
frequencies
query limits
lookback windows
scoring rules
lifecycle thresholds
```

Mover a configuración.

Ejemplo:

```yaml
product_intelligence:
  enabled: false

  discovery:
    max_queries_per_run: 100

  windows:
    short: 7
    medium: 14
    long: 30

  scoring:
    ...
```

Adaptar al sistema de configuración existente.

---

# 37. SEGURIDAD

No imprimir:

```text
access tokens
secrets
credentials
cookies
API keys
```

No guardar secretos en BD.

No añadir credenciales al repositorio.

Usar variables de entorno existentes.

---

# 38. TESTS

Crear tests dentro del nuevo módulo.

Mínimo:

```text
unit tests
scoring tests
lifecycle tests
clustering tests
diff engine tests
adapter tests con mocks
economics adapter tests
signal engine tests
```

Test crítico:

> activar Product Intelligence no debe alterar el comportamiento de módulos existentes.

Cuando sea viable crear test de regresión o smoke test.

---

# 39. BACKWARD COMPATIBILITY

El agente debe funcionar exactamente igual:

```text
PRODUCT_INTELLIGENCE_ENABLED=false
```

y el nuevo módulo no debe generar ninguna diferencia observable fuera de logs del propio módulo.

---

# 40. ROLLOUT

Implementar por fases.

## FASE 0 — Inspection

- analizar repo;
- documentar arquitectura;
- identificar Meta module;
- identificar economics module;
- identificar storage;
- identificar scheduler;
- identificar logging.

NO tocar código todavía.

Crear documento:

```text
PRODUCT_INTELLIGENCE_INTEGRATION_PLAN.md
```

Incluyendo:

```text
existing modules consumed
new modules to create
risks
integration points
DB strategy
scheduler strategy
```

---

# 41. FASE 1 — CORE DOMAIN

Crear:

```text
models
repository
config
provider interface
normalization
scoring primitives
```

Sin ejecutar procesos automáticos.

---

# 42. FASE 2 — DISCOVERY

Crear:

```text
keyword engine
query expansion
ad ingestion
advertiser discovery
```

---

# 43. FASE 3 — INTELLIGENCE

Crear:

```text
longevity
creative velocity
product clustering
saturation
creative intelligence
angle intelligence
```

---

# 44. FASE 4 — MONITORING

Crear:

```text
snapshots
diff engine
signals
watchlist
```

---

# 45. FASE 5 — ECONOMICS

Conectar mediante adapter con el módulo económico ya existente.

NO modificar la calculadora.

---

# 46. FASE 6 — REPORTING

Crear:

```text
daily report
product dossier
watchlist report
```

---

# 47. FASE 7 — AUTOMATION

Solo cuando lo anterior esté estable:

conectar jobs al scheduler existente.

Mantener feature flag.

---

# 48. FASE 8 — FUTURE FEEDBACK LOOP

NO implementar todavía salvo que sea trivial dejar interfaces preparadas.

En el futuro:

```text
research score
↓
product tested by Casamable
↓
Meta Ads real performance
↓
CPA / CVR / ROAS / refund
↓
historical outcome
↓
scoring calibration
```

Modelo futuro:

```text
Research Candidate
    ↓
Approved Test
    ↓
Campaign
    ↓
Outcome
```

Esto permitirá aprender qué señales de Ad Library correlacionan mejor con resultados reales de Casamable.

---

# 49. PROHIBIDO EN LA PRIMERA VERSIÓN

No hacer:

```text
crear campañas automáticamente
editar campañas
pausar campañas
cambiar presupuestos
hacer pedidos
contactar proveedores
publicar productos
modificar Shopify
cambiar lógica económica
```

El primer objetivo es:

> PRODUCT INTELLIGENCE.

No ejecución comercial.

---

# 50. CASAMABLE PRODUCT PROFILE

Utilizar inicialmente como hipótesis:

Casamable busca especialmente productos:

```text
problema → solución clara
visual
demostrable
mercado amplio
especialmente 40+
COD friendly
PVP aprox. 25–50 €
coste suficientemente bajo
margen alto
fácil logística
sin tallas
bajo retorno
varios ángulos creativos
```

Ejemplos de familias coherentes:

```text
dolor
movilidad
pies
uñas
juanetes
cervical
postura
limpieza
hogar
mascotas
comodidad
mayores
```

NO limitar permanentemente discovery a estos nichos.

Utilizarlos como prior.

---

# 51. EXPLICABILIDAD

Cada score debe poder explicar:

```text
por qué recibió esos puntos
qué señales ayudaron
qué señales penalizaron
qué datos faltan
```

Ejemplo:

```json
{
  "opportunity_score": 86,
  "positive_factors": [
    "4 advertisers with 30d+ ads",
    "high creative velocity",
    "strong visual pain point"
  ],
  "negative_factors": [
    "advertiser growth accelerating"
  ],
  "missing_data": [
    "supplier cost"
  ]
}
```

---

# 52. NO OVERENGINEERING

Construir primero una versión funcional y observable.

Prioridad:

```text
correctness
stability
isolation
usefulness
```

antes que:

```text
microservices
distributed systems
complex ML
event buses
```

El agente vive en un NAS.

Optimizar para:

```text
simple
maintainable
efficient
recoverable
```

---

# 53. PERFORMANCE

Evitar análisis multimodal repetido.

Cachear resultados.

Ejemplo:

```text
creative_hash
analysis_version
analysis_result
```

Si el mismo creativo aparece varias veces:

no analizarlo de nuevo.

---

# 54. VERSIONADO DE ANALYSIS

Guardar:

```text
analyzer_version
scoring_version
clustering_version
```

para poder recalcular históricos.

---

# 55. DEDUPLICACIÓN

Utilizar hashes para evitar duplicados:

```text
ad_id
landing_url
media_hash
creative_hash
product_cluster
```

---

# 56. PROVIDER RUNS

Registrar cada ejecución de proveedor.

Ejemplo:

```text
provider_run_id
started_at
finished_at
queries
results
errors
rate_limits
```

Esto será importante para debug.

---

# 57. COMANDOS OPERATIVOS

Si el agente tiene CLI/comandos internos, añadir de forma aislada:

```text
product-intelligence status
product-intelligence discover
product-intelligence scan <query>
product-intelligence research <product_id>
product-intelligence watchlist
product-intelligence report
product-intelligence run --dry
```

Adaptar a la interfaz real.

---

# 58. OUTPUT MACHINE-READABLE

Además del reporte humano, generar JSON.

Ejemplo:

```json
{
  "product_id": "P912",
  "name": "Electric Callus Remover",
  "opportunity_score": 86,
  "momentum_score": 88,
  "lifecycle": "SCALING",
  "recommendation": "TEST_NOW"
}
```

Esto permitirá que otros módulos del agente consuman el resultado en el futuro.

---

# 59. API INTERNA

Crear servicio interno simple:

```python
class ProductIntelligenceService:

    def discover_products(...):
        ...

    def analyze_product(product_id):
        ...

    def get_watchlist():
        ...

    def generate_daily_report():
        ...
```

Otros módulos deberían consumir esta capa y no acceder directamente a tablas.

---

# 60. CRITERIOS DE ACEPTACIÓN V1

La V1 se considera completada cuando:

1. El módulo existe de forma aislada.
2. Feature flag funciona.
3. Puede ingerir anuncios desde al menos un provider.
4. Puede normalizar anunciantes/anuncios.
5. Puede detectar o crear productos.
6. Puede agrupar alias básicos.
7. Calcula longevidad.
8. Calcula creative velocity.
9. Calcula saturation.
10. Consume economics mediante adapter.
11. Calcula Opportunity Score.
12. Asigna Lifecycle.
13. Produce recommendation.
14. Guarda snapshots.
15. Detecta cambios.
16. Mantiene watchlist.
17. Genera dossier.
18. Genera daily report.
19. Tiene tests.
20. No modifica comportamiento existente.

---

# 61. CRITERIO DE CERO REGRESIONES

Antes de finalizar:

ejecutar tests existentes del repositorio.

Luego ejecutar tests nuevos.

Comparar.

Si cualquier test existente falla debido a cambios del nuevo módulo:

> solucionar sin cambiar la lógica antigua.

---

# 62. COMMIT STRATEGY

Hacer cambios pequeños y revisables.

Ejemplo:

```text
feat(product-intelligence): add domain models
feat(product-intelligence): add provider interface
feat(product-intelligence): add scoring engine
feat(product-intelligence): add snapshots
```

Evitar mega commit si es posible.

---

# 63. DOCUMENTACIÓN

Crear:

```text
docs/product-intelligence/
```

o ubicación equivalente.

Documentos:

```text
README.md
ARCHITECTURE.md
SCORING.md
DATA_MODEL.md
OPERATIONS.md
```

---

# 64. README

Debe explicar:

```text
qué hace
qué no hace
cómo habilitarlo
cómo ejecutar dry-run
cómo ejecutar discovery
cómo generar report
qué módulos existentes consume
```

---

# 65. ARCHITECTURE.md

Debe incluir:

```text
diagram
data flow
providers
storage
jobs
existing adapters
```

---

# 66. SCORING.md

Debe explicar cada métrica.

Ejemplo:

```text
Longevity
Creative Velocity
Momentum
Saturation
Casamable Fit
Economics
Opportunity
```

---

# 67. OPERATIONS.md

Debe explicar cómo operar el módulo en NAS.

Ejemplo:

```text
start
stop
dry-run
status
logs
DB health
provider failures
manual report
```

No asumir Docker, systemd, cron u otra tecnología hasta inspeccionar el proyecto.

---

# 68. PRINCIPIO DE DATOS

Separar:

```text
OBSERVED
DERIVED
INFERRED
```

Ejemplo:

```text
observed:
ad_start_date

derived:
ad_age_days

inferred:
likely_scaling
```

Esto evita confundir hechos con inferencias.

---

# 69. IMPORTANTÍSIMO: NO CONFUNDIR LONGEVIDAD CON RENTABILIDAD

El sistema nunca debe afirmar:

```text
ad activo 30 días = rentable
```

Debe formular:

```text
long-running ad = positive validation signal
```

Es una inferencia.

---

# 70. IMPORTANTÍSIMO: NO CONFUNDIR ACTIVIDAD CON ESCALADO

Muchos creativos pueden significar:

```text
testing
creative iteration
scale
```

El sistema debe combinar señales.

---

# 71. IMPORTANTÍSIMO: EVITAR HALLUCINATIONS

Si no hay datos:

```text
unknown
```

No estimar salvo que exista un método explícito.

Si se estima:

```text
value
confidence
method
```

---

# 72. FIRST IMPLEMENTATION TASK FOR CODEX

Comenzar realizando SOLO estas acciones:

### Paso 1

Inspeccionar repositorio.

### Paso 2

Identificar:

```text
Meta integration
economics calculator
scheduler
database
logging
configuration
agent entrypoints
```

### Paso 3

Crear:

```text
PRODUCT_INTELLIGENCE_INTEGRATION_PLAN.md
```

### Paso 4

El plan debe indicar exactamente:

```text
FILES TO CREATE
FILES TO READ
EXISTING MODULES TO CONSUME
FILES THAT MUST NOT BE MODIFIED
DATABASE STRATEGY
SCHEDULER STRATEGY
RISK AREAS
```

### Paso 5

NO empezar a modificar funcionalidades existentes.

### Paso 6

Después del plan, implementar el nuevo módulo gradualmente.

---

# 73. INSTRUCCIÓN FINAL PARA CODEX

Tu misión no es reconstruir el agente.

Tu misión es añadir un nuevo subsistema de Product Intelligence de calidad producción.

Debes tratar el agente existente como un sistema en producción.

Asume que cualquier modificación innecesaria puede romper procesos importantes.

Por tanto:

```text
ADD > MODIFY
ADAPTER > REWRITE
READ-ONLY > MUTATE
FEATURE FLAG > FORCED ENABLE
DRY-RUN > DIRECT EXECUTION
NEW TABLE > ALTER TABLE
ISOLATION > COUPLING
OBSERVABILITY > SILENT FAILURE
DETERMINISTIC METRIC > LLM GUESS
```

Antes de tocar cualquier archivo existente, pregúntate:

> ¿Puedo conseguir lo mismo creando un nuevo módulo, adapter o extensión?

Si la respuesta es sí:

> NO MODIFIQUES EL ARCHIVO EXISTENTE.

El resultado final debe ampliar al agente sin cambiar ni interferir con ninguna capacidad que ya tenga.

---

# 74. VISIÓN FINAL DEL SISTEMA

```text
META / AD SOURCES
       ↓
DISCOVERY
       ↓
NORMALIZATION
       ↓
PRODUCT CLUSTERING
       ↓
ADVERTISER INTELLIGENCE
       ↓
CREATIVE INTELLIGENCE
       ↓
LONGEVITY / VELOCITY / SATURATION
       ↓
ECONOMICS
       ↓
CASAMABLE FIT
       ↓
OPPORTUNITY SCORE
       ↓
MOMENTUM
       ↓
LIFECYCLE
       ↓
WATCHLIST
       ↓
SIGNALS
       ↓
DAILY REPORT
       ↓
HUMAN APPROVAL
       ↓
PRODUCT TEST
```

FASE FUTURA:

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

Objetivo final:

> convertir el product research de Casamable en un sistema propio, acumulativo y cada vez más inteligente, sin comprometer la estabilidad del agente existente.


---

# 75. ADAPTIVE QUERY EXPLORATION ENGINE

Crear un subsistema específico denominado conceptualmente:

`Adaptive Query Exploration Engine`

Este componente será responsable de generar, priorizar, ejecutar, expandir y aprender de las búsquedas utilizadas para descubrir productos.

IMPORTANTE:

El sistema NO debe depender de una lista estática de keywords.

Las keywords iniciales son únicamente semillas.

El motor debe poder generar nuevas búsquedas continuamente a partir de:

```text
productos encontrados
nombres alternativos
copies de anuncios
hooks
pain points
audiencias
landing pages
categorías
productos relacionados
competidores
catálogos de competidores
queries anteriores exitosas
queries derivadas de productos validados
```

---

# 76. DOS MODOS DE RESEARCH OBLIGATORIOS

La interfaz del Product Intelligence Engine debe ofrecer dos formas claramente diferenciadas de iniciar una investigación.

## MODO A — RESEARCH DESDE PALABRA INTRODUCIDA POR EL USUARIO

Nombre conceptual:

`Manual Seed Research`

El usuario introduce una palabra, frase, producto, problema, nicho, competidor o término de búsqueda.

Ejemplos:

```text
juanetes
dolor cervical
limador eléctrico
almohada cervical
pago contra reembolso
personas mayores
mascotas
```

### REGLA CRÍTICA

Cuando el usuario proporciona una palabra:

> PRIMERO se debe investigar EXACTAMENTE la palabra o frase introducida por el usuario.

NO generar variantes antes de realizar esa primera búsqueda.

NO sustituirla.

NO reinterpretarla.

NO comenzar buscando sinónimos antes de consultar el término original.

Flujo obligatorio:

```text
USER INPUT
   ↓
SEARCH EXACT USER QUERY
   ↓
INGEST RESULTS
   ↓
ANALYZE RESULTS
   ↓
CREATE INITIAL PRODUCT / ADVERTISER / CREATIVE FINDINGS
   ↓
GENERATE DERIVED QUERIES
   ↓
EXPAND RESEARCH
   ↓
ITERATE
```

Ejemplo:

Usuario introduce:

```text
juanetes
```

Primera operación:

```text
search("juanetes")
```

Solo DESPUÉS de procesar esos resultados puede generar:

```text
hallux valgus
corrector de juanetes
férula hallux
dolor de juanetes
corrector nocturno
separador de dedos
```

y continuar el research.

## Motivo

La palabra introducida por el usuario expresa una intención explícita.

Debe respetarse como punto de partida real y no perderse dentro de una generación automática.

---

# 77. MANUAL SEED RESEARCH — COMPORTAMIENTO

Después de analizar la keyword inicial, el motor debe decidir qué nuevas ramas tienen sentido.

Ejemplo:

```text
INPUT:
"durezas pies"

FIRST SEARCH:
"durezas pies"

DISCOVERED:
- limador eléctrico
- callus remover
- talones agrietados
- foot file
- electric foot file
- crema durezas
```

Entonces:

```text
Query Expander
    ↓
Priority Queue

HIGH:
limador eléctrico durezas
callus remover
electric foot file

MEDIUM:
talones agrietados
eliminar durezas pies

LOW:
crema durezas
```

El motor continúa investigando prioritariamente las ramas que estén devolviendo mejores señales.

---

# 78. RESULTADO DE LA PRIMERA BÚSQUEDA MANUAL

Guardar explícitamente:

```text
root_query
root_query_results
root_query_products
root_query_advertisers
root_query_ads
root_query_score
```

Toda query derivada debe mantener referencia a su origen:

```text
parent_query_id
root_query_id
depth
generation_reason
```

Ejemplo:

```text
juanetes
└── hallux valgus
    └── férula hallux
        └── corrector hallux nocturno
```

El sistema debe poder explicar:

```text
este producto fue descubierto originalmente a partir de la búsqueda "juanetes"
```

---

# 79. MODO B — AUTONOMOUS PRODUCT HUNTER

Nombre conceptual:

`Autonomous Research`

Debe existir un botón, comando o acción clara equivalente a:

```text
START AUTONOMOUS RESEARCH
```

o:

```text
AUTO HUNT
```

Cuando el usuario activa este modo:

NO necesita proporcionar ninguna palabra.

El sistema genera sus propias semillas.

Ejemplo:

```text
Casamable profile
      ↓
Seed Generator
      ↓
Query Queue
      ↓
Search
      ↓
Analyze
      ↓
Discover products
      ↓
Generate more queries
      ↓
Prioritize
      ↓
Repeat
```

---

# 80. AUTONOMOUS SEED GENERATOR

Generar semillas utilizando varias familias.

Ejemplos iniciales:

## Commercial intent

```text
pago contra reembolso
paga al recibirlo
envío 24/48h
envío gratis
2x1
oferta limitada
últimas unidades
segunda unidad
```

## Problems

```text
dolor
movilidad
pies
uñas
espalda
cervicales
postura
durezas
juanetes
limpieza
mascotas
descanso
```

## Audience

```text
personas mayores
mayores de 40
mayores de 50
mi madre
mi padre
mis padres
abuelos
```

## Product families

Generadas dinámicamente según el perfil Casamable.

El Seed Generator puede utilizar:

```text
rules
historical query performance
LLM
successful product history
Casamable profile
```

---

# 81. QUERY QUEUE

Crear una cola persistente de queries.

Campos sugeridos:

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

# 82. QUERY SOURCES

Toda query debe indicar cómo fue generada.

Ejemplo:

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

Esto permitirá aprender qué fuentes producen mejores oportunidades.

---

# 83. QUERY SCORING

Cada query debe obtener un score.

Ejemplo:

```text
Query:
"limador eléctrico durezas"

Results:
43

New products:
7

New advertisers:
5

Qualified products:
2

Average product opportunity:
82
```

Resultado:

```text
query_score = 91/100
```

Factores posibles:

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

---

# 84. PRIORITY-BASED EXPLORATION

NO procesar todas las queries con la misma prioridad.

Utilizar una priority queue.

Ejemplo:

```text
HIGH PRIORITY
- queries derivadas de productos con score >80
- queries que encontraron advertisers validados
- queries con alta tasa de productos nuevos
- ramas con crecimiento fuerte

MEDIUM
- queries prometedoras pero con poca evidencia

LOW
- queries con muchos duplicados
- queries con pocos productos relevantes
```

---

# 85. RECURSIVE QUERY EXPANSION

Cada búsqueda puede generar nuevas queries.

Ejemplo:

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
│   ├── férula
│   └── corrector nocturno
│
└── talones
    ├── talones agrietados
    └── foot care
```

La expansión debe poder continuar durante múltiples niveles.

---

# 86. GENERACIÓN PRÁCTICAMENTE ILIMITADA, PERO CONTROLADA

El sistema debe ser capaz de continuar generando nuevas queries de forma autónoma durante largos periodos.

Sin embargo:

NO implementar un bucle literalmente infinito sin controles.

Utilizar límites operativos configurables.

Ejemplos:

```text
MAX_QUERIES_PER_RUN
MAX_QUERIES_PER_HOUR
MAX_PROVIDER_CALLS
MAX_DEPTH_PER_BRANCH
MAX_EMPTY_RESULTS
MAX_DUPLICATE_RATE
MAX_LOW_VALUE_QUERIES
```

El sistema puede continuar en el siguiente ciclo del agente.

Objetivo:

```text
continuous exploration
```

no:

```text
uncontrolled infinite loop
```

---

# 87. STOPPING ENGINE

Cada rama debe detenerse automáticamente cuando deja de aportar valor.

Ejemplos:

```text
últimas 20 queries:
0 nuevos productos
```

o:

```text
duplicate_rate > 95%
```

o:

```text
query_score < minimum threshold
```

o:

```text
branch qualified products = 0 after N iterations
```

Entonces:

```text
branch.status = EXHAUSTED
```

El resto del sistema continúa explorando otras ramas.

---

# 88. SEARCH UNTIL TARGET

El usuario o el modo autónomo debe poder definir objetivos.

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

El motor podrá continuar explorando hasta:

```text
qualified_products >= target
```

o hasta alcanzar los límites operativos definidos.

Guardar:

```text
search_goal
target_count
found_count
goal_status
```

Estados:

```text
RUNNING
TARGET_REACHED
EXHAUSTED
LIMIT_REACHED
PAUSED
```

---

# 89. AUTONOMOUS RESEARCH LOOP

Flujo conceptual:

```python
while run_budget_available():

    query = query_queue.get_highest_priority()

    results = search(query)

    findings = analyze(results)

    store(findings)

    update_query_score(query, findings)

    new_queries = generate_queries(findings)

    deduplicate(new_queries)

    prioritize(new_queries)

    query_queue.add(new_queries)

    update_products()

    update_watchlist()

    detect_signals()

    if research_goal_reached():
        break
```

La implementación real debe adaptarse a la arquitectura existente.

---

# 90. AUTO-HUNT 24/7

El NAS permite que el agente ejecute esta exploración durante largos periodos.

Diseñar el sistema para que el modo autónomo pueda trabajar por ciclos.

Ejemplo:

```text
Cycle 1
50 queries

↓ save state

Cycle 2
50 queries

↓ save state

Cycle 3
50 queries
```

Nunca depender de mantener un único proceso infinito en memoria.

Persistir:

```text
pending queries
priority
branch state
research goals
products
signals
```

Así el proceso puede reiniciarse sin perder progreso.

---

# 91. UI / BUTTON BEHAVIOR

Si existe interfaz gráfica o panel dentro del agente, añadir dos acciones claramente diferenciadas.

## Acción 1

```text
RESEARCH KEYWORD
```

Input:

```text
[________________]
```

Button:

```text
START RESEARCH
```

Comportamiento:

```text
1. tomar exactamente el texto del usuario;
2. buscar ese texto exacto primero;
3. analizar;
4. mostrar primeros resultados;
5. comenzar expansión inteligente;
6. continuar research según configuración.
```

## Acción 2

Button:

```text
AUTO HUNT
```

Comportamiento:

```text
1. generar seeds automáticamente;
2. crear query queue;
3. investigar;
4. expandir;
5. priorizar;
6. detectar productos;
7. mantener watchlist;
8. continuar por ciclos.
```

NO obligar al usuario a introducir una keyword para `AUTO HUNT`.

---

# 92. COMANDOS EQUIVALENTES

Si no existe UI, crear comandos equivalentes.

Ejemplo conceptual:

```text
product-intelligence research "juanetes"
```

Debe:

```text
SEARCH EXACTLY "juanetes" FIRST
```

Luego expandir.

Y:

```text
product-intelligence auto-hunt
```

Debe iniciar research autónomo.

También:

```text
product-intelligence auto-hunt --goal 5
product-intelligence auto-hunt --min-score 80
```

Adaptar sintaxis a la arquitectura real.

---

# 93. EXACT USER QUERY GUARANTEE

Crear test específico.

Input:

```text
"almohada cervical"
```

Expected first provider call:

```text
"almohada cervical"
```

NO:

```text
"almohada ortopédica"
```

NO:

```text
"dolor cervical"
```

NO:

```text
"cervical pillow"
```

hasta DESPUÉS de haber ejecutado y procesado la búsqueda original.

Este comportamiento es obligatorio.

---

# 94. QUERY DEDUPLICATION

Evitar:

```text
juanetes
Juanetes
JUANETES
juanetes 
```

como búsquedas distintas.

Mantener:

```text
display_query
normalized_query
```

Pero respetar la query exacta introducida por el usuario en la primera búsqueda.

---

# 95. CROSS-LANGUAGE EXPANSION

Después de procesar la query original, permitir expansión a otros idiomas cuando tenga valor.

Ejemplo:

```text
limador eléctrico
↓
electric callus remover
electric foot file
callus remover
```

Esto puede descubrir competidores o tendencias internacionales.

Guardar idioma:

```text
language
origin_language
translation_reason
```

---

# 96. FEEDBACK LOOP DE QUERIES

Cuando un producto posteriormente sea testeado por Casamable, guardar qué queries contribuyeron a descubrirlo.

Ejemplo:

```text
PRODUCT:
P912

Discovery path:

"durezas pies"
↓
"limador eléctrico"
↓
"electric callus remover"
```

Si el producto posteriormente obtiene buenos resultados reales:

aumentar la reputación histórica de:

```text
query
query_family
query_source
branch
```

No implementar ML complejo inicialmente.

Comenzar con estadísticas deterministas.

---

# 97. QUERY FAMILY PERFORMANCE

Agrupar familias.

Ejemplo:

```text
foot_pain
cervical
cleaning
pet_hair
mobility
random_gadgets
```

Guardar:

```text
queries_run
products_found
qualified_products
tested_products
winning_products
average_opportunity_score
```

Esto permitirá al agente asignar más capacidad de exploración a las áreas con mejores resultados históricos.

---

# 98. USER CONTROL

El usuario debe poder:

```text
start
pause
resume
stop
```

una sesión autónoma.

Detener el research NO debe borrar:

```text
query queue
results
products
watchlist
snapshots
```

Debe poder reanudarse.

---

# 99. RESEARCH SESSION MODEL

Crear concepto:

```text
ResearchSession
```

Campos:

```text
session_id
mode
user_query
goal
status
started_at
paused_at
completed_at
queries_processed
products_found
qualified_products_found
```

`mode`:

```text
MANUAL_SEED
AUTONOMOUS
```

---

# 100. REGLA FINAL DEL QUERY ENGINE

El Product Intelligence Engine debe soportar ambos comportamientos simultáneamente:

### Cuando Pedro da una palabra:

```text
PEDRO
↓
"juanetes"
↓
SEARCH EXACT USER QUERY FIRST
↓
RESEARCH
↓
GENERATE NEW QUERIES
↓
EXPAND
↓
FIND OPPORTUNITIES
```

### Cuando Pedro pulsa AUTO HUNT:

```text
AUTO HUNT
↓
GENERATE SEEDS
↓
SEARCH
↓
ANALYZE
↓
GENERATE NEW QUERIES
↓
EXPAND
↓
PRIORITIZE
↓
REPEAT
↓
FIND OPPORTUNITIES
```

Estas dos rutas deben compartir el mismo motor de análisis y scoring, pero tener puntos de entrada distintos.

La búsqueda manual nunca debe perder prioridad sobre la intención explícita del usuario.

