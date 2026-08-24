# CLAUDE.md — agente-ecommerce

Contexto permanente del repositorio para Claude Code. Léelo entero antes de tocar código.
Si algo de aquí contradice al código, **gana el código** — y avisa para corregir este archivo.

---

## 1. Qué es este proyecto

Agente de pedidos para **Casamable** (`casamable.es`, Shopify). El flujo real de negocio es:

1. El cliente compra **contrareembolso (COD)** mediante el formulario **Releasit COD**.
2. Shopify dispara el webhook de creación → el agente guarda el pedido en su **base local SQLite**.
3. El agente manda un **WhatsApp de confirmación** al cliente.
4. Si el cliente confirma, el pedido se enruta al proveedor dropshipping que corresponda.
5. Un panel web (`agente.casamable.es`) muestra el estado, con una pestaña **"Sistema"** (Control Center) de salud.

Se despliega en un **NAS propio** con `docker compose`. No es SaaS, no hay staging: producción es el NAS.

**Contexto de negocio útil para dimensionar decisiones:** volumen bajo (decenas de pedidos), ticket ~37 €, beneficio por pedido ~22 € antes de publicidad, y un pedido rehusado cuesta ~9,37 €. Perder o corromper el estado de un pedido tiene coste real e inmediato; optimizar por rendimiento casi nunca merece la pena aquí, optimizar por **corrección y trazabilidad** siempre sí.

---

## 2. Reglas de negocio que NO se deducen del código

Estas son decisiones tomadas por Pedro. No las cambies por iniciativa propia: pregunta.

### Routing de proveedores
- **Solo** el **Cortaúñas Eléctrico 3 en 1 (SKU 10428)** existe en el catálogo de **Dropea** y tiene el metafield `dropea.product_id`. Mapping: **SKU 10428 → `variant_id` 15896**, `store_id=18307`.
- **Todo lo demás va por Dropi PRO**, hoy **a mano**: la app "Dropify PRO" instalada en Shopify está rota (devuelve "Application Error" en sincronizar pedidos e importar productos).

### `createOrder` de Dropea: DESACTIVADO a propósito
La app oficial de Dropea para Shopify **ya crea los pedidos automáticamente**. Activar un `createOrder` propio **duplicaría pedidos**. La API key de Dropea está emitida con permisos mínimos y **sin `orders:create`** justamente por eso. No lo "arregles".

### `fulfilled` NUNCA significa `delivered`
En Shopify, *fulfilled* = despachado, no entregado ni cobrado. En COD, la entrega real y el rehúse solo los conoce el proveedor/transportista.

- `orders/fulfilled` → `closure_status = in_progress`
- `delivered` y `refused` → **solo** desde Dropea o marcado manual

Si Shopify escribiera `delivered`, el bloqueo de estados terminales impediría después que Dropea lo corrigiera a `refused`, y los rehusados desaparecerían del panel. Este error es silencioso y caro.

### El agente de llamadas no existe todavía
La tasa de respuesta al WhatsApp de confirmación es del **54 %**. El 46 % restante queda sin atender. No asumas que hay un canal de voz.

---

## 3. Modelo de datos: dos ejes independientes

`orders` tiene **dos ejes de estado que no se mezclan**:

**Eje operativo — `status`**
Máquina de estados del agente (confirmación por WhatsApp, colas, etc.), protegida por un **CHECK SQL**. Es código maduro y frágil: **no lo toques** salvo que la tarea sea explícitamente sobre él. Añadir un valor nuevo a `status` implica tocar ese CHECK y es un cambio de esquema que se decide aparte, nunca colado dentro de otra tarea.

**Eje de cierre — `closure_*`** (introducido en E1)

| Columna | Valores | Default |
|---|---|---|
| `closure_status` | `unknown` \| `in_progress` \| `delivered` \| `refused` \| `cancelled` | `'unknown'` |
| `closure_source` | `shopify` \| `dropea` \| `manual` | `NULL` |
| `closure_at` | timestamp unix (de la **fuente**, nunca `now()`) | `NULL` |

