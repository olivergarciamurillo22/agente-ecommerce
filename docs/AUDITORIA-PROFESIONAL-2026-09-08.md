# Auditoría profesional — Casamable Agent (08-09-2026)

Due diligence técnica y de negocio antes de seguir invirtiendo. Solo lectura:
no se ha tocado el NAS, no hay merge, no hay código nuevo. Alcance:
`release/casamable-v4.3` (en producción, `22f8013`, esquema 30) y
`feat/product-hunter-backend` (`cdfc1b7`, esquema 31, sin desplegar), más los
worktrees `hunter-end-to-end-v1` y `platform-companies` y el historial de
las 59 ramas remotas. Método: cinco lecturas independientes en paralelo
(inventario, flags y deuda, seguridad, Cazador adversarial, negocio) con
verificación cruzada de los hallazgos graves sobre el código. Todo lo que
no se pudo verificar se dice.

> ## Errata (08-09-2026, tarde) — correcciones de Pedro sobre el diagnóstico
>
> La auditoría se hizo sobre el repositorio y su documentación, sin acceso
> al `.env` real del NAS. Dos conclusiones se apoyaban en documentación
> desactualizada y **Pedro las corrige**:
>
> 1. **El negocio SÍ está encendido.** El sistema confirma pedidos de
>    clientes reales, la IA está activa y el detector de direcciones
>    funciona en real. La lectura «`TEST_MODE=1`, allowlist de 2, piloto
>    BLOCKED» del punto 1 del resumen y de la fila 1 de la priorización
>    venía de `ESTADO-PRODUCCION.md`, `REAL-PILOT-02-09.md` y
>    `CONTEXTO-2026-08-24.md`, que no se habían actualizado. Los valores
>    exactos de rollout y flags en el NAS siguen sin estar en el repo:
>    `ESTADO-PRODUCCION.md` §1 lo deja anotado como pendiente de volcar.
> 2. **Dropea vs Beeping no es una decisión pendiente.** El enrutado ya es
>    por producto (`dispatch_channels`); lo que falta es que Beeping
>    entregue la información de conexión. Es un bloqueo externo, no una
>    decisión interna (fila 2 de la priorización).
>
> Lo que sigue en pie: el resto de hallazgos de seguridad (los dos altos ya
> corregidos en `f427b9f` y `0228ad5`, pendientes de desplegar), la deuda
> técnica, y la condición sobre el Cazador: **el Score de Oportunidad
> Validada no se usa como criterio de compra de stock hasta corregir C1–C6**;
> como herramienta de exploración manual puede seguir puliéndose. El texto
> original se conserva tal cual debajo, para que se vea qué se afirmó y con
> qué base.

## Resumen ejecutivo (leer esto si no se lee nada más)

1. **El negocio no está encendido.** Producción lleva desde agosto en
   `TEST_MODE=1` con una allowlist que, según el último dato documentado,
   tiene dos números (Pedro y Óliver). El piloto real está en `BLOCKED` desde
   el 02-09 con las 23 casillas de evidencia en `PENDING`. Ningún documento
   acredita que un cliente real haya recibido una confirmación automática.
   Todo lo construido en cinco semanas (workspace, llamadas, Beeping,
   Cazador, Landing Studio, cruce Dropea × Ad Library) cuelga de un flujo
   que no se ha abierto. Esta es la decisión que vale más que todas las demás
   juntas y lleva 15 días sin tomarse.
2. **Tres sistemas de descubrimiento de productos coexisten**: el PI Engine
   (rama `hunter-end-to-end-v1`, 1.161 líneas, JSON en fichero), el Hunter
   predictivo (409 líneas, sin ninguna ruta que lo llame) y el Cazador
   interno recién construido (1.338 líneas, esquema 31). Ninguno ha producido
   una decisión de compra. Es el mejor candidato a dejar de construir.
3. **El Score de Oportunidad Validada, tal como está, puede llevar a una mala
   compra.** Agrupa por anunciante en vez de por producto (el precio y la
   antigüedad pueden ser de otro artículo de la misma tienda), casa por
   subcadena («cama» ⊂ «cámara»), toma una variante arbitraria de Dropea como
   coste y marca como «sin match» para siempre a un producto cuya consulta
   falló por cuota. Lo digo con la misma vara que a código ajeno: es mío,
   pasó 803 tests y esos tests no lo habrían detectado. **No desplegar el
   cruce como criterio de compra sin corregir cinco cosas** (§4).
4. **Seguridad: un hallazgo alto y uno que se convertirá en alto.** El
   `ad_snapshot_url` que devuelve Meta lleva el token de acceso en la query y
   el sistema lo persiste en SQLite y lo enseña como enlace en el panel; hoy
   es inocuo porque el token está caducado, el día que se renueve el token
   estará en la base, en exportaciones JSON y en el navegador. Y
   `markOrderToSend` (Beeping) no pasa por `EMERGENCY_STOP`: la parada de
   emergencia no para las escrituras al almacén. Contenido solo por
   `BEEPING_INTEGRATION_ENABLED=0`.
5. **Deuda de proceso**: 142 commits en una semana de un solo autor, 59
   ramas remotas (18 sin fusionar), 121 documentos con siete cifras
   distintas para «el esquema en producción», un fichero de tests de 17.249
   líneas, y ocho módulos del kit original (Baileys, guardrails, humanize,
   memory, airtable, vision, transcribe, tools) que no se ejecutan en
   producción pero se mantienen y se despliegan.

Lo que está genuinamente bien y conviene no romper: la doctrina fail-closed
de `src/lib/safety.ts` (defaults invertidos), la verificación de firma en
tiempo constante en los cuatro webhooks, `sanitizeForEvents` en todos los
sumideros de observabilidad, la negativa a mandar texto libre del cliente a
un proveedor, la identidad de build en `/api/health/live`, y una suite que,
con sus limitaciones, ha atrapado bugs reales antes de producción (probe sin
presupuesto, plantilla de 5 variables, top-level await).

---

## 1 · Mapa del sistema tal como está hoy

### 1.1 Tamaño

| Área | Líneas | Nota |
|---|---:|---|
| `src/lib/` | 41.179 | 18 carpetas + 15 ficheros sueltos; `db.ts` solo tiene 4.631 |
| `src/components/` | 14.643 | |
| `src/app/api/` | 3.058 en 48 rutas | |
| `scripts/` | 66 ficheros `.ts` + 2 `.sh` | 72 scripts npm |
| `tests/run-tests.ts` | 17.249 líneas, 795 `await test(` | un solo fichero |
| `docs/` | 121 ficheros `.md` | 21 huérfanos |
| Dependencias | 15 prod + 10 dev | `npm audit`: 0 vulnerabilidades (prod y dev) |

### 1.2 Inventario de módulos y estado

Estado según `docs/ESTADO-PRODUCCION.md` y `docs/deploy/DEPLOY-REPORT-v4.3-2026-09-07.md`, no según el NAS real (no consultado).

