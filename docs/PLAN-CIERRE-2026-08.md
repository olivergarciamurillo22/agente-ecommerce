# Plan de cierre — todo lo que queda (23-08-2026)

> **Estado a 23-08-2026 (tarde): FASE A EJECUTADA** en `feat/dropi-dropea`,
> sin desplegar. Ver § "Fase A · estado" al final. Ajuste de prioridad
> confirmado por Pedro: **Dropea sigue como integración externa
> supervisada** (`DROPEA_CREATE_MODE=external_app`: adoptar, reconciliar,
> webhooks, tracking, avisar); **la creación propia de pedidos se
> construye primero para Dropi PRO**, que es donde hoy no existe ninguna
> automatización (Pedro los mete a mano).

Respuesta al `ROADMAP-2026-08.md` de Pedro, contrastada con lo que YA existe en el código a fecha de hoy (commit `064391e`, 183 tests en verde). Cada bloque dice: qué hay, qué falta, qué archivos se tocan, cómo se valida y de quién depende.

Leyenda de dependencia: **[YO]** lo hace el desarrollo sin pedir nada · **[PEDRO]** necesita un dato, un trámite o una decisión de Pedro · **[EXTERNO]** depende de un tercero (Dropi, Meta, Beeping).

---

## 0 · Lo que el roadmap cree que falta y ya está hecho

| Roadmap dice | Realidad en el código |
|---|---|
| "Falta el modelo de estados canónico" (P1) | Existe: `TrackingStatus` en `src/lib/tracking/types.ts` con `unknown/created/processing/shipped/in_transit/out_for_delivery/delivered/incident/returned/cancelled`, terminales definidos y `processSupplierUpdate()` que compara antes/después y emite eventos. |
| "Fechas de cada transición" (P1) | Parcial: `orders` guarda `tracking_first_seen_at`, `tracking_last_checked_at`, `supplier_synced_at`, pero **no** un histórico por transición. Eso sí falta (ver 1.1). |
| "Construir avisos de tracking idempotentes, vía outbox, con safety gates" (P2) | Existe: `src/lib/tracking/notifications.ts` con claim atómico (`claimTrackingNotification`), outbox y gates. Avisos implementados: tracking disponible, sale a reparto, entregado (este apagado por `DELIVERED_WHATSAPP_ENABLED`). Incidencias y devoluciones → revisión humana, sin mensaje. |
| "Interfaz genérico de proveedores: createOrder/getStatus/getTracking/cancelOrder" (P6) | Existe: `SupplierProvider` en `src/lib/suppliers/types.ts` con exactamente ese contrato + `validateOrder`, `simulateCreateOrder`, `isConfigured`, `hasCredentials`. Dropi y Dropea lo implementan. |
| "Enrutado: todo sale unknown" (0.2) | Cierto, y ahora sí se puede resolver: `src/lib/suppliers/router.ts` tiene el hueco `reglasConfiguradas()` preparado. |

**Conclusión:** el trabajo real de la fase es más corto de lo que el brief sugiere. Lo grande es: enrutado real, histórico de transiciones + agregación, dos avisos nuevos (intento fallido, punto de recogida), las alertas de negocio en el Control Center, contabilidad v1, y la capa de abstracción de WhatsApp. El agente de llamadas y Beeping se diseñan ahora y se activan cuando haya proveedor/cuenta.

---

## FASE A — Sin capital ni decisiones pendientes (se aborda ya)

### A1 · Enrutado real Dropea / Dropi PRO  **[YO]** · pequeño

Regla conocida: línea con metafield `dropea.product_id` → Dropea; si ninguna línea lo tiene → Dropi PRO.

- `src/lib/shopify/` — el webhook `orders/create` no trae metafields de producto. Dos opciones, por orden de preferencia:
  1. **Tabla local `supplier_product_mapping`** (ya existe en `db.ts`): rellenar `product_id`/`sku` → `dropea` + `external_product_id`. Hoy solo el SKU `10428` → `a3f618c76fb450ce890e7189`. Sin llamadas a Shopify en el webhook.
  2. Más adelante, un job `npm run suppliers:sync-mapping` que lea los metafields `dropea.product_id` vía Admin API y refresque la tabla (requiere `read_products`, que el token ya debería tener).