Reglas del eje de cierre:
- **Sin CHECK SQL** — la validación vive en TypeScript, igual que el resto de columnas de proveedor añadidas por `ALTER TABLE`.
- **`canTransitionClosure`**: `delivered`, `refused` y `cancelled` son **terminales**: no se abandonan hacia un valor distinto. Repetir el mismo valor **sí** está permitido y refresca `closure_source`/`closure_at`.
- `closure_at` siempre lleva la **fecha del evento en la fuente** (el ISO del payload), no la hora en que se procesó. Estampar `now()` corrompe las métricas de tiempo hasta cierre.

---

## 4. Convenciones de esquema y migraciones

- Versionado por **`SCHEMA_VERSION`** (`user_version` de SQLite). Cada migración sube un número.
- Toda migración debe ser **idempotente**: `ALTER TABLE ADD COLUMN` con **comprobación previa + try/catch**. Correrla dos o tres veces seguidas no puede fallar ni duplicar nada.
- **Extrae cada migración a su propia función parametrizada por conexión** (patrón: `migrateClosureAxis(db)`), **no inline en `build()`**. Así se puede testear contra cualquier DB sin pasar por el singleton. Esto no es opcional: es el patrón del repo.
- **Backfill neutro**: al añadir columnas, las filas existentes reciben el valor por defecto. **No infieras** estado histórico dentro de una migración; eso es trabajo de un script de backfill explícito y revisable.

---

## 5. Webhooks entrantes: las tres protecciones obligatorias

Cualquier endpoint que reciba webhooks **debe** implementar las tres, cada una con su test:

1. **HMAC obligatorio** — `X-Shopify-Hmac-Sha256`, comparación en tiempo constante. **401** si falla, **500** si falta el secreto en el entorno. Nunca un camino que acepte sin verificar.
2. **Idempotencia por identificador de entrega**, no por contenido — para Shopify, `X-Shopify-Webhook-Id`. Shopify reintenta, y `orders/updated` dispara varias veces por el mismo cambio. Debe existir un test con **el mismo webhook-id y payload distinto** que demuestre que el dedupe no depende del contenido.
3. **Protección contra llegadas fuera de orden** — los webhooks no llegan en orden cronológico. Compara el timestamp del payload (`cancelled_at`/`updated_at`) contra el `closure_at` guardado y **descarta el más antiguo**. Es una **capa distinta** del bloqueo de terminales y se testea por separado (un `fulfilled` más nuevo tampoco puede pisar un `cancelled` ya fijado).

**Endpoint actual:** `/api/webhooks/shopify/orders-events`, único, despachando por `X-Shopify-Topic`.

| Topic | Efecto |
|---|---|
| `orders/cancelled` | `closure_status = cancelled`, `source = shopify` |
| `orders/fulfilled` | `closure_status = in_progress`, `source = shopify` |
| `orders/updated` | **cero escritura en `orders`** — solo un `integration_event` informativo |

`orders/updated` es el webhook más ruidoso de Shopify (salta con cualquier cambio de tag, nota o dirección). Hoy no existe ningún campo de espejo que refrescar, así que **no escribe**. Cuando se defina un espejo, será con una **lista explícita y acordada de campos** — no "sincronizar lo que parezca".

---

## 6. Scripts que tocan datos reales

Aplica a backfills, migraciones de datos, reprocesos y cualquier cosa que recorra el histórico.

- **`--dry-run` por defecto.** Ejecutar de verdad exige un flag explícito.
- El dry-run imprime **desglose por transición** (`unknown→cancelled: 4`, `unknown→in_progress: 5`, `sin cambios: N` con motivo), **nunca** un contador plano. El objetivo es poder cuadrarlo a mano contra Shopify antes de ejecutar.
- **Nunca pisar lo que escribió un webhook**: un backfill solo toca filas `closure_status='unknown' AND closure_source IS NULL`. El evento en vivo siempre es más fiable que el histórico.
- **Salvaguarda de WhatsApp estructural, no por flag**: un script de datos **no importa nada de WhatsApp/Baileys**, ni transitivamente. Hay un test que lee el código fuente y falla si aparece uno de esos imports. Un `if (dryRun) return` se borra en un refactor; un import inexistente no. **Mantén ese test.**
- **Paginación con checkpoint** (en la tabla `settings`, sin crear tablas nuevas para esto) y **backoff ante 429**. Todo proceso largo debe ser **reanudable** sin repetir páginas ya hechas.
- Los pedidos que existen en Shopify pero no localmente se insertan con `status='ignored_old'` para que **no entren en ninguna cola** de llamadas ni confirmaciones. Reusa `normalizeOrder()` en lugar de mapear a mano.