| Módulo | Líneas | Qué hace | Estado |
|---|---:|---|---|
| `src/lib/db.ts` | 4.631 | Esquema, 31 migraciones, todo el acceso a datos; 155 importadores | Producción. Punto único de fallo |
| `src/lib/safety.ts` | 397 | Gates fail-closed, allowlist, rampa, ventana horaria; 41 importadores | Producción |
| `src/lib/orders/` | 5.254 | Núcleo COD: normalización, máquina de confirmación (`confirmation.ts`, 1.002), scheduler (416), cierre, auto-despacho, direcciones, intención IA | Producción; IA y auto-despacho apagados por flag |
| `src/lib/whatsapp/` | 1.521 | Cloud API de Meta, webhook, outbox, plantillas | Producción (`cloud_api`) |
| `src/lib/shopify/` | 2.005 | Admin API, HMAC, webhooks, backfill, reconcile | Producción; única escritura: tag `WA_CONFIRMED`, gateada |
| `src/lib/system/` | 5.351 | Salud, alertas, métricas, leases, retención, predeploy | Producción |
| `src/lib/tracking/` | 1.052 | Estados de envío, avisos postventa, polling | Producción; avisos apagados por flag |
| `src/lib/suppliers/dropea/` | ~2.200 | Cliente, webhook, reconcile, creación (desactivada por `create-gate`) | Producción read-only; la app oficial de Dropea crea los pedidos |
| `src/lib/suppliers/dropi/` | ~760 | Andamiaje fail-closed | Sin API (soporte de Dropi, 25-08); «dead API scaffold» según su propio contrato |
| `src/lib/beeping/` | 1.633 | Almacén Beeping: cliente, sync, release, cancel | Desplegado, **apagado, sin credencial**; `POST /api/order/` no está escrito |
| `src/lib/calls/` | 2.500 | Orquestador Retell | Desplegado, **MANUAL-ONLY**, `RETELL_LIVE` FAIL (sin `RETELL_AGENT_VERSION`) |
| `src/lib/meta-ads/` | 826 | Insights read-only, atribución | Producción read-only |
| `src/lib/hunter/discovery/` + `audit/` | ~2.700 | Buscador de competencia en Ad Library, auditor de tiendas, cola de trabajos en el bot | Producción; **token caducado desde el 02-09** |
| `src/lib/hunter/predictive/` | 409 | Rangos de precio predictivos | **A medias**: tabla desplegada (esquema 20), ninguna ruta ni worker lo llama; solo `scripts/hunter-predictivo.ts` |
| `src/lib/product-hunter/` | 3.469 | Adaptador del panel «Cazador de productos» + `internal/` (1.338, esquema 31) | `internal/` **construido, no desplegado** (`feat/product-hunter-backend`) |
| `src/lib/landing/` (102 líneas físicas, 22 KB) | — | Generador HTML→Liquid **minificado a una línea por fichero** | Producción por ruta, uso por CLI |
| `src/lib/landing-studio/` | 482 | Blueprint, viabilidad, export | Producción (v4.3), pero `docs/LANDING-STUDIO.md:3-4` aún dice «sin desplegar»; persiste en `localStorage` del navegador |
| `src/lib/cod-calculator/` | 656 | Break-even y modelos COD | Producción |
| `src/lib/auth/`, `workspace.ts` | 143 | Login scrypt, sesiones, roles owner/agent | Producción; **no consta ningún usuario `agent` creado** |
| `src/lib/baileys/` + `guardrails` + `humanize` + `memory` + `airtable` + `vision` + `transcribe` + `tools/` + `system-prompt` + `openrouter.generateReply` | ~2.100 | El agente conversacional del kit genérico | **Código muerto en producción**: `scripts/start-bot.ts:93-103` no arranca Baileys con `cloud_api`. Se compila, se testea y se despliega igual |
| `src/lib/watchdog.ts` | 306 | Latido, auditoría IA de conversaciones, alertas | Producción (desacoplado de Baileys tras el incidente del 03-09) |

Huérfanos estrictos (0 importadores): `src/lib/suppliers/dropea/adoption.ts` (129 líneas, dos funciones async sin consumidor), `src/lib/tools/agendar.ts`, `src/lib/tools/derivar-humano.ts` (desregistrados a propósito), `src/components/AmbientBackground.tsx`, `ConversationList.tsx`, `FinanceView.tsx`, `ModeToggle.tsx`.

### 1.3 Procesos que corren en el bot (`scripts/start-bot.ts`)

| # | Proceso | Cadencia | Lease |
|---|---|---|---|
| 1 | Loop de salida Cloud API (`cloud-outbox.ts:187`) | 2 s | `LEASE_OUTBOX` |
| 2 | Watchdog (`watchdog.ts:280`) | 5 min | `LEASE_WATCHDOG` |
| 3 | Scheduler de confirmaciones COD (`orders/scheduler.ts:385`) | `ORDER_POLL_SECONDS` | `LEASE_ORDERS` |
| 4 | Tracking polling (`tracking/scheduler.ts:130`) | 300 s | `LEASE_TRACKING` |
| 5 | Reconcile Shopify (`shopify/reconcile.ts:248`) | 6 h | `LEASE_RECONCILE` |
| 6 | Orquestador Retell (`calls/scheduler.ts:722`) | 60 s, kill switch cerrado | `LEASE_CALLS` |
| 7 | Scheduler Beeping (`beeping/scheduler.ts:63`) | 10 min, se autodesactiva sin credencial | — |
| 8 | Scheduler Meta Ads (`meta-ads/scheduler.ts:50`) | 6 h, se autodesactiva sin credenciales | — |
| 9 | Discovery worker del Cazador (`hunter/discovery/worker.ts:114`) | 10 s | **ninguno**: dos procesos `start:bot` sobre la misma base ejecutarían dos búsquedas a la vez |

### 1.4 Grafo de dependencias y radio de explosión

Aristas que importan (dirección «A importa B»):

```
webhook Shopify → shopify/webhook → orders/normalize, address-validation → db
orders/scheduler → orders/{eligibility,messages,auto-dispatch} → whatsapp.ts → whatsapp/{provider,meta-cloud,templates} → safety
whatsapp/meta-webhook → orders/confirmation → orders/{intent-ai,ai-cancellation,auto-dispatch,multi-order}
orders/auto-dispatch → suppliers/beeping (adaptador mínimo) · orders/dispatch-notice
suppliers/service → suppliers/{router,address} → beeping/* | dropea/*
suppliers/dropea/webhook → tracking/service → tracking/notifications → whatsapp.ts
api/product-hunter → product-hunter/adapter → product-hunter/internal → hunter/{repository,scoring,discovery,audit}, suppliers/dropea
api/hunter/competencia → hunter/discovery/{jobs,worker} → hunter/audit
```

| Si falla… | Deja de funcionar | Sigue funcionando |
|---|---|---|
| `db.ts` | Todo: bot, 48 rutas, 9 schedulers, 60 scripts. Sin degradación parcial | Nada |
| `safety.ts` | Si «abre»: WhatsApp real fuera de allowlist y discovery sin freno. Si «cierra»: no sale nada, nada se corrompe (es el diseño) | Panel y lecturas |
| `orders/scheduler` | Confirmaciones, recordatorios, escalados a `needs_call`. Es la pérdida más cara | Entrada de pedidos, panel |
| `whatsapp/provider` | Si detecta mal el proveedor arranca Baileys y Cloud API a la vez; el lease de outbox evita la doble entrega | — |
| `suppliers/dropea` | Se pierden `delivered/refused` reales: el cierre se queda en `unknown` y las métricas de rentabilidad se falsean | Confirmaciones |
| `hunter/discovery` | Competencia, auditor y cruce. **Radio cero sobre el flujo COD** (ya está degradado por el token y nadie lo ha notado en pedidos) | Todo lo demás |

