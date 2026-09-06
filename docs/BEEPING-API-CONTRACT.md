# Beeping Fulfilment — contrato de API (investigación, 23-08-2026)

Extraído de la documentación pública de Beeping (`help.gobeeping.com`, categoría *Configuring the API*). **No verificado contra la API real** — Casamable aún no tiene cuenta. Todo lo marcado con ⚠️ hay que confirmarlo con ellos antes de implementar.

---

## 1 · Datos base

| | |
|---|---|
| **Base URL** | `https://app.gobeeping.com/api/` |
| **Autenticación** | **HTTP Basic** — email y contraseña de la cuenta, en base64, cabecera `Authorization: Basic <base64>` |
| **Formato** | JSON |
| **Webhooks** | ⚠️ **Existen en el panel pero NO están documentados.** Ver § 8 (06-09-2026); el polling de § 5 sigue siendo la vía fiable |

> ⚠️ **Riesgo de seguridad a plantear a Beeping.** La autenticación usa la contraseña de la cuenta, no una API key con permisos acotados. Implica que la contraseña de acceso al panel vive en el `.env`, sin posibilidad de rotarla ni limitar su alcance, y si se filtra da acceso total. **Preguntar si ofrecen API keys.** Si no, esa credencial debe tratarse con el mismo cuidado que un token de Shopify.

---

## 2 · Endpoints

| Operación | Método | Ruta |
|---|---|---|
| Listar tiendas | `GET` | `/api/get_shops` |
| Listar productos | `GET` | `/api/products?page=1` |
| Crear producto | `POST` | *(ver doc de Beeping)* |
| **Crear pedido** | `POST` | `/api/order/` |
| **Consultar pedido** | `GET` | `/api/order/{external_id}` |
| **Listar pedidos** | `GET` | `/api/get_orders` |
| **Marcar para envío** | `PUT` | `/api/order/mark-to-send/{external_id}` |
| Editar pedido | `PUT` | *(ver doc de Beeping)* |
| **Cancelar pedido** | `PUT` | `/api/order/cancel/{external_id}` |

**`external_id` es el ID del pedido en la tienda** (para Shopify, el número al final del enlace del pedido). Es la clave con la que Beeping identifica el pedido en todas las operaciones.

---

## 3 · Crear pedido — `POST /api/order/`

### Bloque `data`

**Obligatorios**

| Campo | Tipo | Notas |
|---|---|---|
| `ref` | String | Referencia interna del pedido |
| `name` | String | Nombre del pedido |
| `external_id` | Integer | **ID del pedido en la tienda** |
| `payment_method_id` | Integer | ⚠️ Falta saber cuál corresponde a contrareembolso |
| `status` | Integer | **1 = Pendiente · 6 = Pendiente de confirmar** |
| `amount` | Decimal | Total del pedido |
| `shop_id` | Integer | Se obtiene de `/api/get_shops` |

**Opcionales**

`total_discount`, `total_shipping`, `shipping_name`, `shipping_address_1`, `shipping_zip`, `shipping_city`, `shipping_province`, `shipping_country`, `shipping_country_code`, `shipping_phone`, `email`

### Bloque `lines[]`

`name`, `sga_product_id` (id interno de Beeping), `external_product_id`, `external_variant_id`, `amount` (precio unitario), `qty`, `sku`, `barcode`

> ⚠️ La documentación no aclara **cuál de los identificadores es el que usa para resolver el producto** (`sga_product_id`, `sku` o `barcode`). Hay que preguntarlo: determina cómo se rellena `supplier_product_mapping`.

---

## 4 · Catálogos de estado (documentados y completos)

### Estado del pedido (`status`)

| ID | Estado |
|---|---|
| 0 | Cancelado |
| 1 | Pendiente |
| 2 | Pendiente de stock |
| 3 | En preparación |
| 4 | Enviado |
| 5 | Devuelto |
| 6 | **Pendiente de confirmar** |

### Estado logístico (`tracking_stage`)

| ID | Estado |
|---|---|
| 1 | Sin estado |
| 2 | En tránsito |
| 3 | En reparto |
| 4 | **Punto de recogida** |
| 5 | Entregado |
| 6 | Devuelto al remitente |
| 7 | Cancelado |
| 8 | Dañado |

### Transportistas (`courier_id`)

| ID | Transportista |
|---|---|
| 1 | Correos Express |
| 3 | Correos |
| 5 | GLS |
| 9 | GLS-14 |
| 10 | GLS-19 |
| 11 | GLS-INTERNACIONAL |

---

## 5 · Consultar estado y tracking

**`GET /api/get_orders`** con filtros:

| Filtro | Uso |
|---|---|
| `in` | Lista de `external_id` separados por comas |
| `from_date` | `dd-mm-yyyy` |
| `shop_id` | Filtrar por tienda |
| `per_page` | Paginación |