- `src/lib/suppliers/router.ts` — `reglasConfiguradas()` pasa a consultar la tabla: alguna línea mapeada a Dropea → `dropea`; ninguna → `dropi`; pedido mixto (Dropea + no-Dropea) → `manual_review` con motivo explícito (Dropea rechaza las líneas no asociadas y no queremos partir pedidos sin que Pedro lo decida).
- Ignorar la línea `Seguro de Envío` (sin SKU) en la decisión.
- Mantener `SUPPLIER_ROUTING_RULES` por env como override de emergencia.
- Panel: mostrar en la ficha del pedido "→ Dropea (SKU 10428 mapeado)" / "→ Dropi PRO (sin asociación Dropea)".

**Validación:** tests nuevos en `tests/` con 4 pedidos (solo cortaúñas, solo ultrasónico, mixto, con seguro de envío). `npm test`, `typecheck`, `build`.
**No cambia:** `DROPEA_CREATE_MODE=external_app` sigue cerrado. El enrutado solo etiqueta y deja de generar ruido `routing → unknown`.

### A2 · Histórico de transiciones de entrega + agregación  **[YO]** · medio

Es la Prioridad 1 de Pedro y habilita A3, A4 y A5.

- `db.ts` — tabla nueva `order_status_history(id, order_id, kind ('order'|'tracking'), from_status, to_status, raw_status, source ('webhook'|'polling'|'manual'|'whatsapp'), supplier_platform, carrier, at)`. Migración aditiva (`CREATE TABLE IF NOT EXISTS`, mismo patrón que las tablas del Control Center).
- Escribir en ella desde **un solo sitio**: `processSupplierUpdate()` (tracking) y el punto de cambio de `orders.status` (confirmación/scheduler). Nada de inserts dispersos.
- `src/lib/system/delivery-metrics.ts` (nuevo) — agregación por día / producto / proveedor / transportista: enviados, entregados, rehusados, en curso, tasa de entrega (solo sobre pedidos con resultado terminal), tiempo medio enviado→entregado. Ventanas: 7 y 30 días móviles.
- `/api/system` — sección `delivery` con esas cifras; pestaña Sistema las pinta.

**Validación:** tests de agregación con histórico sintético (casos: pedido sin cierre no cuenta en el denominador; rehusado cuenta como no entregado; dos transiciones el mismo día no duplican).
**Dependencia de datos:** hoy solo Dropea manda webhooks (y falta `DROPEA_WEBHOOK_SECRET` en el NAS → pendiente [PEDRO], ver Fase C). Hasta entonces la tasa saldrá de polling y estará incompleta; la estructura es la misma.

### A3 · Avisos de tracking que faltan  **[YO]** · pequeño

Existen: tracking disponible, sale a reparto, entregado (off). Faltan, por impacto:

1. **Intento de entrega fallido** — evento nuevo `DELIVERY_ATTEMPT_FAILED` en `tracking/types.ts`, sello `attempt_failed_notification_sent_at`, mensaje "el repartidor no te encontró; volverá a pasar mañana, si no vas a estar respóndeme y lo cambiamos". Es el de mayor valor: recupera pedidos que hoy se pierden.
2. **Disponible en punto de recogida** — evento `AT_PICKUP_POINT`, solo cuando el proveedor lo reporte.
3. **Incidencia** → sigue sin mensaje automático, pero **crea la acción de llamada** (Fase D) en vez de quedarse en un log.

Transversal:
- **Anti-spam por pedido**: tope `TRACKING_MAX_NOTIFICATIONS_PER_ORDER` (def. 4) y ventana mínima `TRACKING_MIN_GAP_MINUTES` (def. 180). Se comprueba en `notifyTrackingEvent` antes del claim, contando sellos ya puestos.
- **Mapa estado-proveedor → estado canónico como tabla de configuración**, no código: `config/supplier-status-map.json` (`{ dropea: { "3": "in_transit", ... }, dropi: {} }`). `normalizer.ts` lo lee; estado no mapeado → `unknown` + `integration_event` tipo `unknown_status` (ya parcialmente así). El de Dropi queda vacío hasta que soporte lo confirme [EXTERNO].
- Respetar `insideSendWindow()` (ya lo hace el outbox).