### 1.5 Flags de entorno que gatean comportamiento

Fuente: `src/lib/config/env-schema.ts` (74 declaradas) y `grep process.env` en `src/` (**79 leídas en código que NO están en el esquema**, así que `env:doctor` y `readiness` no las auditan). Valor en producción: solo lo documentado; «no documentado» significa que ningún doc lo recoge, no que esté vacío.

| Variable | Qué activa | Lectura | Default | Producción documentada | Riesgo si se cambia sin saber |
|---|---|---|---|---|---|
| `EMERGENCY_STOP` | Freno global: WhatsApp, Shopify, Ad Library | `safety.ts:32` (`!== "0"` = activo) | activo si no está | «semántica fail-closed»; valor concreto **no documentado** | `=0` levanta el freno; **no para Beeping** (§3.1) |
| `TEST_MODE` | Solo allowlist + rampa | `safety.ts:52` | activo si no está | **`1`** | `=0` envía WhatsApp real a **cualquier** cliente: abre cinco sistemas a la vez |
| `TEST_PHONE_ALLOWLIST` | Teléfonos elegibles | `safety.ts:63` | vacía = nadie | contenido **no documentado** (último dato: 2 números, 24-08) | Añadir = envíos reales inmediatos |
| `whatsapp_rollout_percent` (settings, no env) | Rampa pilot/25/50/100 | `safety.ts:75-111` | `pilot` | **no verificable** | Subirla en el panel abre porcentaje de clientes reales |
| `APP_MODE` | Primera llave de envío real | `safety.ts:27` | `safe` | `production` | Vaciarlo deja de enviar sin más aviso que un banner |
| `WHATSAPP_SEND_ENABLED` | Tercera llave | `safety.ts:188` | `0` | `1` | — |
| `SHOPIFY_WRITE_ENABLED` | Tag `WA_CONFIRMED` | `safety.ts:279` | `0` | **no documentado** | `=1` escribe en pedidos reales |
| `MAX_ORDER_AGE_MINUTES` | Anti-replay/backfill | `safety.ts:296` | 30 | no documentado; **no está en el esquema** | Subirlo dispara WhatsApps sobre pedidos viejos en un backfill |
| `WHATSAPP_WINDOW_*` | Ventana 09:00–21:00 | `safety.ts:215-226` | activa | no documentado; **no en el esquema** | `_ENABLED=0` envía de madrugada |
| `ADDRESS_AI_VALIDATION_ENABLED` | Capa 2 direcciones (OpenAI) | `address-ai.ts:92` | `0` | `0` | `=1` gasta una llamada por pedido, puede abrir alertas en masa |
| `POST_CONFIRMATION_AI_ENABLED` | Intención + **auto-cancelación ≥ 0,85** | `intent-ai.ts:119` | `0` | `0` | `=1` deja que la IA cancele pedidos (localmente) |
| `AUTO_DISPATCH_COOLDOWN_ENABLED` | Cooldown antes de despachar | `auto-dispatch.ts:47` | `0` | `0` | `=1` con `dispatch_channels` vacía (así está) **retiene todos los pedidos** |
| `DISPATCH_NOTICE_WHATSAPP_ENABLED` | Plantilla de aviso de despacho | `dispatch-notice.ts:37` | `0` | `0` | Un mensaje más por cliente |
| `OPENAI_DAILY_CALL_LIMIT` | Tope diario IA | `ai-budget.ts:63` | 500 | no documentado | `0` = **sin tope** (es lo contrario de un freno) |
| `BEEPING_INTEGRATION_ENABLED` | mark-to-send al almacén | `suppliers/beeping.ts:25` | `0` | `0` (Beeping apagado) | `=1` libera envíos reales **sin pasar por `EMERGENCY_STOP`** |
| `BEEPING_WRITE_ENABLED` | release/cancel en Beeping | `beeping/config.ts:37` | `0` | `0` | Envíos reales |
| `DROPEA_WRITE_ENABLED` | Crear pedidos en Dropea | `dropea/create-gate.ts:98` | `0` | `0` | `=1` con su app oficial activa = **pedidos duplicados** |
| `DROPIPRO_WEBHOOK_ENABLED` | Receptor Dropi sin firma | `dropi/webhook.ts:37` | `0` | desactivado | `=1` acepta estados de envío sin autenticar |
| `AI_CALLS_ENABLED` / `CALLS_PILOT_MODE` / `CALLS_SHADOW_MODE` | Llamadas reales | `health-integrations.ts:531-580`, `calls/gates.ts` | `0`/`1`/`1` | kill switch cerrado | `CALLS_PILOT_MODE=0` con allowlist vacía = **sin restricción de destinatarios** |
| `META_AD_LIBRARY_ACCESS_TOKEN` | Cazador | `discovery/worker.ts:32` (respaldo: `META_ADS_ACCESS_TOKEN`) | — | **caducado** | Si falta cae al token de Ads: un solo token para dos productos |
| `PRODUCT_HUNTER_SOURCE` | Panel Cazador: `off/internal/api/mock` | `product-hunter/adapter.ts:116` | `off` | no documentado (`off` implícito) | `internal` requiere esquema 31 |
| `DASHBOARD_PASSWORD` | Acceso owner por Basic Auth, sin identidad | `auth/guard.ts:9` | — | **sigue activa** (`ESTADO-PRODUCCION.md:114`) | Un solo secreto compartido = acceso total sin auditoría nominal |
| `META_WHATSAPP_MEDIA_DOWNLOAD_ENABLED` | Descarga media de clientes a disco | `meta-media.ts:8` | **`1`** | no documentado | Viene encendido: ficheros de clientes en `data/media` sin que nadie lo pidiera |

Anomalías del propio esquema: `DASHBOARD_PASSWORD`, `PORT` y `META_AD_LIBRARY_ACCESS_TOKEN` están **duplicadas** en `.env.example` (gana la última); `BEEPING_ACCOUNT_EMAIL` y `BEEPING_ACCOUNT_PASSWORD` (credenciales en claro leídas en `suppliers/beeping.ts:30-31`) **no están ni en el esquema ni en `.env.example`**; `META_WHATSAPP_BUSINESS_ACCOUNT_ID` está marcada requerida y nadie la lee; `CASAMABLE_BUILD_SHA`, la que alimenta la identidad del build, tampoco está declarada.

---

## 2 · Deuda técnica y contradicciones acumuladas

### 2.1 Tres sistemas para lo mismo

| Sistema | Dónde | Persistencia | Estado |
|---|---|---|---|
| Product Intelligence Engine | `feat/hunter-end-to-end-v1` (worktree anidado en `…/agente-ecommerce-main/`), `src/lib/product-intelligence/` 20 ficheros / 1.161 líneas, `/api/product-intelligence`, panel `ProductIntelligencePanel.tsx` | JSON en fichero con lock | Archivado sin mergear (`CONTEXTO-2026-09-06.md:30`). **Copia parcial (15 ficheros, 681 líneas) en el checkout principal `agente-ecommerce-main` en la rama `pedro-actualizacion-5-sep`**, que no es la canónica |
| Hunter predictivo | canónica, `src/lib/hunter/predictive/` 409 líneas, tabla `hunter_predictive_estimates` (esquema 20) | SQLite | Nadie lo llama salvo su CLI; el propio predictivo existe en las dos ramas con implementaciones distintas |
| Cazador interno + discovery + auditor | `feat/product-hunter-backend`, `src/lib/product-hunter/internal/` 1.338 líneas + `hunter/discovery` + `hunter/audit` | SQLite, esquema 31 | Construido, no desplegado |

