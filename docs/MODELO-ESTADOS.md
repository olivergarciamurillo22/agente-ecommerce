# Modelo de estados — las cuatro máquinas

> Decisión de arquitectura de Óliver, 25-08-2026. Si el código contradice esto,
> gana el código: avísalo, porque significa que uno de los dos está mal.

Un pedido tiene **cuatro estados a la vez**, no uno. Son cuatro máquinas
independientes, con vocabularios que **no se traducen automáticamente** entre
sí. Mezclarlas es el error más caro que se puede cometer aquí: fue la causa de
que la tasa de entrega dijera "sin datos" mientras había entregas confirmadas
guardadas en otra columna.

| # | Eje | Columna | Pregunta que responde |
|---|---|---|---|
| 1 | `CustomerConfirmationStatus` | `orders.status` | ¿El cliente ha confirmado el pedido? |
| 2 | `SupplierSyncStatus` | `orders.supplier_sync_status` | ¿Está el pedido metido en el proveedor? |
| 3 | `TrackingStatus` | `orders.supplier_status_normalized` | ¿Dónde está el paquete? |
| 4 | `OrderClosureStatus` | `orders.closure_status` | **¿Cómo terminó económicamente?** |

**El eje 4 es la fuente de verdad del negocio.** Tasa de entrega, ingresos
entregados y coste de rehúse salen de ahí y solo de ahí.

---

## 1 · CustomerConfirmationStatus — `orders.status`

`pending_send` · `awaiting_reply` · `reminder_sent` · `awaiting_delivery_note` ·
`confirmed` · `needs_correction` · `needs_call` · `cancelled` · `ignored_old` · `error`

- **Fuente de verdad:** la conversación de WhatsApp y las acciones del panel.
- **Quién escribe:** el scheduler de confirmaciones, el handler de WhatsApp, el
  orquestador de llamadas, y Pedro desde el panel.
- **Terminal:** `confirmed`, `cancelled`, `ignored_old`. La automatización
  nunca los reactiva.
- **Protegido por un CHECK de SQL.** Añadir un valor es un cambio de esquema
  que se decide aparte, nunca colado dentro de otra tarea.
- `ignored_old` significa *historial, no actuar jamás*: no entra en ninguna
  cola y no recibe ningún WhatsApp (gate en `notifyTrackingEvent`).

## 2 · SupplierSyncStatus — `orders.supplier_sync_status`

`not_ready` · `blocked_address` · `manual_review` · `ready` · `simulated` ·
`syncing` · `synced` · `failed` · `cancelled`

- **Fuente de verdad:** nuestro propio proceso de enrutado y enlace.
- **Quién escribe:** el router de proveedores, la adopción, el enlace por tag
  (E4) y el reconciliador de Dropea (E8).
- **No dice nada del envío ni del desenlace.** `synced` solo significa "sabemos
  a qué pedido del proveedor corresponde este".

## 3 · TrackingStatus — `orders.supplier_status_normalized`

`unknown` · `created` · `processing` · `shipped` · `in_transit` ·
`out_for_delivery` · `delivery_attempted` · `at_pickup_point` · `delivered` ·
`incident` · `returned` · `cancelled`

- **Fuente de verdad:** el proveedor (hoy solo Dropea; Dropi no tiene mapa).
- **Quién escribe:** `processSupplierUpdate`, desde webhooks y polling.
- **Terminal:** `delivered`, `returned`, `cancelled` (no se vuelve a consultar).
- Un estado que no entendemos **no pisa** el anterior y **no dispara ningún
  WhatsApp**.
- **NO es la fuente de la tasa de entrega.** Aporta evidencia, no manda.

## 4 · OrderClosureStatus — `orders.closure_status` ← **el que manda**

| Valor | Significado |
|---|---|
| `unknown` | No tenemos evidencia suficiente. Es una respuesta legítima. |
| `in_progress` | Salió, pero sin desenlace todavía. |
| `delivered` | Entrega confirmada. |
| `refused` | El cliente rehúsa el COD. **Es el evento que cuesta ~9,37 €.** |
| `cancelled` | Cancelado antes del cierre normal. |

- **Quién escribe:** solo `setOrderClosure`, con una `closure_source`
  (`shopify` · `dropea` · `manual` · `llamada_ia`).
- **Terminal:** `delivered`, `refused`, `cancelled`. `canTransitionClosure`
  impide abandonarlos — **por eso escribir un terminal sin evidencia es
  irreversible y no se hace nunca**.
- `closure_at` es **siempre** la fecha del evento en la fuente, jamás `now()`.
- Cada transición deja fila en `order_status_history` con
  `status_axis = 'closure'`.