**Validación:** tests de idempotencia (dos webhooks iguales → 1 mensaje), anti-spam (5º evento no envía), estado desconocido no envía y registra evento.

### A4 · Alertas de negocio en el Control Center  **[YO]** · pequeño (sobre A2)

Añadir a `src/lib/system/health-core.ts` / `overview.ts`, con umbrales por env:

| Alerta | Umbral | Nivel | Env |
|---|---|---|---|
| Tasa de entrega 7d | < 70 % | warning | `DELIVERY_RATE_WARN=70` |
| Tasa de entrega 7d | < 65 % | **critical** | `DELIVERY_RATE_CRIT=65` |
| `needs_call` sin atender | > 12 h | warning | `NEEDS_CALL_STALE_HOURS=12` |
| Confirmados sin despachar | > 6 h | warning | `DISPATCH_STALE_HOURS=6` |
| Avisos de tracking fallidos | > 5 / 24 h | warning | `TRACKING_FAIL_WARN=5` |
| Estado desconocido de proveedor | cualquiera | info | — |

La de tasa de entrega solo se evalúa con ≥ N pedidos cerrados en la ventana (`DELIVERY_RATE_MIN_SAMPLE=10`) para no disparar críticos con 3 pedidos. El watchdog (`ALERT_WHATSAPP`) reenvía las critical.

**Validación:** tests de umbral y de muestra mínima.

### A5 · Contabilidad diaria v1 en el panel  **[YO + PEDRO]** · medio

- Tablas nuevas: `product_costs(sku, product_cost, shipping_cost, updated_at)` y `daily_ad_spend(date, amount, source)`. Editables desde una pestaña "Costes" del panel (sin tocar código para cambiar un precio).
- `src/lib/system/accounting.ts` — por día: FACTURACIÓN, ENVIADOS, ENTREGADOS (real, de A2), GASTO ADS, ENVÍO, PRODUCTO, ENTREGA %, ROAS bruto, **ROAS neto** (sobre cobrado), PROFIT, %PROFIT, coste de retornos como línea propia. Fórmula de Pedro tal cual: `PROFIT = FACTURACIÓN × ENTREGA% − ENVÍO − PRODUCTO − ADS`.
- Vista "Contabilidad" con tabla diaria + totales del mes + desglose de tasa por transportista y producto.
- Gasto en ads: manual en v1. Meta Marketing API en v2 (requiere token de Pedro [PEDRO]).

**Necesito de Pedro:** coste de producto y de envío por SKU de los 5 productos activos (se meten desde el panel, no por chat).

### A6 · Consolidar el contrato de proveedores para Beeping  **[YO]** · pequeño

`SupplierProvider` ya es el contrato. Lo que falta para que el tercero encaje sin reescribir:
- `SupplierPlatform` añade `"beeping"` (sin implementación; `isConfigured()=false`).
- Cada provider expone `statusMap()` leído de `config/supplier-status-map.json` (A3) en vez de tenerlo en código.
- Documentar en `docs/HANDOFF-PROVEEDORES.md` qué tiene que devolver un provider nuevo y qué tests debe pasar (un test genérico de contrato que corra contra cada provider registrado).

---

## FASE B — Abstracción de WhatsApp y migración a Cloud API  **[YO + PEDRO + EXTERNO]**

### B1 · Capa de proveedor de WhatsApp  **[YO]** · medio — se puede hacer ya