Además `src/lib/landing/` (generador minificado, CLI) y `src/lib/landing-studio/` (blueprint en `localStorage`) son dos pipelines de landing distintos. `docs/HUNTER-VS-PI-ENGINE.md` ya proponía «una sola entrada Productos» el 05-09; el resultado fue un tercer sistema.

### 2.2 Migraciones

- Secuencia declarada 1→31 (`db.ts:1726-1754`, `SCHEMA_VERSION = 31` en `:2143`). **Los números 1, 2 y 3 no existen** como funciones: es código inline en `build()` (`:1603-1724`). **El número 11 está repetido**: `migrateActionResolutions` (`:232`) y `migrateNotifyDelaySends` (`:559`) declaran ambas «SCHEMA_VERSION 11», y el orden de llamada es 11, 10, 11 (`:1732-1734`).
- Cinco migraciones dependen del orden (ALTER sobre tablas creadas por otra); todas satisfechas hoy, **ninguna comprobada por código**. Renumerar o reordenar no rompe ningún test.
- La guarda simétrica `assertSchemaNotNewer` (`db.ts:2163-2169`, llamada en `:1366`) sí protege contra abrir una base más nueva. **El rollback a imagen `pre-v4.3` (esquema 15) no la lleva** (`ROLLBACK-v4.3.md:90`).
- `db.ts:1942`: `notified_via TEXT NOT NULL DEFAULT pending` sin comillas. SQLite lo acepta como literal (verificado en memoria: inserta `"pending"`), pero es la única de 40 columnas sin comillas.
- `scripts/test-migration-v43.ts` sigue etiquetado «F8 migración v17→v19» en `doctor-v43.ts:20` y «17→26» en `AUTO-DESPACHO-COOLDOWN.md:253`; su lista de tablas esperadas **no incluye las cuatro del esquema 31**.

### 2.3 Scripts de package.json (72)

Ningún script apunta a un fichero inexistente. Pero:

| Familia | Miembros | Problema |
|---|---|---|
| Pre-despliegue | `deploy:precheck`, `predeploy:check`, `deploy:guard` | Tres nombres casi intercambiables; solo `predeploy:check` es el semáforo canónico |
| Readiness | `readiness`, `readiness:runtime` | Dos veredictos distintos con nombres iguales; `readiness.ts` no tiene `main()` |
| Doctores | 12 (`doctor`, `doctor:v43`, `env:doctor`, `local:doctor`, `db:health`, 6 por integración, `dropi:diagnose`) | `doctor` diagnostica el kit genérico («Mac de Óliver»), no Casamable |
| Hunter | 9 subcomandos sin CLI unificada | `hunter:search` y `hunter:discovery` operan los dos contra la Ad Library |
| Sin script npm | `start-outbox.ts` (nadie lo invoca, solo docs de archivo), `test-migration-v43.ts` (solo desde `doctor-v43`) | |

### 2.4 Convención de scripts

El bug de `hunter-add.ts` (top-level await, NAS 08-09) no era un caso aislado. **16 de 67 scripts** no siguen `async function main()` + `main().catch()`: `check-system.ts`, `doctor.ts`, `env-init.ts` (copia ficheros en top-level), `hunter-score.ts` (abre SQLite en top-level), `landing-build.ts`, `landing-sections.ts`, `landing-lint.ts`, `landing-e2e.ts` (los cuatro minificados en una línea), `local-reset.ts` (**`fs.unlinkSync` en bucle top-level**), `outbox-clear-safe.ts`, `outbox-inspect.ts`, `readiness.ts`, `start-outbox.ts`, `validate-call-prompt.ts`, `redteam.mts` y `test-airtable.mts` (**top-level `await fetch` con un `DELETE` contra Airtable**). Solo los dos `.mts` sobreviven al top-level await porque son ESM.

`env-loader` no se importa (o no primero) en 7 scripts que leen `process.env`, incluido `dropi-webhook-simulate.ts` (importa en la línea 16 detrás de otros imports). 19 scripts hacen `process.exit()` con handles de SQLite abiertos; `retell-reconcile-call.ts` lo hace 10 veces con `await` a Retell por medio. El test añadido el 08-09 (compila cada script en CJS) impide el crash de arranque, no la inconsistencia.

### 2.5 Código muerto y exports sin uso

43 funciones exportadas de `src/lib` sin ningún consumidor. Las que importan: los cuatro `stop*` de schedulers (`stopOrderScheduler`, `stopTrackingScheduler`, `stopCloudOutboxLoop`, `stopDiscoveryWorker`) **nunca se llaman**: el apagado ordenado solo suelta leases; 9 funciones de `db.ts` muertas; `isCancelIntent`/`isExplicitCancelConfirmation` (una detección de cancelación que nadie usa); dos helpers de test exportados en producción (`_resetLogOnce`, `__setOwnerIdForTests`). Un solo `TODO` real en todo `src/` (en un fichero muerto). Advertencia: la suite valida bastante código leyendo el texto fuente, así que un `grep` puede infravalorar el uso.

### 2.6 Documentación

121 documentos, 21 huérfanos. Entre ellos las guías de uso de 13 comandos (`HUNTER-USO.md`, `HUNTER-PREDICTIVO.md`, `LANDING-STUDIO-USO.md`) y `TRABAJADOR-RUNBOOK.md`, el runbook del rol `agent`. Cifras distintas para «el esquema en producción» en documentos vigentes: 15 (`PREDESPLIEGUE.md:52`, `ROLLBACK-v4.3.md:90`), 18 (`NAS-PRODUCTION.md:85,117`, `PEDRO-WORKSPACE-05-09.md`), 24 (`ESTADO-PRODUCCION.md:78`), 29 (`docs/README.md:33`, que contradice a su línea 34), 30 (correcto para producción) y 31 (la rama). `CONTEXTO-2026-09-06.md:52` sigue diciendo «no sabemos qué commit corre» sin nota de superado. `LANDING-STUDIO.md` dice «sin desplegar» y está desplegado. `PRODUCT-HUNTER-BACKEND-ESTADO.md:20` dice «token de Meta funcionando» el mismo día que `ESTADO-PRODUCCION.md:28` dice «caducado» (el segundo es el correcto: el token nunca se renovó; el doctor de Ad Library del 07-09 lo corrió con un token que no consta).

### 2.7 Ramas y checkout

59 ramas remotas, 18 sin fusionar en la canónica, 32 sin actividad desde agosto. El checkout principal `agente-ecommerce-main` está en `pedro-actualizacion-5-sep`, no en la canónica, y arrastra una copia del PI Engine. La rama `feat/hunter-end-to-end-v1` tiene el repo anidado en un subdirectorio y un `merge-base` que no se pudo explicar (posible reescritura de historia). El super-repo `Ecomerce` registra los worktrees como gitlinks.