### Quién puede escribir qué

| Fuente | Puede escribir | No puede |
|---|---|---|
| Shopify (webhook, backfill, reconcile) | `cancelled`, `in_progress` | `delivered`, `refused` — **lo impide el tipo**, no una convención |
| Dropea (webhook en vivo + E8) | los cinco | — |
| Llamada IA | `cancelled` | el resto |
| Manual (panel) | los cinco | — |

*fulfilled* de Shopify significa **despachado**, nunca entregado. En COD la
entrega real y el rehúse solo los conoce el proveedor.

---

## La fórmula de la tasa de entrega

```
tasa de entrega = closure.delivered / (closure.delivered + closure.refused)
```

`unknown`, `in_progress` y `cancelled` **no entran ni en el numerador ni en el
denominador**. Un pedido cancelado no es una entrega fallida: nunca se intentó
entregar, y meterlo en el denominador hundiría la tasa por razones ajenas a la
logística.

Sin ningún pedido resuelto la tasa es **`null`**, no `0 %`. "No lo sé" y "todo
fue mal" son cosas distintas.

La ventana se mide por `closure_at` (fecha del evento en la fuente), para que
"entregados esta semana" signifique lo que dice.

---

## `refused` vs `returned` — la distinción que cuesta dinero

|  | `refused` | `returned` |
|---|---|---|
| Eje | 4 · cierre | 3 · logística |
| Significa | resultado de negocio: el cliente no aceptó el COD | hecho logístico: el paquete volvió al origen |

**Un pedido puede estar `tracking=returned` y `closure=refused` a la vez**, y es
lo normal cuando sabemos que fue rehúse. Lo que **no** se hace es traducir uno
por el otro automáticamente.

Por qué importa: en el vocabulario de Dropea, `REFUSED` (el cliente rechaza) y
`REFUSED_LOST_DAMAGED` (paquete perdido o roto) normalizan **los dos** a
`returned`. Contar el segundo como rehúse infla la métrica que decide si la
publicidad es rentable.

Por eso la traducción se hace desde los **sub-estados oficiales del proveedor**,
no desde nuestra normalización (`src/lib/orders/closure.ts`):

| Dropea `sub_status` | Cierre | Por qué |
|---|---|---|
| `DELIVERED`, `PAID` | `delivered` | En COD, cobrado es la mejor evidencia de entrega |
| `REFUSED` | `refused` | Es la palabra de Dropea para el rehúse del cliente |
| `REFUSED_LOST_DAMAGED` | **no cierra** + revisión humana | Volvió, pero no por decisión del cliente |
| `CANCELLED`, `REJECTED` | `cancelled` | |
| `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERY_ATTEMPTED` | `in_progress` | Está en manos del transportista |
| Incidencias (7 valores) | **no tocan el cierre** | Una incidencia no es un desenlace |
| Preparación (`CREATING`, `PICKING`…) | **no cierra** | Aún no ha salido: `in_progress` sería mentira |
| `FINISH` sin sub-estado | **no cierra** | Terminal, pero el *qué* lo dice el sub-estado |

**Dropi PRO no infiere ningún cierre** hasta tener su catálogo de estados real.
`planClosureFromTracking()` existe y devuelve siempre `null`: es el hueco
evidente donde enchufarlo el día que llegue la documentación, con su test.

---

## Reglas que no se rompen

1. **Sin evidencia, `unknown`.** No saber es una respuesta; inventar un
   terminal es irreversible.
2. **Sin fecha de la fuente, no se escribe.** Antes que estampar `now()` y
   corromper la cronología, no se escribe nada.
3. **Un eje no traduce a otro por parecido.** Solo por reglas escritas, con
   test, y desde el vocabulario oficial del proveedor.
4. **El histórico dice qué eje cambió** (`status_axis`). Un `delivered`
   logístico y un `delivered` de cierre no son la misma fila.

---

## Shopify fulfillment vs OrderClosureStatus

### Por qué el `partial` global no es fiable

Cada pedido de Casamable lleva una línea **`Seguro de Envío`** (la añade
Releasit). No es mercancía y **ningún proveedor la despacha nunca**. Shopify
calcula el `fulfillment_status` del PEDIDO mirando todas las líneas, así que
el pedido se queda en **`partial` para siempre**: el producto real salió hace
semanas y nunca llega a `fulfilled`.

Decidir con ese campo es decidir con un dato estructuralmente falso. Es la
causa probable del `in_progress = 0` medido el 24-08-2026 pese a haber envíos
con seguimiento real.

### Cómo se trata

