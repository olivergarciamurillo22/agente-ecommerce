# Beeping Fulfilment — contrato de API (investigación, 23-08-2026)

Extraído de la documentación pública de Beeping (`help.gobeeping.com`, categoría *Configuring the API*). **No verificado contra la API real** — Casamable aún no tiene cuenta. Todo lo marcado con ⚠️ hay que confirmarlo con ellos antes de implementar.

---

## 1 · Datos base

| | |
|---|---|
| **Base URL** | `https://app.gobeeping.com/api/` |
| **Autenticación** | **HTTP Basic** — email y contraseña de la cuenta, en base64, cabecera `Authorization: Basic <base64>` |
| **Formato** | JSON |
| **Webhooks** | ⚠️ **No documentados.** Todo apunta a polling (ver § 5) |

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