---

## 3 · Seguridad y superficie de riesgo real

### 3.1 Dinero y datos de clientes

| Paso | Gate | Fail-closed | Rastro | Hallazgo |
|---|---|---|---|---|
| Envío WhatsApp | `canSendRealWhatsApp` (4 llaves) + `guardRealClient` | Sí | `logBlockedSend`, outbox revalida | Correcto |
| Tag Shopify | `canWriteToShopify` (3 llaves), `admin.ts:118` | Sí | `logOnce` + `recordServiceCheck` | Correcto; es la única escritura en Shopify que existe (no hay cancelación saliente) |
| Creación en Dropea | `canCreateDropeaOrder` (8 llaves incl. `emergencyStop`) | Sí | eventos + idempotency key | Correcto |
| Liberación manual Beeping | `evaluateLocalReleaseGate` (`beeping/release.ts:116-121`) | Sí | claim atómico | Correcto |
| **mark-to-send Beeping** | `suppliers/beeping.ts:22-63`: **solo** `BEEPING_INTEGRATION_ENABLED` | **No consulta `safety.ts`** | eventos | **ALTO.** Alcanzable desde `confirmation.ts:312`, `auto-dispatch.ts:140` y `orders/[orderId]/action/route.ts:122` (`resolve_address_alert`, que además salta la allowlist a propósito y acto seguido dispara la escritura externa). Con `EMERGENCY_STOP=1` WhatsApp y Shopify paran; el almacén no |
| Corrección de dirección | texto libre, `slice(600/1000)`, solo en `needs_correction` | Sí | audit_log | Nunca llega a un proveedor sin pasar a campos estructurados (`suppliers/address.ts:113-134`). Correcto |
| Auto-cancelación IA | umbral 0,85, solo local, transacción, `critical` | Sí | `ai_cancellations`, work item, HUMAN | Correcto y reversible. Inyección de instrucciones acotada: el cliente solo puede cancelar **su** pedido |

`audit()` de `workspace.ts:6-11` **no pasa por `sanitizeForEvents`**: direcciones y textos del cliente entran en claro en `audit_log`, y `workspace/action/route.ts:23` guarda `{value}` sin recortar. Asimetría con `logIntegrationEvent`, que sí sanea.

### 3.2 Token de Meta en `ad_snapshot_url` (ALTO en cuanto se renueve el token)

Meta incluye `access_token=…` en la query de `ad_snapshot_url`. `discovery/client.ts:27` lo guarda tal cual (2.048 caracteres); `repository.ts` lo persiste en `adlib_candidate_snapshots.ads_json`; los resultados de la cola (`discovery_jobs.result_json`), el auditor (`snapshotUrls`) y el cruce (`hunter_cruces.breakdown_json.snapshotUrl`) lo llevan; `CompetitionSearch.tsx:188`, `StoreAuditView.tsx:93` y `CandidateCard.tsx` lo pintan como enlace o `<img src>`; `hunter-cruce-dropea.ts --json` lo vuelca a fichero. `grep access_token` en `src/lib/hunter`, `src/lib/product-hunter` y los componentes: **cero** recortes. Hoy inocuo (token caducado, panel solo owner). El día que se instale el token largo de Usuario del Sistema, ese token estará en SQLite, en backups, en JSON exportados y en el HTML que recibe el navegador. Verificar con una respuesta real; si se confirma, recortar la query al normalizar.

### 3.3 Superficie pública

`src/proxy.ts:23`: `PUBLIC_PREFIXES = ["/api/webhooks/", "/api/health"]`; `LOGIN_PREFIXES = ["/login", "/api/auth/"]`; todo lo demás cae en `requireOwner` salvo siete patrones de staff. Justificación de cada ruta pública:

| Ruta | Protección | Test de rechazo |
|---|---|---|
| `POST /api/webhooks/shopify/orders-create` y `orders-events` | HMAC-SHA256 doble secreto, `timingSafeEqual`, sin secreto → 500 | Sí (`run-tests.ts:522`, `:5876`); parcial para `orders-events` |
| `POST/GET /api/webhooks/whatsapp` | `X-Hub-Signature-256` + verify token | Sí (`:10535`, `:10547`) |
| `POST /api/webhooks/dropea` | HMAC base64 con prefijo `sha256=`, 503 sin secreto | Sí (`:3653-3674`) |
| `POST /api/webhooks/dropi` | **Sin firma**; deshabilitado → 503 | Sí (`:3873`) |
| `POST /api/webhooks/retell/call-events` | Firma `v=,d=` con ventana de 5 min | Sí (`:8043`, `:8090`) |
| `GET /api/health`, `/api/health/live` | Ninguna, a propósito | Comportamiento |
| `/login`, `/api/auth/*` | El propio login (scrypt) | Proxy |

No existe `/api/webhooks/beeping` (Beeping es solo saliente). Ninguna ruta pública devuelve pedidos ni clientes. Lo que sí devuelve `/api/health*` sin autenticar: `shopifyWebhookBadSignature24h` (telemetría de rechazos), `build.sha`, `schemaVersion` y, en `health/live/route.ts:81`, `err.message` crudo de la base.

Rutas de escritura **sin guardia en el handler** (dependen solo del proxy): `action-center`, `ads` (dispara llamadas a Meta), `beeping`, `cod-calculator`, `finance`, `integrations`, `product-hunter` y `messages/[id]/image` (escribe a disco y **encola un WhatsApp**). Ninguna la alcanza un `agent` hoy (test `:15916-15921`), pero no hay defensa en profundidad si el matcher del proxy cambia.

Sin límite de tamaño de cuerpo en los cinco webhooks (`await req.text()` antes del HMAC): vector de agotamiento de memoria no autenticado, mitigable solo delante (Caddy/WireGuard, no verificable desde el repo). `/api/auth/login` sin rate limiting ni bloqueo por intentos. Sin CSRF explícito más allá de `sameSite: lax`. `basicOwner` (`guard.ts:16`) compara longitudes antes de `timingSafeEqual`.

### 3.4 Secretos

- Historial completo de git, 111 refs, 366 commits, patrones `shpat_ shpss_ sk-or-v1- sk-proj- EAA key_ AKIA ghp_`: **solo placeholders de tests** (`sk-proj-ABCDEFGH…`). Ningún `.env`, `messages.db` ni `auth/creds.json` fue commiteado nunca.
- `.env.example`: 168 claves, 54 vacías, 114 con valor; ninguna es un secreto. Identificadores no secretos con valor real: dominio de la tienda, número de WhatsApp Business (`34641308254`), número de Retell (`+34950835615` como fallback en `retell-doctor.ts:145`), IDs de WABA/Phone Number/App en docs, cuenta `act_1365655995103103`.
- Único dato personal fuera de placeholders: `pedro@casamable.es` + `34644313917` en el fixture de redacción `tests/run-tests.ts:4821`. El test funciona igual con datos ficticios.
- `.gitignore` cubre `.env`, `.env*.local`, `data/`, `auth/`, `backups/`; **no cubre `outputs/`** (donde escribe `landing:*`) ni `.env.production` / `.env.prod`.
- `npm audit` (prod y dev): 0 vulnerabilidades. Sin dependencias sin mantenimiento detectadas entre las 15 de producción.