**Campos de respuesta relevantes:** `external_id`, `ref`, `shop_id`, `status`, `payment_method`, `payment_method_id`, `amount`, `total_discount`, `total_shipping`, `total_tax`, `financial_status`, `date`, **`date_tracking_update`**, **`tracking_stage`**, **`tracking_number`**, **`courier_id`**, `lines[]`.

`date_tracking_update` + el filtro `from_date` permiten un **polling incremental eficiente**: pedir solo lo que ha cambiado desde la última consulta, en vez de recorrer todo.

---

## 6 · Implicaciones para el diseño del sistema

### 6.1 · El estado 6 encaja exactamente con el flujo de WhatsApp

Beeping distingue **"Pendiente de confirmar" (6)** de **"Pendiente" (1)**, y expone `mark-to-send` como acción separada. Eso permite implementar el flujo real de Casamable sin forzar nada:

```
Pedido COD en Shopify
   → crear en Beeping con status = 6 (pendiente de confirmar)
   → confirmación del cliente por WhatsApp
   → PUT /api/order/mark-to-send/{external_id}
```

**Ventaja operativa concreta:** el pedido no confirmado nunca llega a picking, así que no se incurre en el coste de 1,70 € de preparación ni en los ~9,37 € de un rehusado. El sistema de confirmación deja de ser solo un filtro y pasa a ser una puerta física en el almacén.

### 6.2 · Beeping es síncrono; Dropea es asíncrono

Dropea crea pedidos con patrón de saga (`operation_id`, polling ante 504). **Beeping no: la creación es una llamada directa.** Esto confirma que el contrato genérico **no debe modelarse sobre el patrón de Dropea**. El resultado de "crear pedido" debe poder ser *completado* o *pendiente con referencia opaca*, y el `operation_id` no debe salir nunca del adaptador de Dropea.

### 6.3 · Beeping no tiene webhooks; Dropea sí

Dos modos de actualización distintos:

- **Dropea** → push con firma HMAC-SHA256
- **Beeping** → polling incremental sobre `date_tracking_update`

El contrato debe soportar ambos, y cada adaptador **declarar cuál usa**. Es el caso de prueba perfecto para la declaración de capacidades.

> ⚠️ **Consecuencia de negocio:** sin webhooks, el aviso de "sale a reparto" — el de más impacto en la tasa de entrega — llega con el retraso del ciclo de polling. Merece la pena preguntar a Beeping si tienen webhooks no documentados, y si no, ajustar la frecuencia de polling en las franjas de reparto (mañana temprano).

### 6.4 · La idempotencia sale gratis

`external_id` es el ID del pedido de la tienda y es la clave en todas las operaciones. El `shopify_order_id` sirve directamente como clave de idempotencia, sin depender de cabeceras especiales. Encaja con el diseño ya acordado.

### 6.5 · `tracking_stage = 4` (punto de recogida) sí se reporta

Óliver anotó que el aviso `at_pickup_point` estaba implementado pero que "ningún proveedor lo reporta todavía". **Beeping sí.** Ese aviso pasará a ser útil el día que se migre.

---

## 7 · Preguntas para Beeping antes de implementar

1. ¿Ofrecéis **API keys** con permisos acotados, o la única opción es Basic Auth con el email y la contraseña de la cuenta?
2. ¿Qué `payment_method_id` corresponde a **contrareembolso**?
3. En `lines[]`, ¿qué identificador usáis para resolver el producto: `sga_product_id`, `sku` o `barcode`? ¿Es obligatorio dar de alta el producto antes de crear el pedido?
4. ¿Tenéis **webhooks** de cambio de estado o de tracking? Si no, ¿cada cuánto se recomienda hacer polling y hay límites de peticiones (rate limits)?
5. ¿Se puede **elegir transportista** por pedido, o se aplica el método de envío por defecto de la tienda?
6. ¿Hasta qué momento se puede **cancelar** un pedido?
7. ¿Se puede consultar el **stock disponible** por producto vía API?
8. ¿Reportáis el **cobro del contrareembolso** (importe cobrado, fecha) por API, para conciliación contable?

---

*Documento de investigación elaborado a partir de documentación pública. Ninguna llamada a la API de Beeping se ha realizado — Casamable no tiene cuenta todavía.*

---

## 8 · WEBHOOKS_DISCOVERED_2026-09-06

**Qué cambió.** La pregunta nº 4 de § 7 ("¿tenéis webhooks?") tiene respuesta
parcial: **sí los hay**. El panel de Beeping permite dar de alta un endpoint y
suscribir eventos. Esto contradice el § 6.3, que se redactó cuando la única
evidencia era la documentación.

### 8.1 · Lo que SÍ sabemos (evidencia: el panel, vista por Pedro)

Los eventos que ofrece la pantalla de alta son exactamente cuatro:

| Evento | Qué esperamos que signifique |
|---|---|
| `order.created` | pedido dado de alta en Beeping |
| `order.status_changed` | cambia el `status` del pedido (catálogo 0-6 de § 4) |
| `order.logistics_status_changed` | cambia el `tracking_stage` (catálogo 1-8) |
| `order.updated` | cualquier otra modificación del pedido |

### 8.2 · Lo que NO sabemos, y por qué importa

Su documentación de API **no describe webhooks en absoluto**. El índice
público (`https://apidocs.gobeeping.com/llms.txt`, consultado el 06-09-2026)
lista **46 endpoints REST y ninguno** de webhooks, eventos, notificaciones ni
callbacks. Por tanto siguen sin confirmar:

| Incógnita | Por qué bloquea |
|---|---|
| **Autenticación / firma** | Sin ella, el endpoint es público y **cualquiera podría inventar estados de envío**, cerrar pedidos como entregados y disparar WhatsApps de postventa |
| **Forma del envoltorio** | No se sabe si el pedido viene en la raíz o dentro de `data`/`order`/… |
| **Identificador de entrega** | Sin él no hay idempotencia por entrega (usamos huella determinista) |
| **Reintentos** | No se sabe cuántas veces ni con qué espaciado repiten una entrega |
| **Orden de llegada** | No hay garantía: se asume que NO llegan ordenados |

### 8.3 · Qué se ha implementado con eso

Receptor en `POST /api/webhooks/beeping`
(`src/lib/beeping/webhook.ts`), **fail-closed**:

- **Sin `BEEPING_WEBHOOK_AUTH_MODE` + `BEEPING_WEBHOOK_SECRET` declarados,
  responde `503 WEBHOOK_AUTH_NOT_CONFIGURED` y no produce ningún efecto.**
  Ese es el estado de hoy. No existe camino que procese sin verificar.
- Dos modos soportados, ambos declarados a mano (no se adivina ninguno):
  `token` (secreto compartido en una cabecera) y `hmac_sha256` (firma sobre
  los **bytes crudos**; se toleran hex y base64, con o sin prefijo `sha256=`).
- **Parseo defensivo**: evento, identificador de entrega y pedido se buscan
  entre varias claves plausibles. Lo que no se entiende se **descarta sin
  efectos** y queda registrado. Cada recepción deja en el feed la **forma**
  del envoltorio (nombres de claves, nunca su contenido) — que es justo lo
  que permitirá cerrar este contrato con entregas reales.
- **Idempotencia**: por identificador de entrega si lo hay, y si no por
  **huella determinista** del estado (`evento + external_id + status +
  tracking_stage + tracking_number + date_tracking_update`). La misma entrega
  diez veces produce **un solo** efecto de negocio.
  Un `id` pelado **nunca** se usa como identificador de entrega: si el
  envoltorio fuese el propio pedido, el primer evento deduplicaría a todos
  los demás y el pedido se congelaría en su primer estado.
- **Correlación**: por `external_id` contra `shopify_order_id` o el número de
  pedido, el mismo criterio del polling. **Jamás por nombre ni teléfono.**
- **Un solo camino de negocio**: los cuatro eventos convergen en
  `applyBeepingOrderLocally()`, la MISMA función que usa el polling. El
  nombre del evento no selecciona lógica — Beeping manda el estado del
  pedido y el mapper de § 4 es la única fuente de verdad. Por eso las dos
  vías no pueden divergir ni duplicar efectos, y las guardas (terminales del
  eje logístico y del de cierre, anti-retroceso por llegada atrasada, sellos
  anti-duplicado de WhatsApp) viven una sola vez.

### 8.4 · El polling NO se retira

Arquitectura acordada: **webhook = near-real-time, polling = reconciliación y
red de seguridad**. El polling corrige la deriva de las entregas que no
lleguen (endpoint cerrado, entrega perdida, pedido que aún no existía en
local cuando llegó su evento) y, al converger en la misma función, no duplica
efectos. No se retira hasta que haya semanas de entregas reales que
justifiquen lo contrario.

### 8.5 · Preguntas nuevas para Beeping

1. ¿Cómo autenticáis los webhooks? ¿Firmáis el cuerpo (¿qué algoritmo, qué
   codificación, en qué cabecera?) o basta un secreto compartido?
2. ¿Mandáis un **identificador único de entrega** (cabecera o campo) para
   poder deduplicar reintentos?
3. ¿Cuál es la **política de reintentos** y qué código de respuesta esperáis?
4. ¿Garantizáis el **orden** de entrega de los eventos? (asumimos que no)
5. ¿Cuál es la **forma exacta del cuerpo** de cada uno de los cuatro eventos?
6. ¿Hay una **entrega de prueba** desde el panel para validar sin pedidos reales?