- `src/lib/whatsapp.ts` ya es la puerta única de envío. Se introduce `WhatsAppProvider { send(phone, text|template), isReady(), onInbound(cb) }` con dos implementaciones: `providers/baileys.ts` (la actual, envuelta) y `providers/cloud-api.ts` (nueva, Graph API `v21+`, `messages` endpoint, webhooks de entrada con verificación `X-Hub-Signature-256`).
- Selección por `WHATSAPP_PROVIDER=baileys|cloud_api` (def. `baileys`). Rollback = cambiar la variable.
- El outbox no cambia; solo cambia quién entrega.
- Mensajes de confirmación y tracking pasan a tener **dos representaciones**: texto libre (Baileys / dentro de ventana 24 h) y plantilla con variables (Cloud API fuera de ventana). Se define en `orders/messages.ts` y `tracking/notifications.ts` con un `MessageSpec { text, template?: { name, params } }`.
- Respuestas 1/2/3 como **quick reply buttons** en Cloud API; el parser de `confirmation.ts` acepta tanto el texto como el `button_reply.id`.
- Safety gates idénticos: `canSendRealWhatsApp()` delante del provider, no detrás.

**Validación:** tests del provider Cloud API con HTTP simulado (envío de plantilla, rechazo fuera de ventana sin plantilla, firma de webhook inválida → 401, botón → intent).

### B2 · Trámites con Meta  **[PEDRO]** — arrancar ya, tienen cola propia

1. Verificación de Meta Business de Casamable.
2. Alta del número `+34 641 308 254` en WhatsApp Business Platform. **Antes**: revisar coexistencia (docs/11) para no perder historial de la app.
3. Dar de alta 6 plantillas categoría *utility*: confirmación de pedido, recordatorio, enviado+tracking, sale a reparto, intento fallido, incidencia. Yo redacto los textos respetando límites de Meta (sin saltos arbitrarios ni emojis en variables) y los dejo en `docs/WHATSAPP-TEMPLATES.md`.
4. Confirmar tarifa vigente de utility para España antes de dimensionar.

### B3 · Corte  **[YO + PEDRO]**
Semana en paralelo: Cloud API en `TEST_MODE` con allowlist (el móvil de Pedro), Baileys sigue en producción. Cuando las 6 plantillas estén aprobadas y los tests pasen, `WHATSAPP_PROVIDER=cloud_api` en el NAS; Baileys queda como rollback un mes.

---

## FASE C — Pendientes del smoke test que siguen abiertos  **[PEDRO / EXTERNO]**

| # | Pendiente | Quién | Estado |
|---|---|---|---|
| 1 | Localidad en Releasit | — | ✓ resuelto (roadmap 0.1) |
| 2 | ¿Dropi PRO crea pedidos solo? | — | ✓ respondido: la app está rota, nunca lo hizo |
| 3 | API REST de Dropi PRO (base URL, auth, mapa `status_id`) | EXTERNO (soporte Dropi) | abierto. Hasta entonces: `DROPIPRO_WEBHOOK_ENABLED=0`, mapa vacío, todo Dropi → "unknown" en tracking |
| 4 | Guardar `DROPEA_WEBHOOK_SECRET` en el `.env` del NAS | PEDRO | abierto. **Es lo que hace que A2 tenga datos reales.** Sin activar nada más |
| 5 | Desfase horario desde el móvil | PEDRO | abierto, menor |
| 6 | Calibrar umbrales (outbox 15 min, tracking 12 h, backup 24/48 h) | PEDRO+YO | tras 1-2 semanas de tráfico |
| 7 | **Riesgo**: desmarcar sync automática de Dropify PRO mientras esté rota (67 pedidos en cola → duplicados) | PEDRO | urgente, 1 minuto |

---

## FASE D — Agente de llamadas para `needs_call`  **[YO + PEDRO]** · grande

Hay 6 pedidos esperando una acción que no existe. Se hace en dos partes para no bloquear por proveedor de voz:

### D1 · Cola de llamadas y lógica de negocio  **[YO]** — se puede hacer ya, sin proveedor
- Tabla `call_tasks(id, order_id, priority (importe), attempts, max_attempts=3, next_attempt_at, last_outcome, cost_cents, transcript_ref)`.
- Scheduler: cada pedido que entra en `needs_call` o en `INCIDENT` crea una `call_task`. Reintentos en franjas distintas (`CALL_WINDOWS=10:00-14:00,16:00-20:00`), nunca dos intentos en la misma franja del mismo día.
- Desenlaces → mismas transiciones que WhatsApp: `confirmed`, `needs_correction`, `cancelled`, `no_answer` (reintento). Se reutiliza `confirmation.ts`, no se duplica.
- Interfaz `VoiceProvider { placeCall(task, script): Promise<CallOutcome> }` con implementación `manual` (el panel muestra la cola y Pedro marca el desenlace a mano). **Esto ya da valor sin gastar un euro**: hoy nadie ve esos 6 pedidos.
- Gates: `VOICE_AGENT_ENABLED=0` fail-closed + `TEST_MODE` + allowlist + `EMERGENCY_STOP`. Coste por llamada en `cost_cents` → entra en A5.

### D2 · Proveedor de voz real  **[PEDRO decide + YO]**
Opciones a evaluar con precio por minuto en España: Twilio Voice + ConversationRelay, Vapi, Retell, Bland. Criterios: número español, latencia, coste, grabación con aviso legal al inicio y opción "no me llamen" (obligatorio). Yo preparo la comparativa en 1 página; Pedro elige; se implementa `providers/<elegido>.ts` contra la interfaz de D1.

---

## FASE E — Beeping + inventario  **[esperar 3-4 semanas]**

No se construye hasta tener cuenta y API. Lo que queda listo gracias a A6: un provider nuevo es un archivo + un mapa de estados + pasar el test de contrato. Cuando toque: tablas `inventory(sku, available, committed, reorder_point)` y `inventory_movements`, reserva al confirmar, reingreso al rehusar, alerta "< 45 días de stock".

---

## Orden de ejecución propuesto

| Semana | Bloques | Entregable visible |
|---|---|---|
| 1 | A1, A2, A3 | Pedidos enrutados correctamente; histórico de transiciones; aviso de intento fallido; mapa de estados en config |
| 1 | C4, C7 (Pedro, 5 min) | Webhooks de Dropea fluyendo con firma; sin riesgo de cola duplicada de Dropi |
| 2 | A4, A6, D1 | Alertas de tasa de entrega en el Control Center; cola de llamadas visible en el panel con modo manual |
| 2 | B2 (Pedro arranca trámites Meta) | — |
| 3 | A5, B1 | Pestaña Contabilidad con datos reales; Cloud API implementada detrás del interruptor |
| 4+ | B3, D2 | Corte a Cloud API cuando Meta apruebe; proveedor de voz elegido |
| Más tarde | E | Beeping |

Cada bloque termina con `npm test`, `npm run typecheck`, `npm run build` en verde y una entrada en `docs/SYSTEM-CONTROL-CENTER.md` o `HANDOFF-PROVEEDORES.md` cuando cambie algo que Pedro opera.

## Lo que NO se toca (igual que el brief)
`DROPEA_CREATE_MODE=external_app` · `DROPIPRO_WEBHOOK_ENABLED=0` · `LEGACY_SUPPLIER_INTEGRATIONS_DISABLED=0` · defaults fail-closed · safety gates en toda ruta nueva (llamadas incluidas).

---

## Fase A · estado (23-08-2026)

