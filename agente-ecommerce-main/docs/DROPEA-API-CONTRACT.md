# Contrato de la API de Dropea (verificado)

Todo lo de este documento sale del **spec OpenAPI oficial** de Dropea
(`https://public-api.dropea.com/dropshipper/openapi.json`, OpenAPI 3.0.3),
descargado y verificado campo a campo. Nada está inferido salvo donde se
indique.

---

## 1 · URL base: **una por mercado**

```text
https://es.public-api.dropea.com     ← España (el nuestro)
https://pt.public-api.dropea.com     ← Portugal (default del spec)
https://it.public-api.dropea.com     ← Italia
```

Los paths cuelgan de `/dropshipper/...`. La API es idéntica en los tres
mercados; solo cambia el host.

## 2 · Autenticación

```http
Authorization: Bearer <API_KEY_JWT>
```

Es un JWT de larga duración que se crea en el panel (*Settings → API Keys*) y
**se muestra una sola vez**. Se valida sin llamada al servidor (el token es
autocontenido). Cada endpoint exige permisos concretos (`dp:orders:create`,
`dp:orders:read`, `dp:products:read`, `dp:webhooks:write`…).

## 3 · Idempotencia: cabecera obligatoria

```http
Idempotency-Key: <^[A-Za-z0-9_-]{1,255}$>
```

**Obligatoria** en `POST /orders`, `/confirm` y `/cancel`. Retención de 24 h:

| Situación | Resultado |
|---|---|
| Misma clave + mismo cuerpo | Devuelve la respuesta cacheada con `Idempotent-Replay: true` |
| Misma clave + cuerpo distinto | **422** |
| Misma clave con la original en vuelo | **409** |
| La original falló con 5xx | No se cachea: se puede reintentar |

Usamos nuestro `shopify_order_id` como clave: dos intentos del mismo pedido
nunca crean dos pedidos en Dropea.

## 4 · Endpoints que usamos

| Método | Path | Para qué |
|---|---|---|
| POST | `/dropshipper/orders` | Crear pedido (queda en `PENDING`) |
| POST | `/dropshipper/orders/{id}/confirm` | **Confirmar** → llega al proveedor |
| GET | `/dropshipper/orders/{id}` | Consultar pedido (incluye tracking) |
| GET | `/dropshipper/orders` | Buscar pedidos (filtro `external_order_id`) |
| POST | `/dropshipper/orders/{id}/cancel` | Cancelar |
| GET | `/dropshipper/products` | Catálogo (de aquí salen los `variant_id`) |
| GET | `/dropshipper/shops` | Tiendas (de aquí sale el `store_id`) |
| GET | `/dropshipper/me` | Comprobación de credenciales |
| GET | `/dropshipper/catalogs/order-statuses` | Catálogo de estados |
| GET | `/dropshipper/webhooks` | Suscripciones de webhook |

> ⚠️ **No existe endpoint de tracking.** El número de seguimiento vive en el
> propio pedido (`tracking_number`, `tracking_url`, `carrier`).

> ⚠️ **Crear no es confirmar.** `POST /orders` deja el pedido en `PENDING`;
> hace falta `POST /orders/{id}/confirm` para que llegue al proveedor.

## 5 · Crear pedido: esquema exacto

```jsonc
{
  "store_id": 2,                    // OBLIGATORIO · entero (de GET /shops)
  "line_items": [                   // OBLIGATORIO · mínimo 1
    { "variant_id": 1,              //   OBLIGATORIO · entero (de GET /products)
      "quantity": 2,                //   OBLIGATORIO
      "unit_price": 19.99 }         //   OBLIGATORIO
  ],
  "customer_details": {             // OBLIGATORIO
    "name": "John Doe",             //   OBLIGATORIO
    "email": "john@example.com",    //   OBLIGATORIO
    "phone": "+34600000000",        //   OBLIGATORIO (número completo)
    "shipping_address": {           //   OBLIGATORIO
      "first_name": "John",         //     OBLIGATORIO
      "last_name": "Doe",           //     OBLIGATORIO
      "address_line_1": "Calle…",   //     OBLIGATORIO
      "address_line_2": "3º B",     //     opcional
      "city": "Madrid",             //     OBLIGATORIO
      "state": "Madrid",            //     OBLIGATORIO ← la PROVINCIA
      "postal_code": "28001",       //     OBLIGATORIO
      "country": "ES"               //     OBLIGATORIO · ISO-2
    }
  },
  "payment_method": "COD",          // OBLIGATORIO · enum
  "external_order_id": "1057"       // opcional · máx 128 · nuestra referencia
}
```

`payment_method` ∈ `COD | PAYPAL | STRIPE | SHOPIFY_PAYMENTS | PAID | MANUAL | OTHER`.

### Tres cosas que cambian nuestro diseño

1. **No hay campo de importe contra reembolso.** El COD se expresa con
   `payment_method: "COD"` y el importe **se deriva** de
   `Σ(unit_price × quantity)`. Por eso mandamos el precio real de cada línea.
2. **Hay un suelo de precio**: un pedido COD cuyo total quede por debajo del
   coste mayorista se rechaza con **422 `ORDER_TOTAL_BELOW_COST`**.