### 3.5 Logs

`sanitizeForEvents` (`system/sanitize.ts`) aplicado en los cuatro puntos de entrada a `integration_events`/`service_health`; teléfonos enmascarados en todo el flujo; ningún token ni cabecera `Authorization` logueado; el webhook de Retell guarda solo el evento parseado. Excepciones: `audit()` (arriba), el aviso de cancelación IA copia el mensaje del cliente y el teléfono completo al WhatsApp de alerta (destino de confianza), y cuatro CLIs de operador imprimen teléfonos completos (`trace.ts:19`, `outbox-clear-safe.ts:17`, `supplier-simulate.ts:42`, `notify-delay-ultras.ts:88`).

---

## 4 · Calidad del Cazador de productos (lo más nuevo, con la misma vara)

Auditoría adversarial del cruce Dropea × Ad Library y del backend interno. Ordenado por efecto en una decisión de compra.

| # | Sev. | Hallazgo | Dónde | Caso concreto |
|---|---|---|---|---|
| C1 | **Crítico** | La validación (40 puntos) y el precio miden al **anunciante**, no al producto: `mergeGroupsByPage` funde todas las líneas de producto de la página antes de casar; `activeAds`, `oldestActiveAt`, variantes y el texto donde se busca el precio son de toda la página | `cruce.ts:348`, `store-audit.ts:159-172`, `cruce.ts:357-359`, `price-detect.ts:105-107` | Tienda con 1 anuncio de cortaúñas a 29,99 y 11 de una lupa «solo 12,99 €» desde marzo: el cortaúñas puntúa con la antigüedad de la lupa y el precio de la lupa. Invirtiendo los precios sale 100 para un producto que se vende a 9,99 |
| C2 | Alto | Match por subcadena sin límite de palabra: `text.includes(k)` anula el `\` ${k} \`` | `cruce.ts:121` | «Cama para gato» casa «si» al 100 % con «Cámara de vigilancia para tu gato» (`cama` ⊂ `camara`); `gel`⊂`angel`, `red`⊂`reductora`, `mas`⊂`masaje` |
| C3 | Alto | Como Meta ya exige todas las palabras (KEYWORD_UNORDERED), en producción la cobertura será ≈1 casi siempre: la «confianza del match» (20 puntos) es una constante, no una señal. «Set manicura eléctrico con cortaúñas» casa «si» con «Cortaúñas eléctrico» | `cruce.ts:96,124` | |
| C4 | Alto | Un producto cuya consulta a Meta falló (429, 5xx, timeout) se persiste como `match="no"`, score 0, y **se salta para siempre** (`crossedVariantIds`); `--repetir` tampoco lo recupera. El test del lote de 20 consagra el comportamiento | `cruce.ts:345-378,326`; `run-tests.ts` ensayo lote de 20 | Un 429 puntual deja a productos anunciados con 0 permanente |
| C5 | Alto | Coste = **variante arbitraria** del producto: `GROUP BY product_id` sin agregado toma una fila cualquiera (en la práctica la de `variant_id` mayor, no «la primera» que dice el comentario). Sin filtro de `stock` ni `status` | `dropea-catalog.ts:271-279` | Colchón 89 € vs «recambio de válvula» 3 €: margen 97 % con el coste de la válvula. Un producto retirado o sin stock puntúa igual |
| C6 | Alto | Precio de otra cosa dentro del mismo anuncio; los avisos (`sin IVA`, `desde`, `lote`) **no tocan el número** | `price-detect.ts:105-107`, `cruce.ts:192-196,369` | «Cortaúñas 29,99 €. Recambio solo 9,99 €» → 9,99 (marcado) → margen 21 % → 0. «3 unidades por 24,99 €» → 40 puntos con margen real del 5 % |
| C7 | Alto | `ad_snapshot_url` con token persistido y exportado (§3.2) | `cruce.ts:368`, `cruce-source.ts`, `--json` | |
| C8 | Alto | Sync de Dropea: 42 peticiones seguidas sin pausa, sin `Retry-After`, sin reanudar por página; el contrato dice 60/min y el 429 se lo puede comer **la confirmación de un pedido real** que comparte ventana | `dropea-catalog.ts:298-317`, `dropea/client.ts:128-131,184-191`, `DROPEA-API-CONTRACT.md:180-182` | Riesgo real: tumbar el despacho, no bloquear la cuenta |
| C9 | Alto | Un mismo producto de Dropea se convierte en 3+ candidatos (`dropea:5000`, `cruce:12`, `cruce:57`) con hechos separados: el peso que Pedro teclea en uno no llega a los otros; la vista Economics los lista todos | `adapter.ts:185-217`, `cruce.ts:266-269` | |
| C10 | Medio | Techo y sesgo: sin precio el máximo es 60; «dudoso» con precio (73) supera a «si» sin precio (60). El orden del panel premia a quien escribe precios en el copy (perfil liquidación) y castiga a las marcas | `cruce.ts:175-201` | «Masajeador cervical, solo 59,99 €» (1 palabra de 3) queda por encima de un anuncio real de almohadas sin precio |
| C11 | Medio | Momentum: delta 0 → «débil» sin que nada cambie; compara cruces que pueden haber casado con páginas distintas; `--repetir` toma los primeros N del catálogo entero, no «los ya cruzados» | `momentum.ts:339`, `cruce.ts:247-250,327` | |
| C12 | Medio | Si Dropea devuelve `products` (como documenta su contrato) en vez de `items`, o recorta `limit`, la copia queda «completa» y vacía en silencio | `dropea-catalog.ts:300,318-320` | Funciona hoy porque `dropea-mapping-inspect.ts` leyó `items` en abril; ningún test cubre el otro caso |
| C13 | Medio | Cuota compartida con Competencia (mismo token) y **nada impide** dos cruces a la vez ni cruce + búsqueda: la cola del discovery serializa solo sus jobs; el CLI del cruce no reclama ese lock | `hunter-cruce-dropea.ts`, `jobs.ts:170` | |
| C14 | Medio | `result_json` del pipeline se congela al guardar y nadie lo refresca; la huella de Ad Library (hash de todo el vocabulario) deja huérfano al candidato guardado en cuanto el competidor publica un anuncio nuevo | `adapter.ts:109-112,231-233`, `grouping.ts:241-245` | |
| C15 | Bajo | Términos enviados sin acentos ni ñ (`cortaunas electrico bano`); sensibilidad a diacríticos de la búsqueda de Meta **no verificada en vivo** | `cruce.ts:344`, `client.ts:56` | Si Meta distingue, falso negativo sistemático para nombres en español |

**Cobertura real vs aparente.** Los tests del bloque INTERNO (12) cubren el camino feliz con fixtures donde **el texto del anuncio es literalmente el término buscado** (`ad_creative_bodies = [term + ": oferta solo hoy 24,99 €"]`), una variante por producto, y valores esperados calculados a mano con la misma fórmula. No cubren: varias variantes por producto (C5), varios productos en la misma página (C1), subcadenas (C2), la cancelación a mitad de lote, `listSaved` con filtros, `setEconomics` solo con transporte, respuesta de Dropea sin `items`, `--repetir`, dos procesos concurrentes. La suite pasa; no demuestra lo que dice el título de varios tests.

