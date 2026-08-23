# Revisión del contrato de proveedores — `SupplierProvider` (23-08-2026)

Revisión de `src/lib/suppliers/types.ts` contra seis criterios de portabilidad, contrastada con las dos implementaciones reales (`dropea/`, `dropi/`), los webhooks, el router y el panel. **Solo análisis — ningún cambio de código.**

Contexto: decisión estratégica de congelar Dropi PRO y cerrar Dropea tal como está (adopción + reconciliación + webhooks, sin crear pedidos). Todo el esfuerzo pasa al contrato genérico de proveedor, con el objetivo de que implementar Lopi el día que toque cueste días, no semanas. `docs/BEEPING-API-CONTRACT.md` aporta un segundo proveedor real (síncrono, sin webhooks, con paso "liberar para envío") contra el que contrastar el diseño.

---

## 1 · Idempotencia propia — CUMPLE, con matiz

`evaluateOrderForSupplier` y `canSyncSupplier` (`src/lib/suppliers/service.ts:92`, `service.ts:258`) resuelven la idempotencia en local por `supplier_external_order_id` antes de mirar nada del proveedor. `claimSupplierCreate`/`claimSupplierConfirm` (`src/lib/db.ts:2054`) son genéricos (parametrizados por `platform`). Dropea además aprovecha su propia `Idempotency-Key` (`src/lib/suppliers/dropea/create-order.ts:45`) como defensa en profundidad, sin depender de ella — el precheck (`findDropeaOrderByExternalId`) usa `shopify_order_id` directamente.

**Matiz:** el nombre de las columnas (`supplier_create_phase: creating→created→confirming→confirmed`) ya asume el modelo de dos fases de Dropea. Beeping encaja razonablemente (`status=6` + `mark-to-send` ≈ `created` + `confirm`), pero un proveedor de una sola llamada tendría una fase "confirming" que nunca usa.

## 2 · Asincronía encapsulada — NO CUMPLE

`SupplierCreateResult` (`src/lib/suppliers/types.ts:109`) solo tiene `externalOrderId` + `simulated`: no existe ningún estado "pendiente". El patrón saga de Dropea (`operationId`, `DropeaOperationPendingError`, `create-order.ts:80`) vive enteramente en `CreateOrderOutcome`, un tipo **propio de Dropea**, no en el contrato genérico.

Y lo más importante: `dropeaProvider.createOrder()` — el método que sí pertenece a `SupplierProvider` — ni siquiera llama a esa máquina de estados: siempre lanza `ProviderNotConfiguredError` (`src/lib/suppliers/dropea/index.ts:141`). `createDropeaOrderForOrder`/`confirmDropeaOrder` no los invoca nadie todavía. La asincronía existe, pero fuera del contrato que se supone que la debe encapsular.

## 3 · Declaración de capacidades — NO EXISTE

`SupplierProvider` no tiene ni un campo de capacidades: nada de modo de actualización, `supportsCancel`, `supportsPickupPoint`, `supportsReleaseForShipping`. `cancelOrder()` está en la interfaz pero ambos proveedores la implementan lanzando error siempre (`dropea/index.ts:172`, `dropi/index.ts:70`) — no hay forma de que el llamador sepa de antemano que no está soportada sin capturar la excepción.

Con Beeping esto se vuelve urgente: es síncrono + polling + tiene `mark-to-send`, exactamente las tres capacidades que hoy no hay dónde declarar.

## 4 · Normalización previa al adaptador — CUMPLE

`SupplierOrderInput`/`SupplierAddress` (`src/lib/suppliers/types.ts:80,58`) son el DTO neutro. `service.ts` construye ese DTO (dirección resuelta vía `resolveFinalAddress`, líneas vía `buildItems`) **antes** de pasarlo a cualquier provider; `validateOrder()` es lo único específico de cada uno. Esto es sólido y reutilizable tal cual para Beeping.

## 5 · Envelope de eventos propio — PARCIAL

El dedupe (`claimWebhookEvent`, `src/lib/db.ts:2016`) sí es genérico, parametrizado por `platform`. Pero la verificación de firma + parseo + traducción a evento canónico **no pasa por ningún método del contrato** — `dropea/webhook.ts` (275 líneas) y `dropi/webhook.ts` (153 líneas) son módulos independientes, sin una función compartida, cada uno reimplementando su propio `findOrder`/dispatch/llamada a `processSupplierUpdate`.

Como Beeping no tiene webhooks, este envelope no le sirve de nada tal cual está: haría falta un "poller" con la misma forma, que hoy tampoco existe como abstracción.

## 6 · UI agnóstica — NO CUMPLE

`src/components/SystemPanel.tsx:685` y `:717` tienen `<Section title="Dropea">` y `<Section title="Dropi PRO">` cableados a mano, con campos específicos por nombre (`data.dropea.market`, `data.dropea.createMode`, `data.dropi.statusMapConfigured`...). Añadir Lopi hoy exige: nuevo `Section` en el JSX, nuevos campos en el tipo de respuesta de `/api/system`, y su propia lógica de agregación de salud. Es el criterio que peor queda.

---

## Resumen

1 y 4 ya están bien — construir el adaptador de Beeping sobre ellos sería barato. 2, 3, 5 y 6 son huecos reales, y no por descuido: son exactamente donde Dropea (síncrono-no, webhooks-sí) y Beeping (síncrono-sí, webhooks-no) más difieren.

## Pendiente

La **Tarea 3 (suite de conformidad)** queda deliberadamente pospuesta: diseñarla ahora, contra un solo proveedor real (Dropea), volvería a introducir el mismo sesgo que esta revisión acaba de destapar. Se retoma cuando exista la cuenta de Beeping y se pueda validar el contrato — y la propia suite — contra dos proveedores reales con formas opuestas (síncrono/asíncrono, webhook/polling), no uno.