3. **⛔ No existe campo de nota de entrega ni observaciones.** Revisado en los
   52 esquemas: `Order.notes` es de solo lectura. **La nota que el cliente nos
   deja por WhatsApp (opción 3) no se puede enviar a Dropea por API.** Habrá
   que decidir qué hacer con ella (ver "Pendientes").

## 6 · Productos: por `variant_id`, no por SKU

El pedido se compone con `variant_id` (entero secuencial de Dropea). El SKU
aparece al leer, pero **no se acepta como entrada**: *"Product names and SKU
are derived by the server from variant_id — they cannot be set by the caller."*

Los `variant_id` salen de `GET /dropshipper/products` →
`products[].variants[].variant_id`. Cada variante trae `sku`, `name`,
`price` (lo que pagamos) y `recommended_sale_price` (PVPR).

## 7 · Estados

**`status`** (8): `DRAFT`, `PENDING`, `CONFIRMED`, `PROCESSING`, `SHIPPING`,
`DELIVERED` (legacy), `FINISH`, `ERROR`.

**`sub_status`** (22): `CREATING`, `PENDING`, `PENDING_SUPPLIER`, `PICKING`,
`PACKED`, `AWAITING_PICKUP`, `SHIPPED`, `OUT_FOR_DELIVERY`,
`DELIVERY_ATTEMPTED`, `DELIVERED`, `PAID`, `CANCELLED`, `REFUSED`,
`LOST_DAMAGED`, `REFUSED_LOST_DAMAGED`, `DELIVERY_EXCEPTION`, `REVIEW`,
`TECHNICAL_ERROR`, `REJECTED`, `INSUFFICIENT_STOCK`,
`CARRIER_VALIDATION_FAILED`, `WAREHOUSE_INTEGRATION_FAILED`.

Ciclo normal: `PENDING → CONFIRMED → PROCESSING.PICKING → PROCESSING.PACKED
→ SHIPPING → FINISH.DELIVERED`. El estado terminal canónico es `FINISH` con
su `sub_status`; el `DELIVERED` de primer nivel es histórico.

Nuestro mapeo está en `src/lib/suppliers/dropea/status-map.ts`, con el
`sub_status` mandando sobre el `status` (es más preciso).

## 8 · Tracking

Campos del propio pedido: `tracking_number` (nullable), `tracking_url`
(nullable), `carrier` (p. ej. `CTT`, `GLS`, `TIPSA`) y `service_type`.

## 9 · Webhooks

**Topics reales** (minúsculas con puntos, no mayúsculas):

```text
order.created   order.status.changed   order.cancelled
issue.created   issue.status.changed   issue.resolved
```

**Cabeceras de cada entrega:**

- `X-Dropea-Topic` — el topic
- `X-Dropea-Event-Id` — UUID por entrega (sirve para deduplicar)
- `X-Dropea-Signature` — **`sha256=<base64 de HMAC-SHA256(raw_body, signing_secret)>`**

Verificación en tiempo constante **sobre los bytes crudos del cuerpo**. El
`signing_secret` se muestra **una sola vez** al crear la API Key y **es
compartido por todas las suscripciones de esa key**.

**Cuerpo (envoltorio v2):** `topic`, `market`, `event_id`, `event_at`,
`resource_id`, `resource` (el pedido o la incidencia completos).

> El envoltorio **no** incluye el estado anterior: hay que guardar el último
> visto y comparar. Es justo lo que hace nuestro motor de tracking.

**Entrega:** hay que responder 2xx en **5 segundos**. Reintentos a 1m / 5m /
15m; **tras 3 fallos seguidos la suscripción se desactiva sola** y hay que
reactivarla desde el panel.

## 10 · Límites y errores

**60 peticiones por minuto**, ventana deslizante. Cabeceras
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Window`. Al
excederlo: **429** con `Retry-After: 60`.

Las mutaciones bloquean hasta **15 segundos**; si no terminan devuelven
**504** con un `operation_id` (que es la propia `Idempotency-Key`) para
consultar en `GET /dropshipper/operations/{operation_id}`.

Errores en un envoltorio común con `failure.type` → HTTP: `ValidationFailure`
400, `UnauthorizedFailure` 401, `ForbiddenFailure` 403, `NotFoundFailure` 404,
`ConflictFailure` 409, `BusinessFailure` 422, `RateLimitFailure` 429,
`ServerFailure`/`DatabaseFailure` 500, `NetworkFailure` 503.

Códigos de negocio documentados: `ORDER_TOTAL_BELOW_COST`,
`CARRIER_COUNTRY_NOT_COVERED`, `CREATOR_NOT_STORE_OWNER`,
`STORE_TYPE_NOT_SUPPORTED`.

---

## Pendientes antes de poder crear pedidos

1. **`store_id`**: sale de `GET /dropshipper/shops`. Se obtiene con
   `npm run dropea:doctor` en cuanto haya API key.
2. **`variant_id` de cada producto**: hay que emparejar nuestros productos con
   el catálogo de Dropea (`GET /dropshipper/products`). Se guarda en la tabla
   `supplier_product_map`.
3. **La nota del repartidor no cabe en su API.** Opciones: llamar a Pedro
   para que la comunique, o pedir a Dropea un campo para ello. Decisión
   pendiente.
4. **La integración antigua** que ya sincroniza Shopify con Dropea (tags
   `dropea_error`). Mientras siga viva, crear pedidos los duplicaría.