**Veredicto**: hoy un score alto significa «el anunciante con más anuncios de cualquier producto que Meta devolvió para esas palabras tiene escrito un precio bajo en alguno de ellos, y una variante arbitraria de Dropea cuesta bastante menos que ese precio». No significa que ese anunciante venda ese producto, ni que el precio sea de ese producto, ni que la variante costeada sea la anunciada, ni que Dropea tenga stock. Correcciones mínimas antes de que Pedro decida nada con la tabla: (1) casar y detectar precio **solo** en los anuncios que contienen las palabras clave, no en toda la página; (2) límite de palabra en `bestMatch`; (3) coste por `MIN(cost_eur)` explícito o cruzar todas las variantes; (4) filtrar `stock > 0`; (5) no persistir como «no» los fallos de red y reintentarlos; (6) pausa y reanudación por página en el sync; (7) recortar `access_token` de `ad_snapshot_url` al normalizar.

---

## 5 · Negocio

### 5.1 Valor medible hoy vs construido

Los únicos datos de volumen que existen en el repo son los recuentos de filas del NAS el 07-09: 134 pedidos, 78 conversaciones, 447 mensajes, sin descomponer por origen. Con `TEST_MODE=1` y una allowlist cuyo último tamaño documentado es 2 (`CONTEXTO-2026-08-24.md:192`, `META-CONTINGENCY-NO-ROLLBACK.md:88`), y con `docs/REAL-PILOT-02-09.md` en `BLOCKED` con sus 23 casillas en `PENDING`, la lectura honesta es:

| Bloque | Estado | Valor medible hoy |
|---|---|---|
| Entrada de pedidos Shopify → base → panel | Producción | **Sí**: los 134 pedidos existen, se ven, se auditan |
| Confirmación automática por WhatsApp a clientes reales | Producción, `TEST_MODE=1` | **No acreditado**: solo allowlist + autorizaciones manuales, ninguna documentada |
| Cierre real (entregado/rechazado) vía webhook Dropea | Producción | Parcial: la tasa de entrega nunca consta por encima de la muestra mínima de 10 |
| Meta Ads read-only | Producción | Sí, lectura de insights; ROAS por campaña no fiable hasta 30 pedidos atribuidos (`REAL-PILOT:73-81`) |
| Workspace de agentes (v4.2/v4.3) | Producción | **Cero**: no consta ningún usuario `agent` creado; `DASHBOARD_PASSWORD` sigue siendo la puerta |
| Validación de direcciones capa 1 | Producción, activa | Abre alertas; sin dato de cuántas ni de su precisión |
| Llamadas Retell | Desplegado, manual-only, `RETELL_LIVE` FAIL | Cero automático |
| Beeping | Desplegado, sin credencial, `POST /api/order/` sin escribir | Cero |
| Capa 2 direcciones, intención IA, auto-cancelación, cooldown, aviso de despacho | Producción, flags a 0 | Cero (por diseño, hasta decisión) |
| Competencia / auditor de tiendas | Producción, token caducado desde el 02-09 | Cero |
| Hunter predictivo, Landing Studio, landing CLI | Producción / CLI | Sin ninguna decisión de producto documentada que salga de ellos |
| Cazador interno + cruce | No desplegado | Cero, y con los defectos del §4 |

Estimación con nombres: de ~41.000 líneas de `src/lib`, el camino que hoy genera valor observable (webhook Shopify, panel, cierre por Dropea, Meta Ads read-only) son unas 9.000. **Alrededor de un 20 % del sistema está generando valor medible; el 80 % restante está construido, desplegado y apagado, o construido y sin desplegar, o desplegado y sin credencial.** Y el 20 % útil sirve a una allowlist, no a la base de clientes.

### 5.2 Una cosa que dejar de construir y una que priorizar

**Dejar de construir: la línea de descubrimiento de productos** (Cazador interno, cruce Dropea × Ad Library, Hunter predictivo, PI Engine, dos pipelines de landing). Argumento de margen, no de gusto técnico: el cuello de botella de un negocio COD no es encontrar producto, es la **tasa de entrega** (el break-even calculado ronda el 63 % y ningún dato propio ha medido la real) y el coste de contacto por pedido. Un producto «ganador» descubierto con un score que hoy no distingue el producto del anunciante, sobre un catálogo del que no se conoce el stock, y vendido a través de un flujo de confirmación que no llega a clientes reales, no mueve ni una venta. Son tres sistemas (1.161 + 409 + 1.338 líneas) que compiten entre sí, ninguno con una decisión de compra documentada detrás. Congelar hasta que el núcleo convierta; si se quiere conservar uno, el interno, y con las siete correcciones del §4.

**Priorizar: encender el negocio y medirlo.** Tres pasos, por orden, todos de decisión y no de código: (1) `whatsapp_rollout_percent = 25` o ampliación de allowlist con el plan de `META-CONTINGENCY-NO-ROLLBACK.md:82-109`, que existe desde agosto y nadie ha ejecutado; (2) cerrar Dropea vs Beeping (`CONTEXTO-2026-09-06.md:70`): dos apps nativas conectadas a la misma tienda sin decidir quién procesa cada pedido es un riesgo de doble envío que además deja las constantes económicas del Hunter tomadas del proveedor apagado; (3) obtener 10 pedidos resueltos por ventana para que la tasa de entrega y el break-even dejen de ser hipótesis (0,629, 7,77 €, 9,37 € marcados «ESTIMACIÓN INTERNA» en `hunter/scoring.ts:5-26`). Impacto: es la diferencia entre un sistema que ahorra llamadas de confirmación en cada pedido real y uno que ahorra cero.

### 5.3 Riesgos operativos no técnicos

- **Dos personas en todo el corpus, sin suplencia.** Pedro despliega por SSH guiado, custodia el `.env` (600, root, horneado en la imagen) y es el contacto manual de emergencia «desde su móvil personal» (`META-CONTINGENCY-NO-ROLLBACK.md:44-46`). Óliver es arquitectura, escalado de cualquier fallo (`PEDRO-RUNBOOK.md:3-4`) y única autoridad para restaurar la base (`ROLLBACK.md:19`). «Confirmar si Óliver tiene acceso propio al NAS» lleva abierto desde el 06-09. El NAS es doméstico; toda intervención es nocturna por la ventana 10:00–21:00.
- **Sin runbook**: renovación del token de Ad Library (se pide en tres documentos, sin procedimiento ni recordatorio; ya caducó una vez por usar el token corto del Explorer), calendario de caducidades, rotación de `DASHBOARD_PASSWORD`, qué hacer si Meta suspende el número (el doc de contingencia avisa del riesgo y no da pasos), rotación del secreto de webhooks de Shopify. Beeping no permite rotar credencial por diseño (`BEEPING-API-CONTRACT.md:16`).
- **No verificable desde el repo**: si el `META_WHATSAPP_ACCESS_TOKEN` instalado es el permanente de Usuario del Sistema o uno de 24 h; cuántos números hay en la allowlist; el valor de la rampa; si hay usuarios `agent`.
- **Irreversibilidad ya asumida sin acta**: el alta en Cloud API «hay que tratarla como una decisión de un solo sentido» y exigía «aceptación explícita de Pedro ANTES del alta» (`META-CONTINGENCY-NO-ROLLBACK.md:12-14,40-41`); no consta, y el alta se hizo.
- **Decisiones pendientes acumuladas** (tabla completa en el informe de negocio; resumen): retirar `TEST_MODE` (abierta desde el 24-08), evidencia del piloto (02-09), `DASHBOARD_PASSWORD` (05-09), token Ad Library (06-09), 8 preguntas a Beeping (06-09), acceso de Óliver al NAS (06-09), Dropea vs Beeping (06-09), copia real de la base para el semáforo (nunca facilitada; se desplegó con fixture), `RETELL_AGENT_VERSION`, cadencia de `pending:review`, acuses que no escalen, momento del despliegue del Cazador. **Doce decisiones abiertas; ninguna es de código.** Además 18 constantes de negocio y 9 límites técnicos «sin fuente» (`NUMEROS-SIN-FUENTE-v4.3.md`), incluidas las franjas legales de llamada sin fuente legal enlazada.
- **Velocidad sin revisión**: 142 commits en la semana del 1 al 8 de septiembre, un autor, cuatro rondas de trabajo autónomo. El propio Pedro lo ha frenado con esta auditoría; conviene institucionalizarlo: revisión antes de merge, no después.