---

## 7. API de Shopify: dos trampas conocidas

- **`read_all_orders`**: sin ese scope, la API devuelve **solo los pedidos de los últimos 60 días** y lo hace **en silencio, sin error**. Aplica igual a REST y a GraphQL. Cualquier recorrido del histórico debe verificar el scope antes de dar sus números por completos.
- **REST Admin API es legacy.** Se usa `orders.json` en el backfill porque su forma de respuesta coincide exactamente con `ShopifyOrderPayload` (cero mapeo), decisión consciente y **acotada a ese script**. Para código nuevo, **GraphQL por defecto**.

---

## 8. Comandos

```bash
npm test            # suite completa — debe quedar 100% en verde, sin excepciones
npm run typecheck   # limpio
npm run build       # compila
```

Un PR no se abre sin los tres en verde. Ningún test se marca como skip para desbloquear un merge.

---

## 9. Despliegue

- Producción = **NAS**, `git pull` + rebuild + `docker compose up -d`.
- **Evita la franja 10:00–21:00**: reiniciar corta WhatsApp.
- Tras desplegar, verificar: contenedor *healthy*, **WhatsApp reconecta sin pedir QR**, versión de esquema esperada, sin fuga de secretos en logs.
- Los secretos viven en el `.env` del NAS y los gestiona Pedro a mano. **Nunca** los pongas en el repo, en un test ni en un log.

---

## 10. Cómo trabajar aquí

- **Una tarea = una rama = un PR.** Si una tarea depende del **esquema** de otra pero no de su **código**, sácala como rama **hermana**, no encadenada: apilar tres ramas convierte un rebase en rehacerlo todo.
- **No amplíes el alcance por tu cuenta.** Si al implementar te falta una decisión (qué campos sincronizar, qué valor de estado usar), **pregunta antes de escribir código**. Inventar el alcance es el fallo más caro en este repo.
- **Cero efectos externos sin permiso explícito**: no despliegues, no suscribas webhooks reales, no llames a APIs de terceros, no mandes WhatsApp. Los tests no salen a la red.
- **Cada protección lleva su test dedicado**, y las capas se testean **por separado** (que un test pase por el motivo equivocado es peor que no tenerlo).
- Deja escritas en el PR las decisiones conscientes y sus límites ("uso REST aquí y solo aquí, porque…"), y **marca explícitamente lo que no has podido verificar**. Es más útil que un PR que aparenta certeza.

---

## 11. Estado actual (actualizar al mergear)

**En producción:** Fase A desplegada (commit `a2e4e83`, esquema **3**). Dropea conectada de punta a punta con 6 webhooks activos. Bug de la ciudad del formulario Releasit resuelto.

**Integrado en `main` (24-08-2026, esquema 5, 260 tests):** E1 + E2 + E3 +
fix de alertas + E5 (reconciliación cada 6 h) + elegibilidad central
(`src/lib/orders/eligibility.ts` — TODO consumidor pregunta ahí) + **E7**
(orquestador de llamadas Retell: `src/lib/calls/`, kill switch OFF y shadow
ON por defecto; ver `docs/RUNBOOK-LLAMADAS.md`). El backfill verifica el
scope `read_all_orders` y reporta `coverage`; `npm run shopify:webhooks`
audita/crea las suscripciones. `closure_source` admite `llamada_ia` (nunca
pisa terminales de Shopify/Dropea).

**Pendiente (solo despliegue, no código):** pasos de rollout en
`docs/ESTADO-PRODUCCION.md` § 9 — pull en el NAS, `--ensure` de webhooks,
backfill con verificación real de scopes, shadow de llamadas.

**Siguiente:** E4 (enlace Dropea vía tag `dropea_id:NNNNNNN`).

---

## 12. Por rellenar (Óliver)

Este archivo se escribió desde el contexto de negocio y de diseño, no leyendo el árbol del repo. Completa cuando puedas:

- Mapa de directorios y qué vive en cada sitio (más allá de `src/lib/db.ts`).
- Versión de la API de Shopify fijada y dónde se configura.
- Lista de las 6 suscripciones de webhook de Dropea y qué hace cada handler.
- Variables de entorno requeridas (solo nombres, nunca valores).
- Cómo se levanta el proyecto en local y con qué DB de prueba.