| # | Bloque | Estado | Dónde |
|---|---|---|---|
| A1 | Routing real por `supplier_product_mapping` (variant > product > SKU); mixto → `mixed_supplier`; sin mapping → `unmapped_products`; sin líneas → revisión. Keywords retirados. | ✓ | `suppliers/router.ts`, `orders/line-items.ts` |
| A2 | `order_status_history` con dedupe por `event_id` / transición reciente; fuentes webhook·polling·manual·reconciliation; `occurred_at` del proveedor | ✓ | `db.ts`, `tracking/service.ts`, webhooks Dropea/Dropi, adopción, polling |
| A3 | Métricas: hoy/7d/30d, por producto/proveedor/transportista, fórmula `entregados/(entregados+devueltos)` | ✓ | `system/delivery-metrics.ts`, `docs/BUSINESS-METRICS.md` |
| A4 | Estados `delivery_attempted` (Dropea `DELIVERY_ATTEMPTED`) y `at_pickup_point` (sin proveedor que lo reporte aún); eventos `DELIVERY_ATTEMPT_FAILED` / `PICKUP_POINT_AVAILABLE`; avisos apagados por defecto → revisión humana; mensaje configurable; tope anti-spam por pedido | ✓ | `tracking/types.ts`, `notifications.ts`, `dropea/status-map.ts` |
| A5 | Alertas de negocio/operativa etiquetadas por categoría, umbrales por env | ✓ | `system/business-alerts.ts` |
| A6 | Unit economics sin inventar: `complete=false` + `missing[]`; costes por SKU y ads diarios manuales | ✓ | `system/unit-economics.ts`, `/api/system/costs`, `/api/system/ad-spend` |
| A7 | Pestaña **Negocio** en el Control Center (Operativa / Rendimiento / Economía + editor de costes) | ✓ | `components/SystemPanel.tsx`, `system/overview.ts` |
| A8 | Dropi PRO: gate propio fail-closed, creación idempotente preparada, borrador por mapping. Sin red hasta tener la API | ✓ (andamiaje) | `dropi/create-gate.ts`, `dropi/create-order.ts` |
| A9 | Dropea: `external_app` intacto; solo adopta, reconcilia, escucha webhooks, trackea y avisa | ✓ (sin cambios de modo) | — |
| A10 | Tests: 206 (183 + 23 nuevos) | ✓ | `tests/run-tests.ts` § 30 |
| A11 | Docs | ✓ | este archivo, `SYSTEM-CONTROL-CENTER.md`, `BUSINESS-METRICS.md`, `DROPI-API-CONTRACT.md` § 5 |
| A12 | Sin deploy, sin merge, sin tocar apps ni Releasit ni Meta | ✓ | — |

### Depende de Pedro (para que A2–A6 tengan datos reales)
1. Guardar `DROPEA_WEBHOOK_SECRET` en el `.env` del NAS (sin él no llegan transiciones firmadas).
2. Rellenar `supplier_product_mapping`: hoy en el NAS está vacía → **todo pedido sale a revisión humana** hasta que se den de alta el SKU `10428` → Dropea y los 4 SKUs restantes → Dropi. Se puede hacer desde `/api/suppliers/status` o con un script guiado (pendiente de que Pedro pase la lista SKU↔producto).
3. Costes por SKU y gasto en ads desde la pestaña Negocio.
4. Desmarcar la sincronización automática de Dropify PRO (riesgo de la cola de 67 pedidos).

### Depende de soporte de Dropi
- URL base, autenticación, endpoint y esquema de creación, identificador de producto (¿SKU?), catálogo `status_id → status_name`, firma del webhook. Con eso se implementan `client.ts`, `mapper.ts`, `status-map.ts` e `isConfigured()`; el resto ya está.

### Queda para la Fase B
- Abstracción `WHATSAPP_PROVIDER=baileys|cloud_api`, plantillas utility, quick replies; trámites Meta (Pedro).
- Cola de llamadas `needs_call` con modo manual (D1).
- Job que lea el metafield `dropea.product_id` de Shopify para refrescar el mapping automáticamente (hoy manual).

### Riesgos residuales
- **Mapping vacío en producción** = 100 % de pedidos a revisión manual (comportamiento seguro, pero ruidoso) hasta que Pedro lo rellene.
- La tasa de entrega solo es fiable con webhooks de Dropea activos y muestra ≥ 10 resueltos; Dropi no aporta datos hasta tener su mapa de estados.
- `notification_blocked` cuenta como "aviso fallido" también cuando lo bloquea `TEST_MODE` a propósito: en piloto la alerta puede saltar sin que haya fallo.
- `at_pickup_point` no lo reporta ningún proveedor: el aviso existe pero no se disparará hasta que un mapa de estados lo produzca.
- El desfase horario del panel (pendiente del smoke test) afecta a la ventana "hoy" de las métricas si el NAS no está en Europe/Madrid.