Se mira **línea a línea**, contando solo mercancía
(`src/lib/orders/fulfillment.ts`). Señales para decidir si una línea es
mercancía, de más fiable a menos — **la primera que resuelve, manda**:

| # | Señal | Regla |
|---|---|---|
| 1 | `gift_card = true` | No es mercancía: virtual por definición |
| 2 | `requires_shipping` | **La buena.** Es EL campo con el que Shopify dice si algo se envía |
| 3 | `fulfillment_service = "gift_card"` | No es mercancía |
| 4 | `product_id` / `variant_id` / `sku` | Con identidad de catálogo → es producto. El `Seguro de Envío` no tiene ninguno |
| 5 | Título (**fallback documentado**) | Último recurso. Un título es texto libre que se puede cambiar en Shopify cualquier día: nunca gana a un campo de la API |

Sin ninguna señal, **falla cerrado**: no se cuenta como mercancía. Contar de
más dejaría el pedido "a medias" eternamente; contar de menos lo deja en
`no_physical_items`, que es visible y va a revisión en vez de mentir.

**Estados de mercancía:** `no_physical_items` · `not_started` · `partial` ·
`fulfilled` · `restocked` · `unknown`.

### Qué puede y qué NO puede inferir Shopify

| Puede aportar | Nunca puede |
|---|---|
| `in_progress` (salió mercancía: `fulfilled` o `partial` físico) | **`delivered`** |
| `cancelled` (`cancelled_at`, fiable, gana sobre todo) | **`refused`** |
| `unknown` (sin evidencia) | |

*fulfilled* significa **despachado**, no entregado. En COD la entrega real y
el rehúse solo los conoce el proveedor. Está impedido por el **tipo** de
`ClosureSignal`, no por una convención.

`restocked` no implica entregado ni rehusado: solo que la mercancía volvió al
almacén. El motivo lo dice otra fuente.

### ⚠️ `raw_payload` NO sirve para esto

`orders.raw_payload` se escribe **una sola vez, en el INSERT** del webhook
`orders/create`, y **nunca se refresca**. En ese instante ninguna línea está
despachada todavía. Alimentar el inferidor con él devolvería `not_started`
siempre, para todos los pedidos, para siempre — y parecería un dato, no un
error.

Fuentes válidas: el fetch a la Admin API del **backfill** y de la
**reconciliación**. Por eso `inferPhysicalFulfillment(payload, payloadIsFresh)`
exige declarar de dónde viene, sin valor por defecto.

### Calidad del dato: `basis`

Cada inferencia dice con qué se decidió, y el dry-run del backfill lo desglosa:

| `basis` | Significa |
|---|---|
| `line_level` | Se leyeron los campos de fulfillment de cada línea. Fiable |
| `global_fallback` | Sin datos por línea: se usó el estado global del pedido |
| `insufficient_data` | Ni línea ni global: no se afirma nada |

Con servicios presentes y sin datos por línea, un `partial` global da
`unknown`, no `partial`: el global no distingue el seguro.

### Routing ≠ fulfillment

`isPhysicalFulfillmentLine()` **no tiene nada que ver** con
`supplier_product_mapping`. Una línea puede ser perfectamente mercancía y no
tener todavía mapping de proveedor: son preguntas distintas y se responden por
separado.

---

## Auditoría del histórico (`order_status_history`)

Desde el esquema 6 cada fila lleva **`status_axis`**: `confirmation` ·
`supplier_sync` · `tracking` · `closure`.

Sin eso, un `delivered` del eje logístico y un `delivered` del eje de cierre
eran indistinguibles al leer la tabla. Las filas anteriores a la migración se
marcaron como `tracking` — no es una inferencia: hasta ese día
`processSupplierUpdate` era el **único** escritor de esa tabla.

`setOrderClosure` deja ahora su propia fila. El eje que manda en el dinero era
el único sin auditoría: se veía el valor actual pero no quién lo puso.

## Estados terminales: las dos barreras

| Eje | Terminales | Qué pasa si algo intenta salir |
|---|---|---|
| Cierre | `delivered` `refused` `cancelled` | `canTransitionClosure` lo impide. Repetir el mismo valor sí vale (refresca fuente y fecha) |
| Tracking | `delivered` `returned` `cancelled` | Se descarta y deja `terminal_regression_blocked` |

La barrera del eje logístico se añadió el 25-08-2026 al descubrir que **no
existía**: `returned`, `cancelled` e `incident` valían -1 en la tabla de orden,
así que quedaban fuera de la comparación de retrocesos. `returned → shipped`,
`cancelled → delivered` y `returned → delivered` pasaban sin problema. Un
webhook atrasado convertía una devolución en un envío vivo.