---

## 6 · Priorización final

| # | Hallazgo | Categoría | Impacto | Prioridad | Esfuerzo |
|---|---|---|---|---|---|
| 1 | El bot no llega a clientes reales: `TEST_MODE=1`, allowlist de 2, piloto `BLOCKED` desde el 02-09; todo lo construido cuelga de esto | Negocio | Cero ingresos atribuibles al sistema tras cinco semanas | **Crítica** | Decisión + 1 día (rampa 25 %, seguimiento con `pending:review`) |
| 2 | Dropea y Beeping conectados a la misma tienda sin decidir quién procesa; constantes económicas del proveedor apagado | Negocio | Doble envío potencial; scoring con costes de otro proveedor | **Crítica** | Decisión + 1 día de config |
| 3 | Score de Oportunidad Validada: agrupa por anunciante, subcadenas, variante arbitraria, fallos persistidos como «no» (C1–C6) | Calidad | Decisión de compra con datos de otro producto | **Crítica** (si se despliega el cruce) | 2–3 días + tests con fixtures adversariales |
| 4 | `ad_snapshot_url` con `access_token` persistido y renderizado | Seguridad | Token de Meta en SQLite, backups, JSON y navegador en cuanto se renueve | **Alta** (crítica al renovar el token) | 2 horas: recortar la query en `client.ts:27` + migración de limpieza |
| 5 | `markOrderToSend` (Beeping) ignora `EMERGENCY_STOP` y, en `resolve_address_alert`, la allowlist | Seguridad | La parada de emergencia no para el almacén | **Alta** | 1 hora + test |
| 6 | Tres sistemas de descubrimiento de producto + dos pipelines de landing; PI Engine copiado en el checkout principal | Deuda técnica | Mantenimiento triple, confusión de ramas, cero decisiones producidas | **Alta** | Decisión (congelar dos) + 1 día de limpieza |
| 7 | Dependencia de dos personas; sin acceso alternativo al NAS; sin runbooks de renovación de token, suspensión de WhatsApp, rotación de secretos | Negocio/ops | Un imprevisto de Pedro para el sistema | **Alta** | 1 día de runbooks + dar acceso |
| 8 | Sync de Dropea sin pausa ni `Retry-After`: puede consumir la ventana de 60/min que usan las confirmaciones reales | Calidad | 429 en un pedido real | **Alta** | 2 horas |
| 9 | `DASHBOARD_PASSWORD` sigue abriendo acceso owner sin identidad; login sin rate limiting | Seguridad | Acceso total con un secreto compartido, sin auditoría nominal | **Alta** | Decisión + 2 horas (retirar + limitar intentos) |
| 10 | Webhooks sin límite de cuerpo antes del HMAC | Seguridad | Agotamiento de memoria no autenticado | Media | 2 horas (límite por `Content-Length`) o confirmar que Caddy lo impone |
| 11 | ~14 rutas API sin guardia en el handler (una encola WhatsApp) | Seguridad | Sin defensa en profundidad si cambia el proxy | Media | 2 horas |
| 12 | Documentación: 7 cifras para el esquema, `CONTEXTO-06-09` sin superar, `LANDING-STUDIO.md` erróneo, 21 huérfanos incl. el runbook del agente | Deuda técnica | Decisiones tomadas sobre docs equivocados (ya pasó: «17, no 18») | Media | 1 día de poda: un solo `ESTADO-PRODUCCION.md` manda y los demás enlazan |
| 13 | 12 decisiones de negocio abiertas y 27 números sin fuente | Negocio | Sistema operando con hipótesis | Media | Una sesión de decisión de 2 horas |
| 14 | Stack Baileys + 8 módulos del kit desplegados sin ejecutarse; `adoption.ts` y 4 componentes muertos; 43 exports sin uso; `stop*` de schedulers nunca llamados | Deuda técnica | Superficie que se compila, testea y audita sin valor | Media | 1 día (borrar o mover a `legacy/` con test que impida importarlo) |
| 15 | Convención de scripts: 16 sin `main()`, top-level `await fetch` con `DELETE` en `test-airtable.mts`, `fs.unlinkSync` en top-level en `local-reset.ts`, 19 `process.exit` con handles abiertos | Deuda técnica | Repetición del incidente de `hunter-add` | Media | Medio día |
| 16 | Migración 11 duplicada, huecos 1–3, orden frágil sin verificación; fixture no comprueba las tablas de 31 | Deuda técnica | Un renumerado silencioso rompe producción | Media | 2 horas (tabla de versiones + test de unicidad) |
| 17 | `audit()` del workspace sin sanear ni recortar; teléfonos completos en 4 CLIs; `pedro@casamable.es`+móvil en un fixture | Seguridad | PII en `audit_log` y en salidas de consola | Baja | 1 hora |
| 18 | `.gitignore` sin `outputs/` ni `.env.production`; claves duplicadas en `.env.example`; 9 variables leídas y no declaradas (incl. credenciales de Beeping) | Deuda técnica | Filtración por descuido; doctor ciego a 79 variables | Baja | 1 hora |
| 19 | `/api/health*` expone `build.sha`, contador de HMAC malos y `err.message` de la base sin autenticar | Seguridad | Fingerprinting | Baja | 30 min |
| 20 | 59 ramas remotas, 18 sin fusionar, checkout principal fuera de la canónica, rama con repo anidado | Deuda técnica | Confusión de qué es la verdad | Baja | 1 hora de poda |
| 21 | Suite en un solo fichero de 17.249 líneas, con tests dependientes del estado global (dos fallos intermitentes arreglados el 08-09) | Calidad | Coste creciente de cada cambio | Baja | Incremental |

**Lo que no se pudo verificar** y condiciona varias filas: el `.env` real del NAS (valores de `EMERGENCY_STOP`, `SHOPIFY_WRITE_ENABLED`, allowlist, tipo de token de WhatsApp), la tabla `settings` (rampa, allowlist de llamadas), la existencia de usuarios `agent`, si Caddy limita el tamaño de cuerpo, la sensibilidad a diacríticos y el formato exacto de `ad_snapshot_url` de la Ad Library con un token vivo, y la composición de los 134 pedidos.
