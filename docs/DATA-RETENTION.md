# Retención de datos y privacidad

> Política decidida el 25-08-2026 durante el hardening. Ejecutable con
> `npm run retention` (dry-run) / `-- --apply`.

## El principio

**Nunca se borra estado de negocio. Se reduce o se borra el acompañamiento.**

Un pedido, su eje de cierre, su histórico de estados y su enlace con el
proveedor son contabilidad: se guardan para siempre. Lo que no puede vivir
eternamente es el payload íntegro de Shopify con nombre, teléfono, email y
dirección de un cliente al que se le entregó hace ocho meses.

## Qué se retiene y cuánto

| Dato | Política | Variable | Por defecto |
|---|---|---|---|
| `orders.raw_payload` | **se reduce** (PII fuera, líneas dentro) | `RAW_PAYLOAD_RETENTION_DAYS` | 90 días |
| `messages` | se borran | `MESSAGES_RETENTION_DAYS` | 180 días |
| `supplier_webhook_events` | se borran | `WEBHOOK_EVENTS_RETENTION_DAYS` | 30 días |
| `scheduler_runs` | se borran (ya existía) | — | 7 días |
| `integration_events` | tope de filas (ya existía) | — | 5.000 |

**Nunca se tocan:** `orders` (la fila), `closure_*`, `order_status_history`,
`supplier_product_mapping`, `product_costs`, `daily_ad_spend`, `call_attempts`,
`call_dnc`.

## Por qué el payload se **reduce** y no se borra

Borrarlo entero dejaría a `lineItemsFromPayload()` sin nada y rompería el
costeo del histórico **en silencio**. En su lugar se sustituye por una versión
que conserva lo que el sistema relee y tira lo que es personal:

**Sobrevive:** `id` · `order_number` · fechas · `currency` · `total_price` ·
`financial_status` · `fulfillment_status` · `tags` · `line_items` (título,
cantidad, precio, SKU, IDs y los campos de fulfillment por línea).

**Desaparece:** `customer` · `shipping_address` · `billing_address` · `email` ·
`phone` · `note` · `note_attributes` (los formularios de Releasit llevan texto
libre del cliente) y **cualquier clave no listada**.

Es una **lista blanca**: si Shopify añade mañana un campo con datos personales,
no se cuela por omisión. Hay un test que lo comprueba.

El payload reducido lleva `_pii_removed: true`, así que se distingue del
original y el job no lo vuelve a procesar.

## Sobre qué pedidos actúa

Solo sobre pedidos con **cierre terminal** (`delivered` / `refused` /
`cancelled`) y más viejos que la retención. Un pedido todavía vivo conserva sus
datos de contacto: pueden hacer falta para una corrección de dirección o una
llamada.

## Garantías

- **Dry-run por defecto.** Escribir exige `--apply`.
- **Idempotente.** Correrlo dos o diez veces seguidas hace lo mismo que una: las
  condiciones son sobre el estado, no sobre un contador.
- **Cada parte falla por separado.** Si la reducción de payloads revienta, los
  mensajes y los webhooks se limpian igual, y el error se reporta.
- **Sin efectos externos.** No importa nada de WhatsApp ni de proveedores.

## Lo que NO cubre

- No hay job automático: se ejecuta a mano. Es deliberado por ahora — con
  decenas de pedidos al mes el crecimiento no aprieta, y un borrado automático
  sin haberlo visto funcionar una vez es un riesgo peor que el disco.
  **Pendiente de decidir** si se engancha a un scheduler con su lease.
- `auth/` (la sesión de Baileys) no entra aquí: lo gestiona el backup.
